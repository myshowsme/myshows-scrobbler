/**
 * Unified Scrobble DTO — superset of Trakt + Simkl scrobble APIs,
 * extended with custom fields for MyShows analytics.
 *
 * Both Trakt and Simkl ignore unknown fields, so a single payload can be
 * sent to all three services without modification. Fields specific to MyShows
 * (sourceApp, metadata, originalTitle, dubTeam, etc.) are silently dropped
 * by Trakt/Simkl and consumed only by MyShows.
 *
 * Known type conflict:
 *   `tmdb` — Trakt expects `number`, Simkl expects `string`.
 *   Both accept either in practice; we use `string` as the safe common ground.
 */

// ── Identifiers ─────────────────────────────────────────────────────────────

/** Base IDs shared across movies, shows, and episodes. */
export interface ScrobbleIds {
  /** MyShows internal ID */
  myshow?: number
  /** Trakt internal ID */
  trakt?: number
  /** Simkl internal ID */
  simkl?: number

  /** IMDb ID ("tt…" format) — all three APIs */
  imdb?: string
  /** TMDb ID — Trakt uses number, Simkl uses string; string is accepted by all */
  tmdb?: string
  /** TVDB ID — all three APIs */
  tvdb?: string
  /** URL slug — Trakt, Simkl */
  slug?: string

  /** AniDB ID — Simkl */
  anidb?: number
  /** AniList ID — anime tracker extension */
  anilist?: number
  /** Kitsu ID — anime tracker extension */
  kitsu?: number
  /** Shikimori ID — anime tracker extension */
  shikimori?: number
  /** Kinopoisk ID — regional catalog extension */
  kinopoisk?: number
  /** Netflix ID — Simkl */
  netflix?: string
  /** TVRage ID — Trakt (legacy, service shut down) */
  tvrage?: string
}

/** Movie IDs — extends base with streaming/anime platform IDs. */
export interface ScrobbleMovieIds extends ScrobbleIds {
  /** MyAnimeList ID (anime movies) — Simkl */
  mal?: number
  /** Hulu ID — Simkl */
  hulu?: number
  /** Crunchyroll ID — Simkl */
  crunchyroll?: number
  /** Legacy alias for tmdb — Simkl */
  moviedb?: string
}

/** Show IDs — extends base with streaming/anime platform IDs. */
export interface ScrobbleShowIds extends ScrobbleIds {
  /** MyAnimeList ID — Simkl */
  mal?: number
  /** Hulu ID — Simkl */
  hulu?: number
  /** Crunchyroll ID — Simkl */
  crunchyroll?: number
  /** Zap2It (TV Listings) ID — Simkl */
  zap2It?: string
}

/** Episode IDs — base plus anime IDs that can identify OVA/special episodes. */
export interface ScrobbleEpisodeIds extends ScrobbleIds {
  /** MyAnimeList ID — Simkl/anime extension */
  mal?: number
}

// ── Media metadata (Trakt /sync/collection pattern + MyShows extensions) ────

/**
 * Media quality/format metadata.
 * Based on Trakt /sync/collection MetadataObject.
 * Trakt consumes these in collection sync; Simkl ignores them.
 * MyShows uses them for analytics.
 */

export type MediaType =
  | 'digital'
  | 'bluray'
  | 'hddvd'
  | 'dvd'
  | 'vcd'
  | 'vhs'
  | 'betamax'
  | 'laserdisc'

export type Resolution =
  | 'uhd_4k'
  | 'hd_1080p'
  | 'hd_1080i'
  | 'hd_720p'
  | 'sd_480p'
  | 'sd_480i'
  | 'sd_576p'
  | 'sd_576i'

export type HDR = 'dolby_vision' | 'hdr10' | 'hdr10_plus' | 'hlg'

export type AudioCodec =
  | 'lpcm'
  | 'mp3'
  | 'mp2'
  | 'aac'
  | 'ogg'
  | 'ogg_opus'
  | 'wma'
  | 'flac'
  | 'dts'
  | 'dts_ma'
  | 'dts_hr'
  | 'dts_x'
  | 'auro_3d'
  | 'dolby_digital'
  | 'dolby_digital_plus'
  | 'dolby_digital_plus_atmos'
  | 'dolby_atmos'
  | 'dolby_truehd'
  | 'dolby_prologic'

export type AudioChannels =
  | '1.0'
  | '2.0'
  | '2.1'
  | '3.0'
  | '3.1'
  | '4.0'
  | '4.1'
  | '5.0'
  | '5.1'
  | '5.1.2'
  | '5.1.4'
  | '6.1'
  | '7.1'
  | '7.1.2'
  | '7.1.4'
  | '9.1'
  | '10.1'

export interface ScrobbleMetadata {
  'media_type'?: MediaType
  'resolution'?: Resolution
  'hdr'?: HDR
  'audio'?: AudioCodec
  'audio_channels'?: AudioChannels
  /** Audio language of the played track (ISO 639-1, e.g. "ru", "en", "ja") — MyShows */
  'audio_language'?: string
  '3d'?: boolean
}

// ── Media objects ───────────────────────────────────────────────────────────

export interface ScrobbleMovie {
  title?: string
  /** Original title (e.g. Japanese for anime, local language) — MyShows */
  original_title?: string
  year?: number
  ids: ScrobbleMovieIds
  /** Runtime in minutes — MyShows analytics */
  runtime?: number
  /** Age rating (e.g. "PG-13", "R", "18+") — MyShows */
  content_rating?: string
  /** Media quality metadata — Trakt (collection), MyShows (analytics) */
  metadata?: ScrobbleMetadata
}

export interface ScrobbleShow {
  title?: string
  /** Original title — MyShows */
  original_title?: string
  year?: number
  ids: ScrobbleShowIds
  /** Age rating — MyShows */
  content_rating?: string
}

export interface ScrobbleEpisode {
  /** Season number */
  season?: number
  /** Episode number within the season */
  number?: number
  title?: string
  ids?: ScrobbleEpisodeIds
  /** Episode runtime in minutes — MyShows analytics */
  runtime?: number
  /** Media quality metadata — Trakt (collection), MyShows (analytics) */
  metadata?: ScrobbleMetadata
}

// ── Request DTOs ────────────────────────────────────────────────────────────

/** Fields shared across all scrobble request variants. */
interface ScrobbleRequestBase {
  /** Playback progress in percent (0.0–100.0) */
  progress: number
  /** Client app version (recommended by Trakt, Simkl) */
  app_version?: string
  /** Client build date YYYY-MM-DD (recommended by Trakt, Simkl) */
  app_date?: string
  /** Playback source application — MyShows analytics (e.g. "plex", "kodi", "browser", "lampa") */
  source_app?: string
  /** Dub/voiceover team name (e.g. "AniLibria", "Studio Band") — MyShows */
  dub_team?: string
  /** User rating (1–10). Typically sent with /scrobble/stop after finishing playback — MyShows */
  rating?: number
}

export interface ScrobbleMovieRequest extends ScrobbleRequestBase {
  movie: ScrobbleMovie
}

export interface ScrobbleEpisodeRequest extends ScrobbleRequestBase {
  show: ScrobbleShow
  episode: ScrobbleEpisode
}

export type ScrobbleRequest = ScrobbleMovieRequest | ScrobbleEpisodeRequest

// ── Response DTOs ───────────────────────────────────────────────────────────

export type ScrobbleAction = 'start' | 'pause' | 'scrobble' | 'checkin'

interface ScrobbleResponseBase {
  /**
   * Playback record ID.
   * Trakt: always present. Simkl /scrobble/start always returns 0;
   * real IDs come from pause/stop responses.
   */
  id: number
  /** Action the server registered */
  action: ScrobbleAction
  /** Registered progress percent */
  progress: number
  /** When the item was marked as watched (ISO8601) — Trakt & Simkl (on action=scrobble) */
  watched_at?: string
  /** Session expiry (ISO8601) — Simkl only */
  expires_at?: string
  /** Social sharing flags — Trakt only */
  sharing?: { twitter?: boolean; tumblr?: boolean }
}

export interface ScrobbleMovieResponse extends ScrobbleResponseBase {
  movie: ScrobbleMovie
}

export interface ScrobbleEpisodeResponse extends ScrobbleResponseBase {
  show: ScrobbleShow
  episode: ScrobbleEpisode
}

export type ScrobbleResponse = ScrobbleMovieResponse | ScrobbleEpisodeResponse

// ── Sync History (Simkl alternative for batch import) ───────────────────────

export interface SyncHistoryRequest {
  movies?: Array<ScrobbleMovie & { watched_at?: string }>
  shows?: Array<ScrobbleShow & { seasons?: SyncSeason[] }>
  episodes?: Array<ScrobbleEpisode & { watched_at?: string }>
}

export interface SyncSeason {
  number: number
  episodes?: Array<{ number: number; watched_at?: string }>
}

export interface SyncHistoryResponse {
  added: { movies: number; shows: number; episodes: number }
  not_found: {
    movies: ScrobbleMovie[]
    shows: ScrobbleShow[]
    episodes: ScrobbleEpisode[]
  }
}
