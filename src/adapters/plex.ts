import type { SourceType, NormalizedEvent, PlaybackState, MediaInfo } from '../types.js'
import { BaseAdapter } from './base.js'
import { extractDubTeam } from '../utils/dub-team.js'
import { extractPrefixedId, idsFromPrefixedGuids, legacyIdFields } from './external-ids.js'
import { hdrFromText } from './media-info.js'
import { languageToIso } from '../utils/audio-track.js'
import { msToRuntimeMinutes, percentFromPosition } from './time.js'
import { fetchWithTimeout } from '../http.js'
import { normalizeBaseUrl } from '../utils/url.js'

// ── Plex API response types ──

interface PlexGuid {
  id: string
}

interface PlexStream {
  streamType: number // 1=video, 2=audio, 3=subtitle
  codec?: string
  /** ISO 639-2 three-letter code (e.g. "rus", "eng", "jpn") */
  languageCode?: string
  /** ISO 639-1 two-letter code (e.g. "ru", "en", "ja") — preferred for DTO */
  languageTag?: string
  channels?: number
  audioChannelLayout?: string
  selected?: boolean
  /** Video profile for HDR detection (e.g. "dovi", "hdr10", "hlg") */
  DOVIProfile?: number
  videoProfile?: string
  displayTitle?: string
}

interface PlexMedia {
  videoResolution?: string
  audioCodec?: string
  audioChannels?: number
  container?: string
  Part?: Array<{
    Stream?: PlexStream[]
    file?: string
  }>
}

interface PlexSession {
  sessionKey: string
  ratingKey: string
  key?: string
  type: 'movie' | 'episode'
  title: string
  originalTitle?: string
  contentRating?: string
  year?: number
  grandparentTitle?: string
  grandparentRatingKey?: string
  parentIndex?: number
  index?: number
  duration: number
  viewOffset: number
  userRating?: number
  Guid?: PlexGuid[]
  Media?: PlexMedia[]
  User?: { id: string; title: string }
  Player?: { state: string; version?: string; product?: string }
}

interface PlexMetadataResponse {
  MediaContainer?: {
    Metadata?: Array<{
      title?: string
      originalTitle?: string
      contentRating?: string
      userRating?: number
      viewCount?: number
      lastRatedAt?: number
      Guid?: PlexGuid[]
    }>
  }
}

interface PlexSessionsResponse {
  MediaContainer?: {
    Metadata?: PlexSession[]
  }
}

/** Cached show-level metadata (grandparent). */
interface ShowMeta {
  guids: PlexGuid[]
  originalTitle: string | null
  contentRating: string | null
}

/** Cached episode-level metadata. */
interface EpisodeMeta {
  guids: PlexGuid[]
}

/** Cached movie-level metadata. */
interface MovieMeta {
  guids: PlexGuid[]
}

// ── Helpers ──

function formatMeta(meta: PlexSession): string {
  const imdb = extractPrefixedId(meta.Guid, 'imdb://')
  if (meta.type === 'episode') {
    return `${meta.grandparentTitle ?? 'Show'} S${meta.parentIndex}E${meta.index} - ${meta.title}${imdb ? ` (IMDB: ${imdb})` : ''}`
  }
  return `${meta.title} (${meta.year ?? '?'})${imdb ? ` (IMDB: ${imdb})` : ''}`
}

function normalizeState(raw: string | undefined): PlaybackState {
  return raw === 'paused' ? 'paused' : 'playing'
}

function extractHdr(streams: PlexStream[] | undefined): string | null {
  if (!streams) {
    return null
  }
  const videoStream = streams.find((s) => s.streamType === 1)
  if (!videoStream) {
    return null
  }

  return hdrFromText(videoStream.videoProfile)
}

function extractMediaInfo(meta: PlexSession): MediaInfo | null {
  const media = meta.Media?.[0]
  if (!media) {
    return null
  }

  const streams = media.Part?.[0]?.Stream
  const audioStream =
    streams?.find((s) => s.streamType === 2 && s.selected) ??
    streams?.find((s) => s.streamType === 2)

  return {
    resolution: media.videoResolution ?? null,
    hdr: extractHdr(streams),
    audioCodec: media.audioCodec ?? audioStream?.codec ?? null,
    audioChannels: media.audioChannels ?? audioStream?.channels ?? null,
    // Plex reports ISO 639-2 ("rus"); the DTO wants 639-1 ("ru").
    audioLanguage: languageToIso(audioStream?.languageCode),
    container: media.container ?? null,
  }
}

function sessionToEvent(
  meta: PlexSession,
  action: 'progress' | 'stopped',
  showMeta?: ShowMeta | null,
  episodeMeta?: EpisodeMeta | null,
  extraGuids?: PlexGuid[],
  extraRating?: number | null,
  partFile?: string | null,
): NormalizedEvent {
  const guids =
    meta.type === 'episode'
      ? (showMeta?.guids ?? extraGuids ?? meta.Guid)
      : (extraGuids ?? meta.Guid)

  const ids = idsFromPrefixedGuids(guids)
  const episodeIds = idsFromPrefixedGuids(episodeMeta?.guids)
  const legacyIds = legacyIdFields(ids)
  const legacyEpisodeIds = legacyIdFields(episodeIds)

  return {
    type: meta.type,
    sessionId: meta.sessionKey,
    ids,
    imdbId: legacyIds.imdbId,
    tmdbId: legacyIds.tmdbId,
    tvdbId: legacyIds.tvdbId,
    episodeIds,
    episodeImdbId: legacyEpisodeIds.imdbId,
    episodeTmdbId: legacyEpisodeIds.tmdbId,
    episodeTvdbId: legacyEpisodeIds.tvdbId,
    title: meta.title,
    originalTitle: meta.type === 'movie' ? (meta.originalTitle ?? null) : null,
    year: meta.year ?? null,
    showTitle: meta.grandparentTitle ?? null,
    showOriginalTitle:
      meta.type === 'episode' ? (showMeta?.originalTitle ?? meta.originalTitle ?? null) : null,
    season: meta.parentIndex ?? null,
    episode: meta.index ?? null,
    userRating: extraRating ?? meta.userRating ?? null,
    contentRating:
      meta.type === 'episode'
        ? (showMeta?.contentRating ?? meta.contentRating ?? null)
        : (meta.contentRating ?? null),
    runtimeMinutes: msToRuntimeMinutes(meta.duration),
    duration: meta.duration ?? null,
    viewOffset: meta.viewOffset ?? null,
    source: 'plex',
    action,
    state: normalizeState(meta.Player?.state),
    appVersion: meta.Player?.version ?? null,
    media: extractMediaInfo(meta),
    dubTeam: partFile ? extractDubTeam(partFile) : null,
  }
}

// ── Adapter ──

export class PlexAdapter extends BaseAdapter {
  private previousSessions = new Map<string, PlexSession>()
  /** Cache show metadata by grandparentRatingKey to avoid repeated fetches. */
  private showMetaCache = new Map<string, ShowMeta>()
  /** Cache episode metadata by ratingKey to avoid repeated fetches. */
  private episodeMetaCache = new Map<string, EpisodeMeta>()
  /**
   * Cache movie metadata by ratingKey. Needed because `/status/sessions` does not
   * honour `includeGuids=1` for movies — only the top-level `plex://movie/...` GUID
   * comes back, so external IDs have to be pulled from `/library/metadata/{ratingKey}`.
   */
  private movieMetaCache = new Map<string, MovieMeta>()

  get name(): SourceType {
    return 'plex'
  }

  /**
   * `fetch` rejects scheme-less URLs; users still type `127.0.0.1:32400`.
   * Normalise once — the adapter is re-created on config change, so the
   * cached value never goes stale.
   */
  private readonly baseUrl = normalizeBaseUrl(this.config.url)

  async checkConnection(): Promise<boolean> {
    try {
      this.clearConnectionError()
      await this.fetchSessions()
      return true
    } catch (err) {
      const message = (err as Error).message
      this.setConnectionError(message)
      this.log('error', `Connection check failed: ${message}`)
      return false
    }
  }

  protected override resetState(): void {
    this.previousSessions.clear()
    this.showMetaCache.clear()
    this.episodeMetaCache.clear()
    this.movieMetaCache.clear()
  }

  protected async poll(): Promise<void> {
    if (!this.running) {
      return
    }

    try {
      const sessions = await this.fetchSessions()
      const currentKeys = new Set(sessions.map((s) => s.sessionKey))

      this.log(
        'debug',
        `Active sessions: ${sessions.length}, previous: ${this.previousSessions.size}`,
      )

      for (const s of sessions) {
        const prev = this.previousSessions.get(s.sessionKey)
        const changed =
          !prev || prev.viewOffset !== s.viewOffset || prev.Player?.state !== s.Player?.state

        if (changed) {
          const label = !prev ? 'started' : s.Player?.state === 'paused' ? 'paused' : 'progress'
          this.log('debug', `${label}: ${formatMeta(s)}`)

          const showMeta = s.type === 'episode' ? await this.getShowMeta(s) : null
          const episodeMeta = s.type === 'episode' ? await this.getEpisodeMeta(s.ratingKey) : null
          const movieMeta = s.type === 'movie' ? await this.getMovieMeta(s.ratingKey) : null
          const partFile = s.Media?.[0]?.Part?.[0]?.file ?? null

          await this.emitScrobble(
            sessionToEvent(
              s,
              'progress',
              showMeta,
              episodeMeta,
              movieMeta?.guids,
              undefined,
              partFile,
            ),
          )
        }
      }

      for (const [key, prev] of this.previousSessions) {
        if (currentKeys.has(key)) {
          continue
        }

        const percent = percentFromPosition(prev.viewOffset, prev.duration)
        this.log('info', `Session ended: ${formatMeta(prev)} (${percent.toFixed(1)}%)`)

        const showMeta = prev.type === 'episode' ? await this.getShowMeta(prev) : null
        const episodeMeta =
          prev.type === 'episode' ? await this.getEpisodeMeta(prev.ratingKey) : null
        const rating = await this.fetchMetadataWithRating(prev.ratingKey)
        const partFile = prev.Media?.[0]?.Part?.[0]?.file ?? null
        await this.emitScrobble(
          sessionToEvent(
            prev,
            'stopped',
            showMeta,
            episodeMeta,
            rating?.guids,
            rating?.userRating,
            partFile,
          ),
        )

        // Clean up per-item caches for ended sessions
        this.episodeMetaCache.delete(prev.ratingKey)
        this.movieMetaCache.delete(prev.ratingKey)
      }

      this.previousSessions = new Map(sessions.map((s) => [s.sessionKey, s]))
    } catch (err) {
      this.log('error', `Poll error: ${(err as Error).message}`)
    }
  }

  /** Get show-level metadata (GUIDs + originalTitle), cached per grandparentRatingKey. */
  private async getShowMeta(session: PlexSession): Promise<ShowMeta | null> {
    const gpKey = session.grandparentRatingKey
    if (!gpKey) {
      return null
    }

    const cached = this.showMetaCache.get(gpKey)
    if (cached) {
      return cached
    }

    try {
      const url = `${this.baseUrl}/library/metadata/${gpKey}?includeGuids=1`
      const response = await fetchWithTimeout(url, {
        headers: {
          'X-Plex-Token': this.config.token,
          'Accept': 'application/json',
        },
      })

      if (!response.ok) {
        this.log('warn', `Failed to fetch show metadata for ${gpKey}: ${response.status}`)
        return null
      }

      const data = (await response.json()) as PlexMetadataResponse
      const meta = data.MediaContainer?.Metadata?.[0]
      if (!meta) {
        return null
      }

      const showMeta: ShowMeta = {
        guids: meta.Guid ?? [],
        originalTitle: meta.originalTitle ?? null,
        contentRating: meta.contentRating ?? null,
      }

      this.showMetaCache.set(gpKey, showMeta)
      this.log('debug', `Show metadata cached for "${meta.title}": ${JSON.stringify(showMeta)}`)
      return showMeta
    } catch (err) {
      this.log('error', `Show metadata fetch error: ${(err as Error).message}`)
      return null
    }
  }

  /** Get episode-level metadata (GUIDs), cached per ratingKey. */
  private async getEpisodeMeta(ratingKey: string): Promise<EpisodeMeta | null> {
    if (!ratingKey) {
      return null
    }

    const cached = this.episodeMetaCache.get(ratingKey)
    if (cached) {
      return cached
    }

    try {
      const url = `${this.baseUrl}/library/metadata/${ratingKey}?includeGuids=1`
      const response = await fetchWithTimeout(url, {
        headers: {
          'X-Plex-Token': this.config.token,
          'Accept': 'application/json',
        },
      })

      if (!response.ok) {
        this.log('warn', `Failed to fetch episode metadata for ${ratingKey}: ${response.status}`)
        return null
      }

      const data = (await response.json()) as PlexMetadataResponse
      const meta = data.MediaContainer?.Metadata?.[0]
      if (!meta?.Guid?.length) {
        return null
      }

      const episodeMeta: EpisodeMeta = { guids: meta.Guid }
      this.episodeMetaCache.set(ratingKey, episodeMeta)
      this.log(
        'debug',
        `Episode metadata cached for ${ratingKey}: ${JSON.stringify(episodeMeta.guids)}`,
      )
      return episodeMeta
    } catch (err) {
      this.log('error', `Episode metadata fetch error: ${(err as Error).message}`)
      return null
    }
  }

  /** Get movie-level metadata (GUIDs), cached per ratingKey. */
  private async getMovieMeta(ratingKey: string): Promise<MovieMeta | null> {
    if (!ratingKey) {
      return null
    }

    const cached = this.movieMetaCache.get(ratingKey)
    if (cached) {
      return cached
    }

    try {
      const url = `${this.baseUrl}/library/metadata/${ratingKey}?includeGuids=1`
      const response = await fetchWithTimeout(url, {
        headers: {
          'X-Plex-Token': this.config.token,
          'Accept': 'application/json',
        },
      })

      if (!response.ok) {
        this.log('warn', `Failed to fetch movie metadata for ${ratingKey}: ${response.status}`)
        return null
      }

      const data = (await response.json()) as PlexMetadataResponse
      const meta = data.MediaContainer?.Metadata?.[0]
      if (!meta?.Guid?.length) {
        return null
      }

      const movieMeta: MovieMeta = { guids: meta.Guid }
      this.movieMetaCache.set(ratingKey, movieMeta)
      this.log(
        'debug',
        `Movie metadata cached for ${ratingKey}: ${JSON.stringify(movieMeta.guids)}`,
      )
      return movieMeta
    } catch (err) {
      this.log('error', `Movie metadata fetch error: ${(err as Error).message}`)
      return null
    }
  }

  private async fetchSessions(): Promise<PlexSession[]> {
    const url = `${this.baseUrl}/status/sessions?includeGuids=1`
    const response = await fetchWithTimeout(url, {
      headers: {
        'X-Plex-Token': this.config.token,
        'Accept': 'application/json',
      },
    })

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Invalid Plex token (401)')
      }
      throw new Error(`Plex API error: ${response.status}`)
    }

    const data = (await response.json()) as PlexSessionsResponse
    const sessions = data.MediaContainer?.Metadata ?? []

    return sessions.map((s) => ({
      ...s,
      ratingKey: s.ratingKey || s.key?.split('/').pop() || '',
    }))
  }

  private async fetchMetadataWithRating(ratingKey: string): Promise<{
    userRating: number | null
    guids?: PlexGuid[]
  } | null> {
    try {
      const url = `${this.baseUrl}/library/metadata/${ratingKey}?includeGuids=1`
      const response = await fetchWithTimeout(url, {
        headers: {
          'X-Plex-Token': this.config.token,
          'Accept': 'application/json',
        },
      })

      if (!response.ok) {
        this.log('warn', `Failed to fetch metadata: ${response.status}`)
        return null
      }

      const data = (await response.json()) as PlexMetadataResponse
      const metadata = data.MediaContainer?.Metadata?.[0]
      if (!metadata) {
        return null
      }

      return {
        userRating: metadata.userRating ?? null,
        guids: metadata.Guid,
      }
    } catch (err) {
      this.log('error', `Metadata fetch error: ${(err as Error).message}`)
      return null
    }
  }
}
