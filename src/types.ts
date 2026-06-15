// ── Media source types ──

export type SourceType =
  | 'plex'
  | 'emby'
  | 'jellyfin'
  | 'kodi'
  | 'player'
  | 'mpc'
  | 'mpv'
  | 'iina'
  | 'vlc'
/** Fixed list of supported sources. UI renders one row per entry. */
export const SOURCE_TYPES: readonly SourceType[] = [
  'plex',
  'emby',
  'jellyfin',
  'kodi',
  'player',
  'mpc',
  'mpv',
  'iina',
  'vlc',
] as const

/**
 * Source types that don't need server-side credentials. `player` auto-detects
 * from the local OS; `mpc` polls `localhost`; `mpv` and `iina` connect to a
 * local IPC socket. Each takes at most an optional URL/path override — no
 * token, no remote URL.
 */
export const LOCAL_SOURCE_TYPES: readonly SourceType[] = [
  'player',
  'mpc',
  'mpv',
  'iina',
  'vlc',
] as const

export function isLocalSource(type: SourceType): boolean {
  return (LOCAL_SOURCE_TYPES as readonly SourceType[]).includes(type)
}
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

// ── Source configuration ──

export interface SourceConfig {
  type: SourceType
  enabled: boolean
  url: string
  token: string
  pollInterval: number
  userFilter: string[]
}

// ── Application configuration ──

export interface AppConfig {
  myshowsToken: string
  myshowsUrl?: string
  scrobblePercent: number
  logLevel: LogLevel
  interceptOnly: boolean
  sources: SourceConfig[]
}

/**
 * Runtime-only config snapshot returned by `GET /api/config`.
 * Adds fields that exist only in process state (not persisted to disk).
 */
export interface AppConfigSnapshot extends AppConfig {
  /** True when the process was started with the `--intercept-only` CLI flag. */
  cliInterceptOnlyLocked: boolean
  /** Absolute path to the on-disk config file — shown in the raw config
   *  editor so the user knows which file to back up. */
  configPath: string
}

/** Categorized failure cause for source connectivity errors. */
export type SourceErrorCode = 'auth' | 'network' | 'unreachable'

// ── App auto-update (Electron) ──

/** Current update availability, surfaced to the UI. */
export interface UpdateStatus {
  /** A newer (non-skipped) version is available. */
  available: boolean
  /** The available version, or null. */
  version: string | null
  /** True while the update is being downloaded after the user opted in. */
  downloading: boolean
}

/**
 * Update actions the UI can invoke. Implemented by the Electron main process
 * (electron-updater); absent in headless mode.
 */
export interface UpdateController {
  getStatus(): UpdateStatus
  /** User opted to update: download + install (or open the release page on unsigned macOS). */
  install(): void
  /** User opted to skip this version: don't prompt for it again. */
  skip(): void
}

// ── Legacy config (for migration from v1) ──

export interface LegacyConfig {
  mode?: string
  myshows_token?: string
  plex_url?: string
  plex_token?: string
  plex_user_filter?: string[]
  scrobble_percent?: number
  poll_interval?: number
  log_level?: string
}

// ── Raw config on disk (snake_case) ──

export interface RawSourceConfig {
  type: SourceType
  enabled: boolean
  url: string
  token: string
  poll_interval: number
  user_filter: string[]
  // Legacy field, ignored on read, never written
  mode?: string
}

export interface RawConfig {
  myshows_token: string
  myshows_url?: string
  scrobble_percent: number
  log_level: string
  intercept_only?: boolean
  sources: RawSourceConfig[]
}

// ── Normalized event from any adapter ──

export type PlaybackAction = 'progress' | 'stopped'
export type PlaybackState = 'playing' | 'paused'

/** Media quality info extracted from the player/stream. */
export interface MediaInfo {
  resolution: string | null
  hdr: string | null
  audioCodec: string | null
  audioChannels: number | null
  audioLanguage: string | null
  container: string | null
}

export interface ExternalIds {
  myshow?: number
  trakt?: number
  simkl?: number
  imdb?: string
  tmdb?: string
  tvdb?: string
  slug?: string
  anidb?: number
  mal?: number
  anilist?: number
  kitsu?: number
  shikimori?: number
  netflix?: string
  tvrage?: string
  hulu?: number
  crunchyroll?: number
  moviedb?: string
  zap2It?: string
  kinopoisk?: number
}

export interface NormalizedEvent {
  type: 'movie' | 'episode'
  /** Stable playback-session identifier supplied by the source adapter. */
  sessionId: string
  /** Show/movie-level external IDs. Legacy `*Id` fields are kept during migration. */
  ids: ExternalIds
  imdbId: string | null
  tmdbId: string | null
  tvdbId: string | null
  /** Episode-level external IDs (empty for movies or when unavailable). */
  episodeIds: ExternalIds
  /** Episode-level external IDs (null for movies or when unavailable) */
  episodeImdbId: string | null
  episodeTmdbId: string | null
  episodeTvdbId: string | null
  title: string
  originalTitle: string | null
  year: number | null
  showTitle: string | null
  showOriginalTitle: string | null
  season: number | null
  episode: number | null
  userRating: number | null
  /** Content rating (e.g. "TV-MA", "PG-13") */
  contentRating: string | null
  /** Runtime in minutes */
  runtimeMinutes: number | null
  duration: number | null
  viewOffset: number | null
  source: SourceType
  /**
   * What to report to MyShows as `source_app` when it should be more specific
   * than `source`. The generic `player` source uses this to name the actual
   * player ("potplayer", "wmp") while `source` stays 'player' for routing,
   * exclusions and session keys. Converter falls back to `source` when unset.
   */
  sourceApp?: string | null
  action: PlaybackAction
  state: PlaybackState
  /** Player app version (e.g. "5.94.1") */
  appVersion: string | null
  /** Media quality/format info */
  media: MediaInfo | null
  /** Dub/voiceover team extracted from filename (e.g. "AniDUB", "TEPES") */
  dubTeam: string | null
}

// ── Now-playing snapshot (live progress broadcast to UI) ──

export interface NowPlayingEntry {
  key: string
  event: NormalizedEvent
  percent: number
  updatedAt: string
}

// ── Scrobble event (final outcome written to feed) ──

export interface ScrobbleEvent extends NormalizedEvent {
  timestamp: string
  status: 'success' | 'error' | 'skipped'
  error?: string
  /** True when this event was processed in intercept-only mode (not actually sent to MyShows). */
  intercept: boolean
}

// ── Polling log entry ──

export interface PollingLog {
  timestamp: string
  level: string
  message: string
  repeatCount?: number
}

// ── WebSocket message types ──

export type WsMessage =
  | { type: 'event'; data: ScrobbleEvent }
  | { type: 'log'; data: PollingLog }
  | { type: 'nowPlaying'; data: NowPlayingEntry[] }
  | { type: 'sourceError'; data: { source: SourceType; error: string; code: SourceErrorCode } }

// ── Adapter callback interface ──

export interface AdapterCallbacks {
  onScrobble: (event: NormalizedEvent) => Promise<void>
  onLog: (level: string, message: string) => void
}
