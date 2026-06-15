import { guessit } from 'guessit-js'

export interface ParsedFilename {
  type: 'movie' | 'episode'
  title: string | null
  originalTitle: string | null
  year: number | null
  season: number | null
  episode: number | null
}

interface GuessitRaw {
  /** guessit-js sometimes returns an array when several title candidates show up in the path. */
  title?: string | string[]
  alternative_title?: string | string[]
  type?: string
  season?: number
  episode?: number
  year?: number
  release_group?: string
}

/**
 * Coerce a guessit field that may be a string OR a list of candidates into a single string.
 * Picks the longest non-junk candidate (filters short numeric-only strings like "3" that come
 * from guessit splitting nested folder names on dashes).
 */
function pickTitle(value: string | string[] | undefined): string | null {
  if (!value) {
    return null
  }
  if (typeof value === 'string') {
    return value
  }
  const candidates = value.filter((s) => typeof s === 'string' && s.trim().length >= 3)
  if (candidates.length === 0) {
    return value[0] ?? null
  }
  // Most informative candidate = longest non-junk one.
  return candidates.reduce((a, b) => (b.length > a.length ? b : a))
}

/** guessit-js writes `season: 0` to mean "absent". Treat 0 as null. */
function normalizeSeason(value: number | undefined): number | null {
  if (value == null || value === 0) {
    return null
  }
  return value
}

function decodeIfFileUrl(input: string): string {
  if (input.startsWith('file://')) {
    try {
      return decodeURIComponent(input.replace(/^file:\/\//, ''))
    } catch {
      return input.replace(/^file:\/\//, '')
    }
  }
  return input
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const segments = normalized.split('/')
  return segments[segments.length - 1] || path
}

/**
 * Recover the episode number from the anime pattern "Show - 03 [tags]".
 * guessit drops the trailing "- NN" entirely when the tag group carries a year
 * ("Dungeon Meshi - 03 [WEB-DL 1080p 2024]" → movie/2024). Strip bracket
 * groups and the extension, then look for a dash-separated 1-3 digit number at
 * the end — 4-digit numbers are left alone so "Movie - 1984" stays a movie.
 */
function trailingEpisodeNumber(name: string): number | null {
  const stripped = name
    .replace(/\.[^.]+$/, '')
    .replace(/[[(][^\])]*[\])]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const m = /[-–—]\s*(\d{1,3})$/.exec(stripped)
  return m ? parseInt(m[1], 10) : null
}

function viaGuessit(filePath: string): ParsedFilename | null {
  try {
    const raw = guessit(filePath) as GuessitRaw
    if (!raw) {
      return null
    }
    const title = pickTitle(raw.title) ?? pickTitle(raw.alternative_title)
    if (!title) {
      return null
    }
    let season = normalizeSeason(raw.season)
    let episode = raw.episode ?? null
    if (episode == null && season == null) {
      episode = trailingEpisodeNumber(basename(filePath))
    }
    // guessit mirrors the year into `season` for date-based patterns like
    // "Show.EP01.2026" (US daily-show convention). A real season number never
    // equals a four-digit year — drop it and let the backend infer the season.
    if (season != null && season === raw.year) {
      season = null
    }
    const isEpisode = raw.type === 'episode' || episode != null || season != null
    return {
      type: isEpisode ? 'episode' : 'movie',
      title,
      // A filename has no "original title" to offer — never synthesize one
      // (gluing the release group in here used to break backend title matching).
      originalTitle: null,
      year: raw.year ?? null,
      season,
      episode,
    }
  } catch {
    return null
  }
}

const QUALITY_RE =
  /\b(1080p|720p|480p|2160p|4k|hdr|sdr|web-?dl|webrip|bluray|bdrip|hdtv|cam|ts)\b/gi

function clean(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(QUALITY_RE, '')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function viaRegex(filePath: string): ParsedFilename {
  const cleaned = clean(basename(filePath))

  const tv = /^(.*?)\s*[-.]?\s*S(\d{1,2})E(\d{1,3})/i.exec(cleaned)
  if (tv) {
    return {
      type: 'episode',
      title: tv[1].trim().replace(/\s*[-–—]\s*$/, '') || null,
      originalTitle: null,
      year: null,
      season: parseInt(tv[2], 10),
      episode: parseInt(tv[3], 10),
    }
  }

  const altTv = /^(.*?)\s*[-.]?\s*(\d{1,2})x(\d{1,3})/i.exec(cleaned)
  if (altTv) {
    return {
      type: 'episode',
      title: altTv[1].trim().replace(/\s*[-–—]\s*$/, '') || null,
      originalTitle: null,
      year: null,
      season: parseInt(altTv[2], 10),
      episode: parseInt(altTv[3], 10),
    }
  }

  const movie = /^(.+?)\s+\(?(\d{4})\)?/.exec(cleaned)
  if (movie) {
    const year = parseInt(movie[2], 10)
    const currentYear = new Date().getFullYear()
    if (year >= 1900 && year <= currentYear + 5) {
      return {
        type: 'movie',
        title: movie[1].trim().replace(/\s*[-–—]\s*$/, '') || null,
        originalTitle: null,
        year,
        season: null,
        episode: null,
      }
    }
  }

  return {
    type: 'movie',
    title: cleaned || null,
    originalTitle: null,
    year: null,
    season: null,
    episode: null,
  }
}

/**
 * Best-effort parser for media filenames. Tries guessit-js first, then a small regex fallback.
 * Used by adapters that only know the file path on disk (e.g. VLC).
 */
export function parseFilename(filePath: string): ParsedFilename {
  const decoded = decodeIfFileUrl(filePath)
  return viaGuessit(decoded) ?? viaRegex(decoded)
}
