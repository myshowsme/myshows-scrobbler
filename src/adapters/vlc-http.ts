import type { SourceType, NormalizedEvent, PlaybackState } from '../types.js'
import { BaseAdapter } from './base.js'
import { extractDubTeam } from '../utils/dub-team.js'
import { parseFilename } from '../utils/filename-parser.js'
import {
  containerFromFile,
  hdrFromFilename,
  hdrFromTransfer,
  resolutionFromDimensions,
  resolutionFromFilename,
} from './media-info.js'
import {
  channelsFromText,
  dubTeamFromTrackTitle,
  languageToIso,
  normalizeAudioCodec,
} from '../utils/audio-track.js'
import { readIni, getIniValue } from '../setup/helpers/ini-file.js'
import {
  resolveVlcrcPath,
  buildVlcAuthHeader,
  VLCRC_SECTION_LUA,
  VLCRC_KEY_PASSWORD,
} from '../setup/helpers/vlcrc-path.js'

/**
 * VLC HTTP source.
 *
 * VLC's "lua HTTP" interface exposes `GET /requests/status.json` — a stable,
 * documented endpoint that returns the current state as JSON. The protocol
 * is part of VLC itself (see the lua/intf/modules/httprequests.lua in
 * upstream); we only consume it.
 *
 * Auth is HTTP basic with an empty username and a password set in vlcrc's
 * `[lua] http-password=…`. The adapter re-reads vlcrc at construct time to
 * pick up whatever password the setup-action wrote (or the user picked
 * manually) — there's no shared secret in our code.
 *
 * The adapter is opt-in: the user enables VLC's HTTP via the Stage 7 setup
 * action, then enables the `vlc` source in their config.
 */

const DEFAULT_PORT = 8080
const DEFAULT_HOST = '127.0.0.1'
const FETCH_TIMEOUT_MS = 1500

/** Shape of the response from `GET /requests/status.json` (only the fields we care about). */
interface VlcStatusResponse {
  /** "playing" | "paused" | "stopped" — VLC's own state vocabulary. */
  state?: string
  /** Position in seconds (float). 0 when nothing is loaded. */
  time?: number
  /** Length of current item in seconds (int). 0 when nothing is loaded. */
  length?: number
  /** Version string e.g. "3.0.20 Vetinari". */
  version?: string
  /**
   * Information block; `meta` is where the file path lives. The remaining
   * categories are the elementary streams ("Stream 1" / "Поток 1" — the
   * category NAMES and field KEYS are localized to VLC's UI language).
   */
  information?: {
    category?: {
      meta?: {
        filename?: string
        title?: string
      }
    } & Record<string, Record<string, string | undefined> | undefined>
  }
}

/** Video facts of the playing item, as reported by status.json. */
export interface VlcVideoInfo {
  width: number | null
  height: number | null
  /** DTO HDR value ('hdr10' | 'hlg') derived from the transfer function, or null. */
  hdr: string | null
}

/** The audio track currently being decoded, as reported by status.json. */
export interface VlcActiveAudio {
  /** Localized language name ("Русский" / "Russian") or null. */
  language: string | null
  /** Track description from the container ("MVO, HDRezka Studio") or null. */
  description: string | null
  /** Codec fourcc extracted from the codec string ("a52") or null. */
  codec: string | null
  /** Channel count derived from the decoded-channels layout, or null. */
  channels: number | null
}

interface VlcSnapshot {
  state: 'playing' | 'paused' | 'stopped' | 'idle'
  positionMs: number
  durationMs: number
  /** File name (no path) reported in info.meta. Empty when nothing is loaded. */
  filename: string
  version: string | null
  /** Selected audio track, when identifiable. Optional so tests stay terse. */
  audio?: VlcActiveAudio | null
  /** Video stream facts, when identifiable. Optional so tests stay terse. */
  video?: VlcVideoInfo | null
}

/** Fourccs VLC uses for audio codecs — the fallback classifier for streams. */
const AUDIO_FOURCCS = new Set([
  'a52',
  'eac3',
  'mp4a',
  'aac',
  'mpga',
  'mp3',
  'dts',
  'dca',
  'flac',
  'opus',
  'vorb',
  'mlp',
  'trhd',
  'araw',
  'wma2',
])

function fieldByKey(entry: Record<string, string | undefined>, keyRe: RegExp): string | null {
  for (const [key, value] of Object.entries(entry)) {
    if (keyRe.test(key) && typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return null
}

/** Trailing "(a52 )" fourcc from a VLC codec description string. */
function fourccOf(codecText: string | null): string | null {
  const match = codecText ? /\(([a-z0-9 _-]{3,5})\)\s*$/i.exec(codecText) : null
  return match ? match[1].trim().toLowerCase() : null
}

/**
 * Find the audio track VLC is decoding right now.
 *
 * status.json lists ALL elementary streams; only the selected ones carry
 * decoder fields. `Decoded_channels` is the marker for the active audio
 * stream (the key survives localization — it's untranslated in VLC's .po
 * files — unlike `Codec`/`Кодек` and friends, which we match in both English
 * and Russian). Fallback: when no decoder marker is visible, a lone audio
 * stream in the list must be the one playing.
 */
/**
 * Pull video resolution + HDR signalling out of status.json streams.
 *
 * Field KEYS are localized ("Разрешение_видео"), so we match VALUES instead —
 * they come from VLC's core untranslated: resolution is "3840x2160", the
 * transfer function is "SMPTE ST2084 (PQ)" / "Hybrid Log-Gamma". The largest
 * WxH value across all streams is the video (subtitle/audio streams never
 * carry one). VLC 3 doesn't decode Dolby Vision (plays the HDR10 base layer),
 * so DV never shows up here — hdr10/hlg is as far as this source goes.
 */
export function videoInfoFromVlc(raw: VlcStatusResponse): VlcVideoInfo | null {
  const category = raw.information?.category
  if (!category) {
    return null
  }

  let width: number | null = null
  let height: number | null = null
  let hdr: string | null = null

  for (const [name, entry] of Object.entries(category)) {
    if (name === 'meta' || !entry || typeof entry !== 'object') {
      continue
    }
    for (const value of Object.values(entry)) {
      if (typeof value !== 'string') {
        continue
      }
      const dims = /^(\d{2,5})\s*x\s*(\d{2,5})$/.exec(value.trim())
      if (dims) {
        const w = Number.parseInt(dims[1], 10)
        const h = Number.parseInt(dims[2], 10)
        if (w * h > (width ?? 0) * (height ?? 0)) {
          width = w
          height = h
        }
        continue
      }
      hdr ??= hdrFromTransfer(value)
    }
  }

  if (width == null && hdr == null) {
    return null
  }
  return { width, height, hdr }
}

export function activeAudioFromVlc(raw: VlcStatusResponse): VlcActiveAudio | null {
  const category = raw.information?.category
  if (!category) {
    return null
  }

  const streams: Array<Record<string, string | undefined>> = []
  for (const [name, entry] of Object.entries(category)) {
    if (name === 'meta' || !entry || typeof entry !== 'object') {
      continue
    }
    streams.push(entry)
  }

  let active = streams.find((s) => fieldByKey(s, /^decoded[_ ]channels$/i) != null)
  if (!active) {
    const audioStreams = streams.filter((s) =>
      AUDIO_FOURCCS.has(fourccOf(fieldByKey(s, /^(codec|кодек)$/i)) ?? ''),
    )
    if (audioStreams.length !== 1) {
      return null
    }
    active = audioStreams[0]
  }

  return {
    language: fieldByKey(active, /^(language|язык)$/i),
    description: fieldByKey(active, /^(description|описание)$/i),
    codec: fourccOf(fieldByKey(active, /^(codec|кодек)$/i)),
    channels: channelsFromText(fieldByKey(active, /^decoded[_ ]channels$/i)),
  }
}

interface SessionRecord {
  /** Last action emitted for this sessionId. */
  lastAction: 'progress' | 'stopped' | null
  /** Last raw VLC state — used to detect playing/paused → stopped transition. */
  lastState: 'playing' | 'paused' | 'stopped' | 'idle' | null
}

/** VLC's documented state vocabulary. Anything else is normalised to "idle". */
const KNOWN_VLC_STATES = new Set(['playing', 'paused', 'stopped'])

/**
 * Project the raw VLC JSON into the typed snapshot the rest of the adapter
 * uses. Tolerant of missing fields: VLC pre-load emits `state: "stopped"`
 * with `time: 0`, `length: 0`, no `information.category.meta`.
 */
export function snapshotFromVlc(raw: VlcStatusResponse): VlcSnapshot {
  const rawState = raw.state ?? 'stopped'
  const state: VlcSnapshot['state'] = KNOWN_VLC_STATES.has(rawState)
    ? (rawState as VlcSnapshot['state'])
    : 'idle'
  return {
    state,
    positionMs: Math.round(toFiniteNumber(raw.time, 0) * 1000),
    durationMs: Math.round(toFiniteNumber(raw.length, 0) * 1000),
    filename: raw.information?.category?.meta?.filename ?? '',
    version: raw.version ?? null,
    audio: activeAudioFromVlc(raw),
    video: videoInfoFromVlc(raw),
  }
}

function toFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * True only when VLC reports playing/paused with a real duration. Pre-load
 * (`state: stopped`, length 0) and the persistent stopped state between
 * sessions both filter out here, so the adapter never emits a 0%/0-duration
 * progress event. Pure — unit-testable.
 */
export function isActivelyPlaying(snapshot: VlcSnapshot): boolean {
  return (snapshot.state === 'playing' || snapshot.state === 'paused') && snapshot.durationMs > 0
}

/**
 * Build a NormalizedEvent for a single VLC snapshot. Pure — unit-testable.
 *
 * Note: VLC `information.category.meta.filename` is a bare basename without
 * full path. That's enough for the filename parser to extract title / S/E /
 * year, but downstream external-ID lookup will be slightly weaker than for
 * mpv/MPC (where we get the full filepath).
 */
export function buildEvent(
  snapshot: VlcSnapshot,
  action: 'progress' | 'stopped',
): NormalizedEvent | null {
  if (!snapshot.filename) {
    return null
  }

  const parsed = parseFilename(snapshot.filename)
  const state: PlaybackState = snapshot.state === 'paused' ? 'paused' : 'playing'

  return {
    type: parsed.type,
    sessionId: `vlc:${snapshot.filename}`,
    ids: {},
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
    episodeIds: {},
    episodeImdbId: null,
    episodeTmdbId: null,
    episodeTvdbId: null,
    title: parsed.title ?? snapshot.filename,
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
    source: 'vlc',
    action,
    state,
    appVersion: snapshot.version,
    media: {
      // Actual decoded dimensions win over release-name tokens.
      resolution:
        resolutionFromDimensions(snapshot.video?.width ?? 0, snapshot.video?.height ?? 0) ??
        resolutionFromFilename(snapshot.filename),
      hdr: snapshot.video?.hdr ?? hdrFromFilename(snapshot.filename),
      audioCodec: normalizeAudioCodec(snapshot.audio?.codec),
      audioChannels: snapshot.audio?.channels ?? null,
      audioLanguage: languageToIso(snapshot.audio?.language),
      container: containerFromFile(snapshot.filename),
    },
    // The selected track's description names the studio the user actually
    // hears — more precise than the release group guessed from the filename.
    dubTeam:
      dubTeamFromTrackTitle(snapshot.audio?.description) ?? extractDubTeam(snapshot.filename),
  }
}

/**
 * Resolve `host:port` from the configured URL (or defaults), independently
 * of password (we read the password directly from vlcrc, not URL).
 */
export function resolveVlcEndpoint(rawUrl: string): { host: string; port: number } {
  let host = DEFAULT_HOST
  let port = DEFAULT_PORT
  if (rawUrl) {
    try {
      const looksLikeUrl = /^\w+:\/\//.test(rawUrl)
      const parsed = new URL(looksLikeUrl ? rawUrl : `http://${rawUrl}`)
      if (parsed.hostname) {
        host = parsed.hostname
      }
      if (parsed.port) {
        port = Number.parseInt(parsed.port, 10) || DEFAULT_PORT
      }
    } catch {
      // Bad URL string — fall through to defaults.
    }
  }
  return { host, port }
}

/**
 * Read the HTTP password VLC will accept from vlcrc. Returns empty string if
 * no password is set — VLC's HTTP interface refuses connections without one,
 * so the adapter will then fail at checkConnection and surface a clear 401.
 */
export async function readVlcPasswordFromConfig(): Promise<string> {
  const read = await readIni(resolveVlcrcPath())
  if (!read) {
    return ''
  }
  return getIniValue(read, VLCRC_SECTION_LUA, VLCRC_KEY_PASSWORD) ?? ''
}

export class VlcHttpAdapter extends BaseAdapter {
  private readonly endpoint: string
  private readonly sessions = new Map<string, SessionRecord>()
  private authHeader: string | null = null

  constructor(...args: ConstructorParameters<typeof BaseAdapter>) {
    super(...args)
    const { host, port } = resolveVlcEndpoint(this.config.url)
    this.endpoint = `http://${host}:${port}/requests/status.json`
  }

  get name(): SourceType {
    return 'vlc'
  }

  async checkConnection(): Promise<boolean> {
    try {
      const auth = await this.ensureAuthHeader()
      const res = await fetch(this.endpoint, {
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (res.status === 401) {
        this.setConnectionError('VLC HTTP rejected our password (401). Re-run the setup action.')
        return false
      }
      if (!res.ok) {
        this.setConnectionError(`VLC HTTP responded ${res.status}`)
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
    // Drop the cached auth header too so the next poll re-reads vlcrc — picks
    // up any password the user just rotated.
    this.authHeader = null
  }

  protected async poll(): Promise<void> {
    if (!this.running) {
      return
    }

    let body: unknown
    try {
      const auth = await this.ensureAuthHeader()
      const res = await fetch(this.endpoint, {
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (res.status === 401) {
        this.setConnectionError('VLC HTTP rejected our password (401). Re-run the setup action.')
        // Force re-read on next poll in case vlcrc was just updated.
        this.authHeader = null
        return
      }
      if (!res.ok) {
        this.setConnectionError(`VLC HTTP responded ${res.status}`)
        return
      }
      body = await res.json()
      this.clearConnectionError()
    } catch (err) {
      this.setConnectionError((err as Error).message)
      return
    }

    const snapshot = snapshotFromVlc(body as VlcStatusResponse)
    if (!snapshot.filename) {
      // Player open but no file loaded; nothing to emit.
      return
    }
    const sessionId = `vlc:${snapshot.filename}`
    const prev = this.sessions.get(sessionId) ?? { lastAction: null, lastState: null }

    if (!isActivelyPlaying(snapshot)) {
      // Emit one final `stopped` on the transition out of active playback.
      const wasActive = prev.lastState === 'playing' || prev.lastState === 'paused'
      if (wasActive) {
        const event = buildEvent(snapshot, 'stopped')
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

    const event = buildEvent(snapshot, 'progress')
    if (event) {
      await this.emitScrobble(event)
    }
    this.sessions.set(sessionId, { lastAction: 'progress', lastState: snapshot.state })
  }

  private async ensureAuthHeader(): Promise<string> {
    if (this.authHeader !== null) {
      return this.authHeader
    }
    // Prefer an explicit token from source config (advanced users), fall back
    // to reading the password the setup-action wrote into vlcrc.
    const password = this.config.token || (await readVlcPasswordFromConfig())
    this.authHeader = buildVlcAuthHeader(password)
    return this.authHeader
  }
}
