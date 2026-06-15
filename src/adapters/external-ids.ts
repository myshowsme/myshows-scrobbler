import type { ExternalIds } from '../types.js'

export interface PrefixedGuid {
  id?: string
}

export interface ProviderIds {
  Imdb?: string
  Tmdb?: string
  Tvdb?: string
  AniDb?: string
  AniDB?: string
  Anidb?: string
  MyAnimeList?: string
  Mal?: string
  MAL?: string
  AniList?: string
  Kitsu?: string
  Shikimori?: string
  Trakt?: string
  Simkl?: string
  Slug?: string
  Tvrage?: string
  TvRage?: string
  Netflix?: string
  Hulu?: string
  Crunchyroll?: string
  MovieDb?: string
  Zap2It?: string
  Kinopoisk?: string
}

export function nonEmptyString(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function numberId(value: string | null | undefined): number | undefined {
  const normalized = nonEmptyString(value)
  if (!normalized) {
    return undefined
  }

  const parsed = Number(normalized)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function stringId(value: string | null | undefined): string | undefined {
  return nonEmptyString(value) ?? undefined
}

function setKnownId(ids: ExternalIds, key: string, value: string | null | undefined): void {
  const normalizedKey = key.toLowerCase().replace(/[-_\s.]/g, '')

  switch (normalizedKey) {
    case 'myshow':
    case 'myshows':
      ids.myshow = numberId(value) ?? ids.myshow
      break
    case 'trakt':
      ids.trakt = numberId(value) ?? ids.trakt
      break
    case 'simkl':
      ids.simkl = numberId(value) ?? ids.simkl
      break
    case 'imdb':
      ids.imdb = stringId(value) ?? ids.imdb
      break
    case 'tmdb':
    case 'themoviedb':
      ids.tmdb = stringId(value) ?? ids.tmdb
      break
    case 'tvdb':
    case 'thetvdb':
      ids.tvdb = stringId(value) ?? ids.tvdb
      break
    case 'slug':
      ids.slug = stringId(value) ?? ids.slug
      break
    case 'anidb':
      ids.anidb = numberId(value) ?? ids.anidb
      break
    case 'mal':
    case 'myanimelist':
      ids.mal = numberId(value) ?? ids.mal
      break
    case 'anilist':
      ids.anilist = numberId(value) ?? ids.anilist
      break
    case 'kitsu':
      ids.kitsu = numberId(value) ?? ids.kitsu
      break
    case 'shikimori':
      ids.shikimori = numberId(value) ?? ids.shikimori
      break
    case 'netflix':
      ids.netflix = stringId(value) ?? ids.netflix
      break
    case 'tvrage':
      ids.tvrage = stringId(value) ?? ids.tvrage
      break
    case 'hulu':
      ids.hulu = numberId(value) ?? ids.hulu
      break
    case 'crunchyroll':
      ids.crunchyroll = numberId(value) ?? ids.crunchyroll
      break
    case 'moviedb':
      ids.moviedb = stringId(value) ?? ids.moviedb
      break
    case 'zap2it':
      ids.zap2It = stringId(value) ?? ids.zap2It
      break
    case 'kinopoisk':
    case 'kp':
      ids.kinopoisk = numberId(value) ?? ids.kinopoisk
      break
  }
}

export function legacyIdFields(ids: ExternalIds): {
  imdbId: string | null
  tmdbId: string | null
  tvdbId: string | null
} {
  return {
    imdbId: ids.imdb ?? null,
    tmdbId: ids.tmdb ?? null,
    tvdbId: ids.tvdb ?? null,
  }
}

export function extractPrefixedId(
  guids: PrefixedGuid[] | undefined,
  prefix: string,
): string | null {
  if (!Array.isArray(guids)) {
    return null
  }
  const match = guids.find((guid) => guid.id?.startsWith(prefix))
  return match ? (match.id?.replace(prefix, '') ?? null) : null
}

export function idsFromPrefixedGuids(guids: PrefixedGuid[] | undefined): ExternalIds {
  const ids: ExternalIds = {}
  if (!Array.isArray(guids)) {
    return ids
  }

  for (const guid of guids) {
    const [provider, ...rest] = guid.id?.split('://') ?? []
    if (!provider || rest.length === 0) {
      continue
    }
    setKnownId(ids, provider, rest.join('://'))
  }

  return ids
}

export function idsFromProviderIds(ids: ProviderIds | undefined): ExternalIds {
  const result: ExternalIds = {}
  if (!ids) {
    return result
  }

  for (const [key, value] of Object.entries(ids)) {
    setKnownId(result, key, value)
  }

  return result
}

export function idsFromKodiUniqueIds(
  ids: Record<string, string> | undefined,
  imdbNumber?: string,
): ExternalIds {
  const result: ExternalIds = {}
  for (const [key, value] of Object.entries(ids ?? {})) {
    setKnownId(result, key, value)
  }

  const imdbFromUniqueId = nonEmptyString(ids?.imdb)
  const imdbFromNumber = nonEmptyString(imdbNumber)
  if (!result.imdb && imdbFromUniqueId) {
    result.imdb = imdbFromUniqueId
  }
  if (!result.imdb && imdbFromNumber?.startsWith('tt')) {
    result.imdb = imdbFromNumber
  }

  return result
}
