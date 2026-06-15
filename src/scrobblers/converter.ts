import type { NormalizedEvent, MediaInfo, ExternalIds } from '../types.js'
import type {
  ScrobbleRequest,
  ScrobbleMovieRequest,
  ScrobbleEpisodeRequest,
  ScrobbleMovieIds,
  ScrobbleShowIds,
  ScrobbleEpisodeIds,
  ScrobbleMetadata,
  Resolution,
  HDR,
  AudioCodec,
  AudioChannels,
} from './scrobble-dto.js'

/**
 * Convert a NormalizedEvent (adapter output) into a ScrobbleRequest (Unified DTO).
 * The `progress` is passed separately because it's computed in handleScrobble,
 * not stored directly in NormalizedEvent.
 */
export function toScrobbleRequest(event: NormalizedEvent, progress: number): ScrobbleRequest {
  if (event.type === 'movie') {
    return toMovieRequest(event, progress)
  }
  return toEpisodeRequest(event, progress)
}

function baseFields(event: NormalizedEvent): Record<string, unknown> {
  return {
    source_app: event.sourceApp ?? event.source,
    ...(event.appVersion ? { app_version: event.appVersion } : {}),
    ...(event.userRating != null ? { rating: event.userRating } : {}),
    ...(event.dubTeam ? { dub_team: event.dubTeam } : {}),
  }
}

function toMovieRequest(event: NormalizedEvent, progress: number): ScrobbleMovieRequest {
  const ids = toDtoIds<ScrobbleMovieIds>(event.ids)
  if (event.imdbId && !ids.imdb) {
    ids.imdb = event.imdbId
  }
  if (event.tmdbId && !ids.tmdb) {
    ids.tmdb = event.tmdbId
  }
  if (event.tvdbId && !ids.tvdb) {
    ids.tvdb = event.tvdbId
  }

  const metadata = toMetadata(event.media)

  return {
    ...baseFields(event),
    progress,
    movie: {
      title: event.title,
      ...(event.originalTitle ? { original_title: event.originalTitle } : {}),
      ...(event.year != null ? { year: event.year } : {}),
      ...(event.runtimeMinutes != null ? { runtime: event.runtimeMinutes } : {}),
      ...(event.contentRating ? { content_rating: event.contentRating } : {}),
      ids,
      ...(metadata ? { metadata } : {}),
    },
  } as ScrobbleMovieRequest
}

function toEpisodeRequest(event: NormalizedEvent, progress: number): ScrobbleEpisodeRequest {
  const showIds = toDtoIds<ScrobbleShowIds>(event.ids)
  if (event.imdbId && !showIds.imdb) {
    showIds.imdb = event.imdbId
  }
  if (event.tmdbId && !showIds.tmdb) {
    showIds.tmdb = event.tmdbId
  }
  if (event.tvdbId && !showIds.tvdb) {
    showIds.tvdb = event.tvdbId
  }

  const episodeIds = toDtoIds<ScrobbleEpisodeIds>(event.episodeIds)
  if (event.episodeImdbId && !episodeIds.imdb) {
    episodeIds.imdb = event.episodeImdbId
  }
  if (event.episodeTmdbId && !episodeIds.tmdb) {
    episodeIds.tmdb = event.episodeTmdbId
  }
  if (event.episodeTvdbId && !episodeIds.tvdb) {
    episodeIds.tvdb = event.episodeTvdbId
  }
  const metadata = toMetadata(event.media)

  return {
    ...baseFields(event),
    progress,
    show: {
      ...(event.showTitle ? { title: event.showTitle } : {}),
      ...(event.showOriginalTitle ? { original_title: event.showOriginalTitle } : {}),
      ...(event.contentRating ? { content_rating: event.contentRating } : {}),
      ids: showIds,
    },
    episode: {
      ...(event.season != null ? { season: event.season } : {}),
      ...(event.episode != null ? { number: event.episode } : {}),
      title: event.title,
      ...(Object.keys(episodeIds).length > 0 ? { ids: episodeIds } : {}),
      ...(event.runtimeMinutes != null ? { runtime: event.runtimeMinutes } : {}),
      ...(metadata ? { metadata } : {}),
    },
  } as ScrobbleEpisodeRequest
}

function toDtoIds<T extends ScrobbleMovieIds | ScrobbleShowIds | ScrobbleEpisodeIds>(
  ids: ExternalIds,
): T {
  const result: ScrobbleMovieIds | ScrobbleShowIds | ScrobbleEpisodeIds = {}

  if (ids.myshow !== undefined) {
    result.myshow = ids.myshow
  }
  if (ids.trakt !== undefined) {
    result.trakt = ids.trakt
  }
  if (ids.simkl !== undefined) {
    result.simkl = ids.simkl
  }
  if (ids.imdb) {
    result.imdb = ids.imdb
  }
  if (ids.tmdb) {
    result.tmdb = ids.tmdb
  }
  if (ids.tvdb) {
    result.tvdb = ids.tvdb
  }
  if (ids.slug) {
    result.slug = ids.slug
  }
  if (ids.anidb !== undefined) {
    result.anidb = ids.anidb
  }
  if (ids.anilist !== undefined) {
    result.anilist = ids.anilist
  }
  if (ids.kitsu !== undefined) {
    result.kitsu = ids.kitsu
  }
  if (ids.shikimori !== undefined) {
    result.shikimori = ids.shikimori
  }
  if (ids.kinopoisk !== undefined) {
    result.kinopoisk = ids.kinopoisk
  }
  if (ids.netflix) {
    result.netflix = ids.netflix
  }
  if (ids.tvrage) {
    result.tvrage = ids.tvrage
  }

  if (ids.mal !== undefined) {
    ;(result as ScrobbleMovieIds | ScrobbleShowIds).mal = ids.mal
  }
  if (ids.hulu !== undefined) {
    ;(result as ScrobbleMovieIds | ScrobbleShowIds).hulu = ids.hulu
  }
  if (ids.crunchyroll !== undefined) {
    ;(result as ScrobbleMovieIds | ScrobbleShowIds).crunchyroll = ids.crunchyroll
  }
  if (ids.moviedb) {
    ;(result as ScrobbleMovieIds).moviedb = ids.moviedb
  }
  if (ids.zap2It) {
    ;(result as ScrobbleShowIds).zap2It = ids.zap2It
  }

  return result as T
}

// ── Media info → DTO metadata mapping ──

function toMetadata(media: MediaInfo | null): ScrobbleMetadata | null {
  if (!media) {
    return null
  }

  const result: ScrobbleMetadata = {}
  let hasAny = false

  if (media.container) {
    result.media_type = 'digital'
    hasAny = true
  }

  const res = mapResolution(media.resolution)
  if (res) {
    result.resolution = res
    hasAny = true
  }

  const hdr = mapHdr(media.hdr)
  if (hdr) {
    result.hdr = hdr
    hasAny = true
  }

  const audio = mapAudioCodec(media.audioCodec)
  if (audio) {
    result.audio = audio
    hasAny = true
  }

  const channels = mapAudioChannels(media.audioChannels)
  if (channels) {
    result.audio_channels = channels
    hasAny = true
  }

  if (media.audioLanguage) {
    result.audio_language = media.audioLanguage
    hasAny = true
  }

  return hasAny ? result : null
}

function mapResolution(raw: string | null): Resolution | undefined {
  if (!raw) {
    return undefined
  }
  const map: Record<string, Resolution> = {
    '4k': 'uhd_4k',
    '2160': 'uhd_4k',
    '1080': 'hd_1080p',
    '720': 'hd_720p',
    '480': 'sd_480p',
    '576': 'sd_576p',
  }
  return map[raw.toLowerCase()]
}

function mapHdr(raw: string | null): HDR | undefined {
  if (!raw) {
    return undefined
  }
  const map: Record<string, HDR> = {
    dolby_vision: 'dolby_vision',
    hdr10: 'hdr10',
    hdr10_plus: 'hdr10_plus',
    hlg: 'hlg',
  }
  return map[raw]
}

function mapAudioCodec(raw: string | null): AudioCodec | undefined {
  if (!raw) {
    return undefined
  }
  const map: Record<string, AudioCodec> = {
    'aac': 'aac',
    'mp3': 'mp3',
    'mp2': 'mp2',
    'flac': 'flac',
    'ogg': 'ogg',
    'opus': 'ogg_opus',
    'ac3': 'dolby_digital',
    'eac3': 'dolby_digital_plus',
    'truehd': 'dolby_truehd',
    'dca': 'dts',
    'dts': 'dts',
    'dts-hd ma': 'dts_ma',
    'dts-hd hra': 'dts_hr',
    'dts:x': 'dts_x',
    'pcm': 'lpcm',
    'wma': 'wma',
  }
  return map[raw.toLowerCase()]
}

function mapAudioChannels(raw: number | null): AudioChannels | undefined {
  if (raw == null) {
    return undefined
  }
  const map: Record<number, AudioChannels> = {
    1: '1.0',
    2: '2.0',
    3: '2.1',
    6: '5.1',
    7: '6.1',
    8: '7.1',
  }
  return map[raw]
}
