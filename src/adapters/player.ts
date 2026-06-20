import type { SourceType, NormalizedEvent, MediaInfo, PlaybackState } from '../types.js'
import { BaseAdapter } from './base.js'
import { extractDubTeam } from '../utils/dub-team.js'
import { parseFilename } from '../utils/filename-parser.js'
import {
  containerFromFile,
  hdrFromFilename,
  hdrFromVideoProbe,
  mediaInfoOrNull,
  resolutionFromDimensions,
  resolutionFromFilename,
} from './media-info.js'
import { secondsToRuntimeMinutes } from './time.js'
import {
  scanPlayers,
  extractFilePath,
  findOpenMediaFile,
  filenameFromWindowTitle,
  type ProcessInfo,
  type PlayerId,
} from '../utils/process-monitor.js'
import {
  getActiveDurationTool,
  getMediaDurationSeconds,
  isProbedAudioOnly,
  probeFileMedia,
  type FileMediaProbe,
} from '../utils/media-duration.js'
import { dubTeamFromTrackTitle, languageToIso, normalizeAudioCodec } from '../utils/audio-track.js'
import { probeMacosPlayers, type OsaPlayback } from '../utils/macos-osa.js'
import { probeLinuxMpris, type MprisPlayback, type MprisPlayerKind } from '../utils/linux-mpris.js'
import { probeWindowsSmtc, classifyAumid, type SmtcPlayback } from '../utils/windows-smtc.js'
import { probeWindowsPotPlayer } from '../utils/windows-potplayer.js'
import { resolveWindowsFilePath } from '../utils/windows-handle-resolver.js'

/**
 * Player ids we ignore when they arrive via the Windows SMTC probe.
 *
 *  - `spotify` — music streaming. MyShows tracks shows/movies, not tracks.
 *  - `browser` — SMTC sees that a browser is playing video but exposes only
 *    the page <title> string: no URL, no service id, no episode metadata.
 *    Per the player-integration strategy (§3 "Browser tabs — separate
 *    workstream"), that signal is too weak to drive MyShows matching — a tab
 *    titled "Netflix" can be mistaken for a series literally called "Netflix".
 *    Browser-tab scrobbling will be handled by a dedicated WebExtension that
 *    has the page URL.
 *
 * Exported so a unit test can assert membership without reaching into module
 * internals.
 */
export const SMTC_SKIP_PLAYERS: PlayerId[] = ['spotify', 'browser']

/**
 * MPRIS player kinds we ignore — dedicated music players that never carry a
 * show/movie. Audio files opened in a *video* MPRIS player still get caught by
 * the downstream ffprobe music guard.
 */
export const MPRIS_SKIP_PLAYERS: MprisPlayerKind[] = ['rhythmbox']

/**
 * Sentinel filePath for the PotPlayer SendMessage reading. That probe returns
 * exact position/duration/state but NO title or path — it only makes sense as
 * enrichment for a process-scan session (which supplies the filename from the
 * window title). If it's never consumed in Pass 1, it must NOT orphan-emit:
 * parseFilename would turn this sentinel into a bogus movie titled
 * "potplayer:precise". Pass 2 skips any reading carrying this path.
 */
const POTPLAYER_PRECISE_PLACEHOLDER = 'potplayer:precise'

// ── Backend abstraction ────────────────────────────────────────────────────
//
// A "precise probe" returns playback data straight from the application's own
// API, with exact position/duration/state (no uptime estimation). Stack:
//   - macOS: AppleScript / JXA (implemented)
//   - Linux: MPRIS over DBus (planned)
//   - Windows: SMTC via PowerShell/.NET helper (planned)
//
// When a precise reading is available for a given (player, file), it overrides
// the uptime-based estimate from the process scan. Process scan + lsof stays
// as the fallback for players without a system-level API (mpv, custom apps).

/** Pure-data shape of a single precise reading. */
interface PreciseSession {
  player: PlayerId
  filePath: string
  isPlaying: boolean
  positionMs: number
  durationMs: number
}

/**
 * Two-tier index of precise sessions:
 *   - `byFilePath`: for backends that report a real file path (OSA / MPRIS with `xesam:url`).
 *     Matched against the file path extracted from the process command line.
 *   - `byPlayer`:   for backends that don't report a path (SMTC always, MPRIS for streams
 *     without `xesam:url`). Matched against the logical player id of the running process,
 *     so a single VLC/MPC process gets merged with its SMTC reading even though SMTC
 *     never exposes the file path.
 *
 * Why two indices instead of one: SMTC's "key" is the AUMID, not a path, so a naive
 * `Map<string, ...>` keyed by path would never see SMTC entries during the Pass-1
 * lookup. Splitting the indices makes the merge semantics explicit per backend.
 */
interface PreciseRegistry {
  byFilePath: Map<string, PreciseSession>
  byPlayer: Map<PlayerId, PreciseSession>
}

/**
 * Gather precise playback readings from every backend that supports the
 * current platform.
 */
async function gatherPreciseSessions(): Promise<PreciseRegistry> {
  const byFilePath = new Map<string, PreciseSession>()
  const byPlayer = new Map<PlayerId, PreciseSession>()

  // Each probe is a no-op on the wrong platform (returns []), so we don't
  // need an extra branch here. Order is irrelevant — at most one platform's
  // backend will yield results.

  for (const osa of await probeMacosPlayers()) {
    // We only merge OSA readings that have a file path. Title-only entries
    // (Music.app, TV.app for streaming content) don't fit the file-based
    // session model the rest of the adapter uses — track separately later.
    if (!osa.filePath) {
      continue
    }
    const player = mapOsaPlayer(osa)
    if (!player) {
      continue
    }
    byFilePath.set(osa.filePath, {
      player,
      filePath: osa.filePath,
      isPlaying: osa.isPlaying,
      positionMs: Math.round(osa.positionSeconds * 1000),
      durationMs: Math.round(osa.durationSeconds * 1000),
    })
  }

  for (const mp of await probeLinuxMpris()) {
    // Music players have nothing to scrobble to MyShows. A local audio file
    // opened in a video player is still caught later by the ffprobe gate.
    if (MPRIS_SKIP_PLAYERS.includes(mp.player)) {
      continue
    }
    // MPRIS may or may not expose `xesam:url`. With a path we merge against
    // the process scan's filePath; without it we merge by player id (same
    // semantics as SMTC below).
    if (mp.filePath) {
      byFilePath.set(mp.filePath, mapMpris(mp, mp.filePath))
    } else {
      const player = mp.player as PlayerId
      byPlayer.set(player, mapMpris(mp, mp.title || `mpris:${player}`))
    }
  }

  for (const s of await probeWindowsSmtc()) {
    const player = classifyAumid(s.appUserModelId) as PlayerId
    // Drop sources SMTC can't describe well enough to scrobble — see
    // SMTC_SKIP_PLAYERS for the per-player rationale.
    if (SMTC_SKIP_PLAYERS.includes(player)) {
      continue
    }
    // SMTC tells us the media kind directly — drop anything that isn't video
    // (music apps, photo viewers) regardless of which app reported it.
    if (s.playbackType === 'Music' || s.playbackType === 'Image') {
      continue
    }
    // Skip empty-title sessions (nothing to scrobble) and zero-duration
    // sessions. The latter is the MPC-HC pain point: it registers as a media
    // source but never populates `GetTimelineProperties`, so SMTC reports
    // position=0/duration=0 forever. Forcing those into the precise path
    // would freeze the scrobble at 0% — better to let the process-scan
    // + uptime + ffprobe fallback drive the session.
    if (!s.title || s.durationSeconds <= 0) {
      continue
    }
    // SMTC never reports a path. Use the SMTC title as the orphan filePath —
    // parseFilename runs guessit on it, which extracts year/episode cleanly.
    byPlayer.set(player, mapSmtc(s, player, s.title))
  }

  // PotPlayer: query it directly via documented WM_USER messages. Some builds
  // ALSO publish to SMTC (with the filename as title) — if the SMTC loop above
  // already produced a 'potplayer' reading, don't clobber it with this
  // title-less placeholder; SMTC's reading carries a real filename and is
  // strictly better. The SendMessage path is the fallback for builds that
  // don't publish SMTC, where it enriches the process-scan session.
  const potPlayback = await probeWindowsPotPlayer()
  if (potPlayback && !byPlayer.has('potplayer')) {
    byPlayer.set('potplayer', {
      player: 'potplayer',
      // Placeholder: the real filePath is resolved from the process scan during
      // the precise-merge step (Pass 1). Pass 2 explicitly skips this sentinel
      // so a process-less PotPlayer reading never becomes a bogus orphan event.
      filePath: POTPLAYER_PRECISE_PLACEHOLDER,
      isPlaying: potPlayback.isPlaying,
      positionMs: Math.round(potPlayback.positionSeconds * 1000),
      durationMs: Math.round(potPlayback.durationSeconds * 1000),
    })
  }

  return { byFilePath, byPlayer }
}

function mapOsaPlayer(osa: OsaPlayback): PlayerId | null {
  switch (osa.player) {
    case 'vlc':
      return 'vlc'
    case 'quicktime':
      return 'quicktime'
    // tv has no filePath, filtered out above anyway.
    default:
      return null
  }
}

function mapMpris(mp: MprisPlayback, key: string): PreciseSession {
  return {
    player: mp.player as PlayerId,
    filePath: key,
    isPlaying: mp.isPlaying,
    positionMs: Math.round(mp.positionSeconds * 1000),
    durationMs: Math.round(mp.durationSeconds * 1000),
  }
}

function mapSmtc(s: SmtcPlayback, player: PlayerId, key: string): PreciseSession {
  return {
    player,
    filePath: key,
    isPlaying: s.isPlaying,
    positionMs: Math.round(s.positionSeconds * 1000),
    durationMs: Math.round(s.durationSeconds * 1000),
  }
}

// ── Session model ──────────────────────────────────────────────────────────

interface ActiveSession {
  sessionId: string
  pid: number
  player: PlayerId
  filePath: string
  /** When we first detected this (pid, file) pair — t=0 reference for uptime-based viewOffset. */
  sessionStartedAt: Date
  durationSeconds: number
  /** Largest viewOffset (ms) seen — protects an uptime estimate from rolling
   * back on a player restart. Used only when there's no precise reading. */
  highWaterOffsetMs: number
  /**
   * Exact position (ms) from a precise backend (AppleScript / SMTC / MPRIS /
   * IPC) on the latest tick, or null when this tick only had an uptime
   * estimate. Unlike the high-water mark this follows real seeks in BOTH
   * directions, so backward seeks are reflected. Preferred by `buildEvent`.
   */
  preciseOffsetMs: number | null
  /** Consecutive polls with no observation — debounces lsof/scan flicker. */
  missedTicks: number
  /** Last known playback state. Updated each tick when a precise probe is available. */
  state: PlaybackState
  /**
   * Container probe of the file (ffprobe/mediainfo), done once at session
   * start when the filePath is a real absolute path. None of the process-scan
   * players report stream info, so the default audio track + video stream
   * from the container is best-effort.
   */
  probe: FileMediaProbe | null
  /** Product version of the player binary ("1.7.22227"), when the scan saw it. */
  version: string | null
  /**
   * Set to true when an uptime-only session has accumulated wall-clock time
   * equal to the file duration. Triggers a one-shot 'stopped' emit on this
   * same tick — without it the session stays at 100% forever, the per-key
   * antispam in the server silences the feed, and pressing Play in the player
   * (which we have no way to detect for MPC-style sources) produces zero UI
   * activity. We commit to "completed" and don't recreate this sessionId
   * until pid or file actually changes.
   */
  uptimeSaturated: boolean
}

const MAX_MISSED_TICKS = 2

function buildSessionId(player: PlayerId, pid: number, filePath: string): string {
  return `player:${player}:${pid}:${filePath}`
}

/** Inverse of buildSessionId — pulls the pid back out, or NaN for orphan ids. */
function extractPidFromSessionId(sessionId: string): number {
  // Format: `player:${player}:${pid}:${filePath}` — pid is the third segment.
  const parts = sessionId.split(':', 4)
  const raw = parts[2]
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) ? n : NaN
}

/**
 * Stable session id for sessions that aren't tied to a real OS process
 * (SMTC-only, MPRIS-only, browser tabs). Pid would change every poll if we
 * minted a new synthetic one, splitting a single playback into a chain of
 * phantom start/stop pairs.
 */
function buildOrphanSessionId(player: PlayerId, filePath: string): string {
  return `player:${player}:orphan:${filePath}`
}

/** Sentinel pid for orphan sessions — never collides with a real OS pid (>0). */
const ORPHAN_PID = 0

/** True for "C:\…" / "/mnt/…" style paths a media probe can actually open. */
function isAbsolutePath(filePath: string): boolean {
  return /^[a-z]:[\\/]/i.test(filePath) || filePath.startsWith('/')
}

function buildMediaInfo(filePath: string, probe: FileMediaProbe | null): MediaInfo | null {
  return mediaInfoOrNull({
    // Actual container dimensions win over release-name tokens.
    resolution:
      resolutionFromDimensions(probe?.video?.width ?? 0, probe?.video?.height ?? 0) ??
      resolutionFromFilename(filePath),
    hdr: hdrFromVideoProbe(probe?.video) ?? hdrFromFilename(filePath),
    audioCodec: normalizeAudioCodec(probe?.audio?.codec),
    audioChannels: probe?.audio?.channels ?? null,
    audioLanguage: languageToIso(probe?.audio?.language),
    container: containerFromFile(filePath),
  })
}

function buildEvent(session: ActiveSession, action: 'progress' | 'stopped'): NormalizedEvent {
  const parsed = parseFilename(session.filePath)
  const durationMs = session.durationSeconds > 0 ? session.durationSeconds * 1000 : null
  const fileName = session.filePath.split(/[\\/]/).pop() ?? session.filePath
  return {
    type: parsed.type,
    sessionId: session.sessionId,
    ids: {},
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
    episodeIds: {},
    episodeImdbId: null,
    episodeTmdbId: null,
    episodeTvdbId: null,
    title: parsed.title ?? fileName,
    originalTitle: parsed.originalTitle,
    year: parsed.year,
    showTitle: parsed.type === 'episode' ? parsed.title : null,
    showOriginalTitle: null,
    season: parsed.season,
    episode: parsed.episode,
    userRating: null,
    contentRating: null,
    runtimeMinutes: secondsToRuntimeMinutes(session.durationSeconds || null),
    duration: durationMs,
    // Exact precise position when available (tracks seeks both ways); the
    // monotonic high-water mark only backs the uptime estimate.
    viewOffset: session.preciseOffsetMs ?? session.highWaterOffsetMs,
    source: 'player',
    // Report the concrete player to MyShows ("potplayer", "wmp"), keeping
    // `source: 'player'` for internal routing. appVersion is then free to
    // carry the actual binary version, per the DTO's intent.
    sourceApp: session.player,
    action,
    state: session.state,
    appVersion: session.version,
    media: buildMediaInfo(session.filePath, session.probe),
    dubTeam: dubTeamFromTrackTitle(session.probe?.audio?.title) ?? extractDubTeam(session.filePath),
  }
}

// ── Adapter ────────────────────────────────────────────────────────────────

/**
 * Unified detector for local media players.
 *
 * Per-tick flow:
 *   1. Gather precise readings from any platform-specific backend
 *      (AppleScript on macOS; MPRIS/SMTC planned for Linux/Windows).
 *   2. Scan running processes for known player executables. For each, look
 *      up its file path (argv or lsof) and check whether a precise reading
 *      already covers it.
 *      - Hit: use the precise position/duration/state directly.
 *      - Miss: fall back to uptime-based estimation + ffprobe duration.
 *   3. Any precise reading not matched by a process gets emitted as a
 *      standalone session (rare; usually means the player isn't in our
 *      PLAYER_MATCHES list yet).
 *
 * Caveats:
 *   - Requires native execution on the user's machine (not Docker).
 *   - Uptime-based path can't detect seeks or pauses; precise backends do.
 */
export class PlayerAdapter extends BaseAdapter {
  /** One session per (player, pid, filePath). VLC + MPV running in parallel is allowed. */
  private sessions = new Map<string, ActiveSession>()
  /**
   * Remembers the first sessionId we ever saw for each pid. Lets us tell apart
   * "this is the file the player launched with" (count viewOffset from process
   * start) vs. "user switched to a different file inside a long-running player"
   * (start counting from the moment we saw the switch).
   */
  private firstSessionByPid = new Map<number, string>()
  /**
   * sessionIds we're done with and won't recreate on later polls. Two reasons
   * land here: a session that emitted its final 'stopped' via uptime saturation
   * (otherwise an MPC left open for 24h would scrobble the same file once per
   * wall-clock duration), and a session we identified as music (so we don't
   * re-probe and re-log a song every tick). Cleared when the pid disappears or
   * the user opens a different file (different sessionId).
   */
  private completedSessionIds = new Set<string>()
  private warnedNoTool = false
  private warnedScan = ''
  /**
   * Player ids handled by a dedicated precise source (mpc/mpv/iina) that the
   * user has enabled. We skip them here so the same playback isn't counted
   * twice — once via this uptime estimate and once via the precise HTTP/IPC
   * adapter. Configured by the server's initAdapters from the live config.
   */
  private excludedPlayers = new Set<PlayerId>()

  get name(): SourceType {
    return 'player'
  }

  /** Tell the adapter which players are owned by an enabled precise source. */
  setExcludedPlayers(players: Iterable<PlayerId>): void {
    this.excludedPlayers = new Set(players)
  }

  async checkConnection(): Promise<boolean> {
    this.clearConnectionError()
    const tool = await getActiveDurationTool()
    if (!tool) {
      this.log(
        'warn',
        'No duration tool available — install mediainfo or ffprobe (or the bundled ffprobe failed to load)',
      )
    } else {
      this.log('info', `Duration tool: ${tool.kind} (${tool.source})`)
    }
    const snapshot = await scanPlayers()
    if (snapshot.warning) {
      this.setConnectionError(snapshot.warning)
      this.log('error', `Connection check failed: ${snapshot.warning}`)
      return false
    }
    return true
  }

  protected override resetState(): void {
    this.sessions.clear()
    this.firstSessionByPid.clear()
    this.completedSessionIds.clear()
    this.warnedNoTool = false
    this.warnedScan = ''
  }

  protected async poll(): Promise<void> {
    if (!this.running) {
      return
    }

    const precise = await gatherPreciseSessions()
    const snapshot = await scanPlayers()
    if (snapshot.warning && snapshot.warning !== this.warnedScan) {
      this.log('warn', snapshot.warning)
      this.warnedScan = snapshot.warning
    }

    const seen = new Set<string>()
    const seenPids = new Set<number>()
    /** Track which precise readings we already consumed, by filePath and by player id. */
    const consumedFilePaths = new Set<string>()
    const consumedPlayers = new Set<PlayerId>()

    // Pass 1 — process scan with precise override where available.
    for (const proc of snapshot.processes) {
      // A dedicated precise source (mpc/mpv/iina) owns this player — skip it so
      // we don't double-count its playback with an uptime estimate.
      if (this.excludedPlayers.has(proc.player)) {
        continue
      }
      // Resolve a filePath via the cheapest signal first, falling back through
      // progressively weaker ones:
      //   1. argv             — works when the player was launched with a file
      //   2. lsof             — Unix-only, fills the gap for GUI apps that open via Apple Events
      //   3. window title     — Windows: bare filename when the player doesn't surface argv
      //      + NtQuerySystemInformation handle resolver to upgrade that bare
      //      filename to a real full path. Required for ffprobe duration and
      //      thus for the scrobble percent threshold to ever trigger.
      let filePath = extractFilePath(proc.commandLine) ?? (await findOpenMediaFile(proc.pid))
      // Whether the filePath came from a signal that proves it was open *at
      // process launch*. argv / lsof give us that proof; window title doesn't
      // — a long-running MPC opened a file 30 seconds ago has windowTitle now
      // but its proc.startedAt is from yesterday. Track this so we don't
      // overestimate viewOffset.
      let filePathProvenFromLaunch = !!filePath
      if (!filePath && proc.windowTitle) {
        const filename = filenameFromWindowTitle(proc.player, proc.windowTitle)
        if (filename) {
          // Try to upgrade the bare filename to a real path via the kernel
          // handle table. Cached per (pid, filename); only the first poll for
          // a given playback pays the PowerShell cost. If resolution fails
          // (file just closed, permission, etc.) we keep the bare filename —
          // parseFilename still recognises shows/episodes from it, but duration
          // will be 0 and the scrobble won't fire.
          filePath = (await resolveWindowsFilePath(proc.pid, filename)) ?? filename
        }
      }
      if (!filePath) {
        continue
      }

      const sessionId = buildSessionId(proc.player, proc.pid, filePath)
      seen.add(sessionId)
      seenPids.add(proc.pid)

      // Already wrapped up as uptime-saturated on a previous tick — don't
      // recreate or re-emit anything until the user actually opens a different
      // file (different sessionId) or restarts the player (different pid).
      if (this.completedSessionIds.has(sessionId)) {
        continue
      }

      // Try to enrich with a precise reading. Path-keyed wins (exact match);
      // player-keyed is the SMTC/path-less MPRIS path.
      let preciseHit = precise.byFilePath.get(filePath)
      if (preciseHit) {
        consumedFilePaths.add(filePath)
      } else if (!consumedPlayers.has(proc.player)) {
        const byPlayer = precise.byPlayer.get(proc.player)
        if (byPlayer) {
          preciseHit = byPlayer
          consumedPlayers.add(proc.player)
        }
      }

      let session = this.sessions.get(sessionId)
      if (!session) {
        session = await this.startSession(
          sessionId,
          proc,
          filePath,
          preciseHit,
          filePathProvenFromLaunch,
        )
        this.sessions.set(sessionId, session)
      } else {
        session.missedTicks = 0
        this.touchSession(session, preciseHit)
      }

      // It's a song, not a show or movie (the probe found audio but no real
      // video). Retire it so we don't re-detect and re-log it every tick, and
      // never emit anything for it.
      if (isProbedAudioOnly(session.probe)) {
        this.retireSession(sessionId)
        continue
      }

      // Saturation closes the session as 'stopped' instead of 'progress'.
      // emitScrobble is wrapped in the same try/catch as the progress path.
      if (session.uptimeSaturated) {
        this.retireSession(sessionId)
        this.log(
          'info',
          `Uptime saturation: ${session.filePath} (${session.player}) — emitting final 'stopped' and freezing this session. ` +
            `For accurate position tracking enable a precise backend (e.g. MPC Web Interface on port 13579).`,
        )
        try {
          await this.emitScrobble(buildEvent(session, 'stopped'))
        } catch (err) {
          this.log('error', `emitScrobble (saturated stop) failed: ${(err as Error).message}`)
        }
        continue
      }

      try {
        await this.emitScrobble(buildEvent(session, 'progress'))
      } catch (err) {
        this.log('error', `emitScrobble failed: ${(err as Error).message}`)
      }
    }

    // Pass 2 — precise readings no process scan consumed. Sources:
    //   - Path-keyed leftovers: a precise backend saw a file but no matching
    //     player process was scanned (rare; usually a racy VLC.app launch).
    //   - Player-keyed leftovers: SMTC/MPRIS reports a player (browser tab,
    //     UWP app, VLC launched via drag-drop without argv) that has no
    //     scannable process *or* whose process scan didn't yield a filePath.
    for (const [filePath, p] of precise.byFilePath) {
      if (consumedFilePaths.has(filePath) || this.excludedPlayers.has(p.player)) {
        continue
      }
      await this.emitOrphan(p, seen)
    }
    for (const [player, p] of precise.byPlayer) {
      if (consumedPlayers.has(player) || this.excludedPlayers.has(player)) {
        continue
      }
      // The PotPlayer SendMessage reading carries no usable title — it can only
      // enrich a process-scan session, never stand alone. Drop it if unconsumed.
      if (p.filePath === POTPLAYER_PRECISE_PLACEHOLDER) {
        continue
      }
      await this.emitOrphan(p, seen)
    }

    // Sessions that vanished from the snapshot → maybe-emit stopped.
    // MAX_MISSED_TICKS grace polls guard against transient scan/lsof blips.
    // Exception: if the session's pid is still alive but bound to a different
    // sessionId now, that's an explicit file switch — close the old one immediately.
    for (const [id, session] of this.sessions) {
      if (seen.has(id)) {
        continue
      }
      const pidSwitchedFile = seenPids.has(session.pid)
      if (!pidSwitchedFile) {
        session.missedTicks += 1
        if (session.missedTicks < MAX_MISSED_TICKS) {
          continue
        }
      }
      this.log('info', `Playback ended: ${session.filePath} (${session.player})`)
      try {
        await this.emitScrobble(buildEvent(session, 'stopped'))
      } catch (err) {
        this.log('error', `emitScrobble (stop) failed: ${(err as Error).message}`)
      }
      this.sessions.delete(id)
    }

    // Drop bookkeeping for pids that no longer appear in the live snapshot.
    // Using seenPids (not "any-session-still-alive") matters here: a session
    // that just finished via uptime saturation has been deleted from
    // this.sessions, but its pid is still alive — we must keep
    // firstSessionByPid so the next file the player opens follows the
    // "file switched" branch (fresh sessionStartedAt) instead of the
    // "first detection" branch (uses proc.startedAt and instantly re-saturates).
    for (const pid of this.firstSessionByPid.keys()) {
      if (!seenPids.has(pid)) {
        this.firstSessionByPid.delete(pid)
      }
    }
    for (const id of this.completedSessionIds) {
      const pid = extractPidFromSessionId(id)
      if (!Number.isFinite(pid) || !seenPids.has(pid)) {
        this.completedSessionIds.delete(id)
      }
    }
  }

  /** Stop tracking a session and refuse to recreate it on later polls. */
  private retireSession(sessionId: string): void {
    this.completedSessionIds.add(sessionId)
    this.sessions.delete(sessionId)
  }

  private async startSession(
    sessionId: string,
    proc: ProcessInfo,
    filePath: string,
    precise?: PreciseSession,
    /**
     * True iff the filePath came from a signal that's only set when the file
     * was open at process launch (argv / lsof). False for late-discovered paths
     * (window title): we don't know when the player opened that file, so we
     * can't infer viewOffset from proc.startedAt.
     */
    filePathProvenFromLaunch = true,
  ): Promise<ActiveSession> {
    let durationSeconds = 0
    if (precise && precise.durationMs > 0) {
      durationSeconds = Math.round(precise.durationMs / 1000)
    } else {
      durationSeconds = await getMediaDurationSeconds(filePath)
      if (durationSeconds === 0 && !this.warnedNoTool) {
        const tool = await getActiveDurationTool()
        if (!tool) {
          this.log('warn', 'mediainfo/ffprobe missing — install one to get accurate scrobble %')
          this.warnedNoTool = true
        }
      }
    }

    let initialOffsetMs: number
    let sessionStartedAt: Date

    if (precise) {
      // Precise backend already knows exactly where playback is. No need for
      // uptime estimation; sessionStartedAt is purely informational here.
      initialOffsetMs = precise.positionMs
      sessionStartedAt = new Date()
    } else {
      const firstForPid = this.firstSessionByPid.get(proc.pid)
      if (!firstForPid && filePathProvenFromLaunch) {
        // First file we've seen for this pid AND we trust the launch link:
        // user launched the player with this file → viewOffset from proc.startedAt.
        this.firstSessionByPid.set(proc.pid, sessionId)
        sessionStartedAt = proc.startedAt
      } else if (!firstForPid) {
        // First detection for this pid but via late discovery (window title):
        // we have no idea when the file was opened. Best-effort: start counting
        // from now. If we'd inherited proc.startedAt instead, a player launched
        // hours ago and freshly opened a file would already report a 100%
        // watched session on the very first poll.
        this.firstSessionByPid.set(proc.pid, sessionId)
        sessionStartedAt = new Date()
      } else {
        // pid is known and this is a different sessionId → file was switched
        // inside an already-running player. Reset viewOffset to "now".
        sessionStartedAt = new Date()
        this.log('info', `File switched in ${proc.player} (pid ${proc.pid}): ${filePath}`)
      }
      initialOffsetMs = clampOffsetMs(
        Math.max(0, Date.now() - sessionStartedAt.getTime()),
        durationSeconds,
      )
    }

    const preciseTag = precise ? ' (precise)' : ''
    this.log(
      'info',
      `Detected ${proc.player} (pid ${proc.pid}): ${filePath}${durationSeconds ? ` [${durationSeconds}s]` : ''}${preciseTag}`,
    )

    // Already-saturated case: process has been running longer than the file
    // duration AND we have no precise position. We emit one 'stopped' on this
    // tick (in poll()) and stop tracking. The alternative — emit progress at
    // 100% — would silently lock the session forever via the server-side antispam.
    const uptimeSaturated =
      !precise && durationSeconds > 0 && initialOffsetMs >= durationSeconds * 1000

    return {
      sessionId,
      pid: proc.pid,
      player: proc.player,
      filePath,
      sessionStartedAt,
      durationSeconds,
      highWaterOffsetMs: initialOffsetMs,
      preciseOffsetMs: precise ? precise.positionMs : null,
      missedTicks: 0,
      state: precise ? (precise.isPlaying ? 'playing' : 'paused') : 'playing',
      uptimeSaturated,
      probe: isAbsolutePath(filePath) ? await probeFileMedia(filePath) : null,
      version: proc.version ?? null,
    }
  }

  private async emitOrphan(precise: PreciseSession, seen: Set<string>): Promise<void> {
    // Stable id: same (player, filePath) → same sessionId across polls, so
    // a long-running browser tab / SMTC-only playback isn't re-created every tick.
    const sessionId = buildOrphanSessionId(precise.player, precise.filePath)
    seen.add(sessionId)

    // Already finished with this one (music, or uptime-saturated) — don't
    // recreate it.
    if (this.completedSessionIds.has(sessionId)) {
      return
    }

    let session = this.sessions.get(sessionId)
    if (!session) {
      session = await this.startOrphanSession(sessionId, ORPHAN_PID, precise)
      this.sessions.set(sessionId, session)
    } else {
      session.missedTicks = 0
      this.touchSession(session, precise)
    }

    // A local song opened in VLC/QuickTime, or an MPRIS orphan pointing at an
    // audio file — retire it and skip it from here on.
    if (isProbedAudioOnly(session.probe)) {
      this.retireSession(sessionId)
      return
    }

    try {
      await this.emitScrobble(buildEvent(session, 'progress'))
    } catch (err) {
      this.log('error', `emitScrobble (orphan) failed: ${(err as Error).message}`)
    }
  }

  private async startOrphanSession(
    sessionId: string,
    orphanPid: number,
    precise: PreciseSession,
  ): Promise<ActiveSession> {
    this.log(
      'info',
      `Detected ${precise.player} via precise probe (no matching process): ${precise.filePath}`,
    )
    return {
      sessionId,
      pid: orphanPid,
      player: precise.player,
      filePath: precise.filePath,
      sessionStartedAt: new Date(),
      durationSeconds: precise.durationMs > 0 ? Math.round(precise.durationMs / 1000) : 0,
      highWaterOffsetMs: precise.positionMs,
      preciseOffsetMs: precise.positionMs,
      missedTicks: 0,
      state: precise.isPlaying ? 'playing' : 'paused',
      uptimeSaturated: false,
      // SMTC orphans carry a title, not a path — the absolute-path guard
      // means those skip the probe instantly (MPRIS orphans do have paths).
      probe: isAbsolutePath(precise.filePath) ? await probeFileMedia(precise.filePath) : null,
      // No OS process behind an orphan session → no binary to read a version from.
      version: null,
    }
  }

  private touchSession(session: ActiveSession, precise?: PreciseSession): void {
    if (precise) {
      // Precise reading — trust the exact position and state, including a seek
      // backward (we *know* where playback is, so reflect it faithfully).
      session.state = precise.isPlaying ? 'playing' : 'paused'
      if (precise.durationMs > 0) {
        session.durationSeconds = Math.round(precise.durationMs / 1000)
      }
      session.preciseOffsetMs = precise.positionMs
      if (precise.positionMs > session.highWaterOffsetMs) {
        session.highWaterOffsetMs = precise.positionMs
      }
      return
    }
    // Uptime-based fallback — no precise signal this tick, fall back to the
    // monotonic high-water mark (clear the stale precise position).
    session.preciseOffsetMs = null
    const elapsedMs = Math.max(0, Date.now() - session.sessionStartedAt.getTime())
    const offsetMs = clampOffsetMs(elapsedMs, session.durationSeconds)
    if (offsetMs > session.highWaterOffsetMs) {
      session.highWaterOffsetMs = offsetMs
    }
    // Wall-clock has caught up to the file duration. We have no precise signal
    // to know whether the user is actually still watching, so freeze the
    // session: poll() reads this flag, emits one final 'stopped', and refuses
    // to recreate the same sessionId.
    if (
      session.durationSeconds > 0 &&
      session.highWaterOffsetMs >= session.durationSeconds * 1000
    ) {
      session.uptimeSaturated = true
    }
  }
}

function clampOffsetMs(offsetMs: number, durationSeconds: number): number {
  if (durationSeconds <= 0) {
    return offsetMs
  }
  const durationMs = durationSeconds * 1000
  return Math.min(offsetMs, durationMs)
}
