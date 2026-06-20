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
import { dubTeamFromTrackTitle, languageToIso, normalizeAudioCodec } from '../utils/audio-track.js'
import { queryMpvProperties, defaultMpvSocketPath, type MpvProperties } from '../utils/mpv-ipc.js'

/**
 * mpv source via its JSON IPC. Opt-in: the user enables IPC by adding
 * `input-ipc-server=<path>` to `mpv.conf` (the Stage 4 setup action does this),
 * restarts mpv, then enables the `mpv` source in config.
 *
 * Distinct from how the `player` adapter sees mpv (process scan + uptime
 * estimate): this path gives exact position/duration/pause straight from mpv.
 * Running both sources for the same mpv instance double-counts — see the
 * "double counting" limitation in the Stage 4 doc; resolving source precedence
 * is deferred to a dedicated step.
 */

interface SessionRecord {
  lastPath: string | null
  /** Whether we've already emitted the final stopped for the current file. */
  stoppedEmitted: boolean
}

/** Resolve the IPC endpoint: explicit config.url wins, else the platform default. */
export function resolveMpvSocket(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  return trimmed.length > 0 ? trimmed : defaultMpvSocketPath()
}

/**
 * True when the snapshot is positively audio-only: mpv reports an audio track
 * but no real video (cover art counts as no video). Keeps music out of the
 * scrobble feed. A still-loading video also reports no params, so we only call
 * it music when an audio track is actually present — better to keep a real
 * video than to drop one.
 */
export function isAudioOnly(props: MpvProperties): boolean {
  if (props.videoAlbumart === true) {
    return true
  }
  const hasVideo =
    props.videoWidth != null ||
    props.videoHeight != null ||
    props.videoGamma != null ||
    props.doviProfile != null
  return !hasVideo && props.audioCodec != null
}

/**
 * Build a NormalizedEvent from an mpv property snapshot. Pure — no IPC, no
 * state — so the data path is unit-testable. Returns null when there's no
 * file loaded (idle mpv) or the file is music.
 */
export function buildEvent(
  props: MpvProperties,
  action: 'progress' | 'stopped',
  source: SourceType = 'mpv',
): NormalizedEvent | null {
  const pathOrTitle = props.path ?? props.mediaTitle
  if (!pathOrTitle) {
    return null
  }
  // Music (audio-only or cover-art "video") is not a show/movie — skip it.
  if (isAudioOnly(props)) {
    return null
  }
  const parsed = parseFilename(pathOrTitle)
  const state: PlaybackState = props.pause === true ? 'paused' : 'playing'
  const durationMs = props.duration != null ? Math.round(props.duration * 1000) : null
  const positionMs = props.timePos != null ? Math.round(props.timePos * 1000) : null

  return {
    type: parsed.type,
    // Prefix with the source so an mpv and an IINA session for the same file
    // don't collide on sessionId when both are configured.
    sessionId: `${source}:${pathOrTitle}`,
    ids: {},
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
    episodeIds: {},
    episodeImdbId: null,
    episodeTmdbId: null,
    episodeTvdbId: null,
    title: parsed.title ?? pathOrTitle,
    originalTitle: parsed.originalTitle,
    year: parsed.year,
    showTitle: parsed.type === 'episode' ? parsed.title : null,
    showOriginalTitle: null,
    season: parsed.season,
    episode: parsed.episode,
    userRating: null,
    contentRating: null,
    runtimeMinutes: durationMs != null ? Math.round(durationMs / 60_000) : null,
    duration: durationMs,
    viewOffset: positionMs,
    source,
    action,
    state,
    // "mpv v0.41.0-…" → "v0.41.0-…" (the source already says it's mpv).
    appVersion: props.mpvVersion?.replace(/^mpv\s+/i, '') ?? null,
    media: {
      // Actual decoded dimensions win over release-name tokens.
      resolution:
        resolutionFromDimensions(props.videoWidth ?? 0, props.videoHeight ?? 0) ??
        resolutionFromFilename(pathOrTitle),
      hdr:
        props.doviProfile != null
          ? 'dolby_vision'
          : (hdrFromTransfer(props.videoGamma) ?? hdrFromFilename(pathOrTitle)),
      audioCodec: normalizeAudioCodec(props.audioCodec),
      audioChannels: props.audioChannelCount,
      audioLanguage: languageToIso(props.audioLang),
      container: containerFromFile(pathOrTitle),
    },
    // The selected track's title names the studio the user actually hears —
    // more precise than the release group guessed from the filename.
    dubTeam: dubTeamFromTrackTitle(props.audioTitle) ?? extractDubTeam(pathOrTitle),
  }
}

export class MpvIpcAdapter extends BaseAdapter {
  // Protected (not private) so IinaIpcAdapter can repoint it at IINA's socket.
  protected socketPath: string
  private session: SessionRecord = { lastPath: null, stoppedEmitted: false }

  constructor(...args: ConstructorParameters<typeof BaseAdapter>) {
    super(...args)
    this.socketPath = resolveMpvSocket(this.config.url)
  }

  get name(): SourceType {
    return 'mpv'
  }

  async checkConnection(): Promise<boolean> {
    const props = await queryMpvProperties(this.socketPath)
    if (!props) {
      this.setConnectionError(`mpv IPC not reachable at ${this.socketPath}`)
      return false
    }
    this.clearConnectionError()
    return true
  }

  protected override resetState(): void {
    this.session = { lastPath: null, stoppedEmitted: false }
  }

  protected async poll(): Promise<void> {
    if (!this.running) {
      return
    }

    const props = await queryMpvProperties(this.socketPath)
    if (!props) {
      // mpv not running / IPC off / not yet restarted after setup. We don't
      // synthesise a stop here: a transient socket blip shouldn't fabricate a
      // "finished watching" event. The session goes stale until mpv comes back.
      this.setConnectionError(`mpv IPC not reachable at ${this.socketPath}`)
      return
    }
    this.clearConnectionError()

    const currentPath = props.path ?? props.mediaTitle

    // File switched inside the same mpv instance → close the previous session.
    if (
      this.session.lastPath &&
      currentPath &&
      currentPath !== this.session.lastPath &&
      !this.session.stoppedEmitted
    ) {
      await this.emitStopFor(this.session.lastPath, props)
    }

    if (!currentPath) {
      // mpv idle (no file). Close any open session once.
      if (this.session.lastPath && !this.session.stoppedEmitted) {
        await this.emitStopFor(this.session.lastPath, props)
      }
      this.session = { lastPath: null, stoppedEmitted: false }
      return
    }

    // New file or resumed tracking.
    if (currentPath !== this.session.lastPath) {
      this.session = { lastPath: currentPath, stoppedEmitted: false }
    }

    if (props.eofReached === true) {
      // Reached the end — emit one final stopped, then suppress until the file
      // changes (mpv sits on the last frame with eof-reached=true).
      if (!this.session.stoppedEmitted) {
        const event = buildEvent(props, 'stopped', this.name)
        if (event) {
          await this.emitScrobble(event)
        }
        this.session.stoppedEmitted = true
      }
      return
    }

    const event = buildEvent(props, 'progress', this.name)
    if (event) {
      await this.emitScrobble(event)
    }
  }

  /** Emit a synthetic stopped event for a path using the latest known offsets. */
  private async emitStopFor(path: string, props: MpvProperties): Promise<void> {
    const event = buildEvent({ ...props, path }, 'stopped', this.name)
    if (event) {
      await this.emitScrobble(event)
    }
    this.session.stoppedEmitted = true
  }
}
