import type { SourceType, NormalizedEvent, PlaybackState } from '../types.js'
import { BaseAdapter } from './base.js'
import { extractDubTeam } from '../utils/dub-team.js'
import { parseFilename } from '../utils/filename-parser.js'
import {
  containerFromFile,
  hdrFromFilename,
  hdrFromVideoProbe,
  resolutionFromDimensions,
  resolutionFromFilename,
} from './media-info.js'
import { dubTeamFromTrackTitle, languageToIso, normalizeAudioCodec } from '../utils/audio-track.js'
import { probeFileMedia, type FileMediaProbe } from '../utils/media-duration.js'

/**
 * MPC-HC / MPC-BE / MPC-QT HTTP source.
 *
 * MPC's "Web Interface" exposes a tiny HTML status page at
 * `http://localhost:{port}/variables.html` with one `<p id="…">value</p>`
 * per playback property. The protocol is part of MPC itself (see
 * `MainFrm::OnHtmlGetVar` in upstream mpc-hc); we only consume it.
 *
 * Default port is 13579 (the upstream default; MPC has fallbacks 13580-13582
 * if the user changed it — those are config and we honour them via
 * `config.url`).
 *
 * The adapter is opt-in: the user enables MPC's web server via the Stage 3
 * setup action (see `src/setup/actions/mpc.ts`), then enables the `mpc`
 * source in their config. We deliberately don't probe random ports.
 */

const DEFAULT_PORT = 13579
const FETCH_TIMEOUT_MS = 1500

/**
 * MPC's `state` field. MPC-HC uses 0=stopped, 1=paused, 2=playing. MPC-BE adds
 * -1 = "loaded but not started" (filter graph not built yet; statestring "n/a",
 * position/duration 0). Anything that isn't an explicit playing(2)/paused(1)
 * with a real duration is treated as "not actively playing" so we don't emit
 * a 0%/0-duration garbage event.
 */
const MPC_STATE_PAUSED = 1
const MPC_STATE_PLAYING = 2

interface MpcSnapshot {
  state: number
  positionMs: number
  durationMs: number
  /** Bare filename, e.g. "Inception.mkv". Empty when nothing is loaded. */
  file: string
  /** Full filesystem path, e.g. "C:\Movies\Inception.mkv". Empty pre-load. */
  filepath: string
  /** Player version, e.g. "1.8.9.0" (MPC-BE) / "2.3.5" (MPC-HC). Optional so tests stay terse. */
  version?: string
}

interface SessionRecord {
  /** Last action emitted for this sessionId. Used to suppress duplicate stops. */
  lastAction: 'progress' | 'stopped' | null
  /** Last raw MPC state, to track playing→stopped transitions specifically. */
  lastState: number | null
}

/**
 * Parse MPC's `variables.html` body into a flat key→value map.
 *
 * Exported so unit tests can exercise the regex without spinning up a fake
 * MPC server. The shape MPC emits is:
 *
 *   <html><head>…</head><body>
 *     <p id="file">Inception.mkv</p>
 *     <p id="position">3600000</p>
 *     …
 *   </body></html>
 *
 * Unknown/extra `<p id>` entries are kept so callers can read them too.
 */
export function parseMpcVariables(html: string): Record<string, string> {
  const out: Record<string, string> = {}
  // The greedy-stop `[^<]*` is fine: MPC never embeds `<` inside a variable
  // value — file paths and titles get HTML-escaped server-side. Single regex
  // pass keeps this allocation-light even on a hot poll loop.
  const re = /<p id="(\w+)">([^<]*)<\/p>/g
  let match: RegExpExecArray | null
  while ((match = re.exec(html)) !== null) {
    out[match[1]] = match[2]
  }
  return out
}

/**
 * Project the raw string map into the typed snapshot we feed into the rest
 * of the adapter. Tolerant of missing fields: any absent / unparseable
 * numeric field becomes 0, missing strings become ''. The downstream logic
 * treats `file === ''` as "nothing loaded".
 */
export function snapshotFromVariables(vars: Record<string, string>): MpcSnapshot {
  return {
    // Missing/unparseable state → 0 (treated as "not actively playing").
    state: toInt(vars.state, 0),
    positionMs: toInt(vars.position, 0),
    durationMs: toInt(vars.duration, 0),
    file: vars.file ?? '',
    filepath: vars.filepath ?? '',
    version: vars.version ?? '',
  }
}

/**
 * True only when MPC reports an explicit playing/paused state AND a real
 * duration. Filters MPC-BE's `state=-1` ("loaded, not started", duration 0)
 * and MPC's persistent `state=0` between sessions, so we never emit a
 * 0%/0-duration progress event. Pure — unit-testable.
 */
export function isActivelyPlaying(snapshot: MpcSnapshot): boolean {
  return (
    (snapshot.state === MPC_STATE_PLAYING || snapshot.state === MPC_STATE_PAUSED) &&
    snapshot.durationMs > 0
  )
}

function toInt(value: string | undefined, fallback: number): number {
  if (value == null || value === '') {
    return fallback
  }
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Build a NormalizedEvent for a single MPC snapshot. Pure function — no
 * fetch, no state — so unit tests can drive every code path.
 */
export function buildEvent(
  snapshot: MpcSnapshot,
  action: 'progress' | 'stopped',
  /**
   * Container probe of the file (ffprobe/mediainfo). MPC's web interface
   * reports neither stream info nor the SELECTED audio track, so the default
   * track + video stream from the container is the best available signal —
   * see `probeFileMedia` for the caveat.
   */
  probe: FileMediaProbe | null = null,
): NormalizedEvent | null {
  // MPC reports an empty file string when "Open File…" was never used. The
  // adapter shouldn't emit phantom events for that case.
  const pathOrName = snapshot.filepath || snapshot.file
  if (!pathOrName) {
    return null
  }

  const parsed = parseFilename(pathOrName)
  const state: PlaybackState = snapshot.state === MPC_STATE_PAUSED ? 'paused' : 'playing'

  return {
    type: parsed.type,
    sessionId: `mpc:${pathOrName}`,
    ids: {},
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
    episodeIds: {},
    episodeImdbId: null,
    episodeTmdbId: null,
    episodeTvdbId: null,
    title: parsed.title ?? snapshot.file,
    originalTitle: parsed.originalTitle,
    year: parsed.year,
    showTitle: parsed.type === 'episode' ? parsed.title : null,
    showOriginalTitle: null,
    season: parsed.season,
    episode: parsed.episode,
    userRating: null,
    contentRating: null,
    runtimeMinutes: snapshot.durationMs > 0 ? Math.round(snapshot.durationMs / 60_000) : null,
    duration: snapshot.durationMs || null,
    viewOffset: snapshot.positionMs || null,
    source: 'mpc',
    action,
    state,
    appVersion: snapshot.version || null,
    media: {
      // Actual container dimensions win over release-name tokens.
      resolution:
        resolutionFromDimensions(probe?.video?.width ?? 0, probe?.video?.height ?? 0) ??
        resolutionFromFilename(pathOrName),
      hdr: hdrFromVideoProbe(probe?.video) ?? hdrFromFilename(pathOrName),
      audioCodec: normalizeAudioCodec(probe?.audio?.codec),
      audioChannels: probe?.audio?.channels ?? null,
      audioLanguage: languageToIso(probe?.audio?.language),
      container: containerFromFile(pathOrName),
    },
    dubTeam: dubTeamFromTrackTitle(probe?.audio?.title) ?? extractDubTeam(pathOrName),
  }
}

/** Compute the variables.html URL from the configured URL (or the default). */
export function resolveEndpoint(rawUrl: string): string {
  let host = '127.0.0.1'
  let port = DEFAULT_PORT
  if (rawUrl) {
    try {
      // Allow either a bare `13579` / `:13579` shortcut or a full URL.
      const looksLikeUrl = /^\w+:\/\//.test(rawUrl)
      const parsed = new URL(looksLikeUrl ? rawUrl : `http://${rawUrl}`)
      if (parsed.hostname) {
        host = parsed.hostname
      }
      if (parsed.port) {
        port = Number.parseInt(parsed.port, 10) || DEFAULT_PORT
      }
    } catch {
      // Fall through to defaults — bad URL strings shouldn't crash boot.
    }
  }
  return `http://${host}:${port}/variables.html`
}

export class MpcHttpAdapter extends BaseAdapter {
  private readonly endpoint: string
  private readonly sessions = new Map<string, SessionRecord>()

  constructor(...args: ConstructorParameters<typeof BaseAdapter>) {
    super(...args)
    this.endpoint = resolveEndpoint(this.config.url)
  }

  get name(): SourceType {
    return 'mpc'
  }

  async checkConnection(): Promise<boolean> {
    try {
      const res = await fetch(this.endpoint, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!res.ok) {
        this.setConnectionError(`MPC HTTP responded ${res.status}`)
        return false
      }
      this.clearConnectionError()
      return true
    } catch (err) {
      this.setConnectionError((err as Error).message)
      return false
    }
  }

  protected override resetState(): void {
    this.sessions.clear()
  }

  protected async poll(): Promise<void> {
    if (!this.running) {
      return
    }

    let html: string
    try {
      const res = await fetch(this.endpoint, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!res.ok) {
        this.setConnectionError(`MPC HTTP responded ${res.status}`)
        return
      }
      html = await res.text()
      this.clearConnectionError()
    } catch (err) {
      this.setConnectionError((err as Error).message)
      return
    }

    const snapshot = snapshotFromVariables(parseMpcVariables(html))
    const pathOrName = snapshot.filepath || snapshot.file
    if (!pathOrName) {
      // Player open but no file loaded; nothing to emit, nothing to track.
      return
    }
    const sessionId = `mpc:${pathOrName}`
    const prev = this.sessions.get(sessionId) ?? { lastAction: null, lastState: null }

    // The container probe needs a real path on disk; `file` alone is just a
    // basename. Cached per-path inside the util, so only the first poll of a
    // playback pays the ffprobe cost.
    const probe = snapshot.filepath ? await probeFileMedia(snapshot.filepath) : null

    if (!isActivelyPlaying(snapshot)) {
      // Emit one final `stopped` on the transition out of active playback;
      // stay quiet otherwise (idle/stopped persists between sessions).
      const wasActive = prev.lastState === MPC_STATE_PLAYING || prev.lastState === MPC_STATE_PAUSED
      if (wasActive) {
        const event = buildEvent(snapshot, 'stopped', probe)
        if (event) {
          await this.emitScrobble(event)
        }
      }
      this.sessions.set(sessionId, {
        lastAction: wasActive ? 'stopped' : prev.lastAction,
        lastState: snapshot.state,
      })
      return
    }

    // playing(2) or paused(1) with a real duration → progress. The
    // PlaybackState differentiates them inside the event payload.
    const event = buildEvent(snapshot, 'progress', probe)
    if (event) {
      await this.emitScrobble(event)
    }
    this.sessions.set(sessionId, { lastAction: 'progress', lastState: snapshot.state })
  }
}
