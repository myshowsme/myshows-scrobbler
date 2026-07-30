import type {
  SourceType,
  NormalizedEvent,
  PlaybackState,
  MediaInfo,
  ExternalIds,
} from '../types.js'
import { BaseAdapter } from './base.js'
import { extractDubTeam } from '../utils/dub-team.js'
import { idsFromPrefixedGuids, legacyIdFields } from './external-ids.js'
import { PlexDiagnostics, defaultDiagnosticsPath, type GuidSnapshot } from './plex-diagnostics.js'
import { hdrFromText, isScrobblableType } from './media-info.js'
import { languageToIso } from '../utils/audio-track.js'
import { msToRuntimeMinutes, percentFromPosition } from './time.js'
import { fetchWithTimeout } from '../http.js'
import { normalizeBaseUrl } from '../utils/url.js'
import { applyUserFilter, type FilterableUser } from './user-filter.js'

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
  /**
   * Scalar GUIDs emitted by retired metadata agents, which never send `Guid[]`.
   * For an episode `guid` is the show id plus season/episode numbers and must not be
   * used — `grandparentGuid` is the clean show id. See external-ids.normalizeGuid.
   */
  guid?: string
  parentGuid?: string
  grandparentGuid?: string
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
      guid?: string
      parentGuid?: string
      grandparentGuid?: string
    }>
  }
}

/** Shape shared by sessions and metadata entries, for GUID reading and diagnostics. */
type GuidBearing = Pick<PlexSession, 'Guid' | 'guid' | 'parentGuid' | 'grandparentGuid'>

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
  raw?: GuidSnapshot
}

/** Cached episode-level metadata. */
interface EpisodeMeta {
  guids: PlexGuid[]
  raw?: GuidSnapshot
}

/** Cached movie-level metadata. */
interface MovieMeta {
  guids: PlexGuid[]
  raw?: GuidSnapshot
}

// ── Helpers ──

/**
 * Retired agents put the id in a scalar `guid` instead of `Guid[]`. Wrapping it in the
 * array shape lets every downstream caller stay unchanged.
 */
function scalarGuids(value: string | undefined): PlexGuid[] {
  const trimmed = value?.trim()
  return trimmed ? [{ id: trimmed }] : []
}

/** First candidate that actually carries GUIDs; `Guid[]` therefore wins over scalars. */
function firstNonEmpty(...candidates: (PlexGuid[] | undefined)[]): PlexGuid[] {
  return candidates.find((list) => list && list.length > 0) ?? []
}

/** Untouched GUID fields, kept only so the diagnostics file can show what Plex sent. */
function guidSnapshot(source: string, meta: GuidBearing | undefined): GuidSnapshot {
  return {
    source,
    Guid: (meta?.Guid ?? []).map((entry) => entry.id),
    guid: meta?.guid,
    parentGuid: meta?.parentGuid,
    grandparentGuid: meta?.grandparentGuid,
  }
}

/** Session-level GUIDs, used before the extra metadata fetches have run. */
function sessionGuids(meta: PlexSession): PlexGuid[] {
  return meta.type === 'episode'
    ? firstNonEmpty(meta.Guid, scalarGuids(meta.grandparentGuid))
    : firstNonEmpty(meta.Guid, scalarGuids(meta.guid))
}

function formatIds(ids: ExternalIds): string {
  const found = Object.entries(ids).find(([, value]) => value !== undefined)
  return found ? ` (${found[0]}: ${found[1]})` : ''
}

function formatMeta(meta: PlexSession): string {
  const ids = formatIds(idsFromPrefixedGuids(sessionGuids(meta)))
  if (meta.type === 'episode') {
    return `${meta.grandparentTitle ?? 'Show'} S${meta.parentIndex}E${meta.index} - ${meta.title}${ids}`
  }
  return `${meta.title} (${meta.year ?? '?'})${ids}`
}

function normalizeState(raw: string | undefined): PlaybackState {
  return raw === 'paused' ? 'paused' : 'playing'
}

/**
 * Map a Plex session onto the shape the hidden `user_filter` matches: Plex reports
 * the viewer as a nested `User` object with a `title` for the display name.
 */
function sessionUser(session: PlexSession): FilterableUser {
  return { id: session.User?.id, name: session.User?.title }
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
  // Empty arrays are now a real outcome (legacy libraries cache `{ guids: [] }`), so the
  // fallback chain checks length rather than nullishness.
  const guids =
    meta.type === 'episode'
      ? firstNonEmpty(showMeta?.guids, extraGuids, sessionGuids(meta))
      : firstNonEmpty(extraGuids, sessionGuids(meta))

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

  /** Null unless the hidden `diagnostics` flag is set on the source. */
  private readonly diagnostics = this.config.diagnostics
    ? new PlexDiagnostics(defaultDiagnosticsPath(), (message) => this.log('warn', message))
    : null

  /**
   * One block per title, written only when `diagnostics` is on. Collects the raw GUID
   * fields from every endpoint that contributed, next to what they parsed into, so a
   * user with a legacy library can send back a single file instead of raw API dumps.
   */
  private recordDiagnostics(
    session: PlexSession,
    event: NormalizedEvent,
    showMeta: ShowMeta | null,
    episodeMeta: EpisodeMeta | null,
    extra: GuidSnapshot | undefined,
    partFile: string | null,
  ): void {
    if (!this.diagnostics) {
      return
    }

    this.diagnostics.record({
      key: session.ratingKey,
      type: session.type,
      title: session.title,
      showTitle: session.grandparentTitle ?? null,
      season: session.parentIndex ?? null,
      episode: session.index ?? null,
      year: session.year ?? null,
      // Basename only — the directory says where someone keeps their files and adds nothing.
      file: partFile ? (partFile.split(/[\\/]/).pop() ?? null) : null,
      snapshots: [
        guidSnapshot('session (/status/sessions)', session),
        showMeta?.raw,
        episodeMeta?.raw,
        extra,
      ].filter((snapshot): snapshot is GuidSnapshot => Boolean(snapshot)),
      ids: event.ids,
      episodeIds: event.episodeIds,
    })
  }

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

          const event = sessionToEvent(
            s,
            'progress',
            showMeta,
            episodeMeta,
            movieMeta?.guids,
            undefined,
            partFile,
          )
          this.logResolvedIds(event)
          this.recordDiagnostics(s, event, showMeta, episodeMeta, movieMeta?.raw, partFile)
          await this.emitScrobble(event)
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
        const event = sessionToEvent(
          prev,
          'stopped',
          showMeta,
          episodeMeta,
          rating?.guids,
          rating?.userRating,
          partFile,
        )
        this.logResolvedIds(event)
        this.recordDiagnostics(prev, event, showMeta, episodeMeta, rating?.raw, partFile)
        await this.emitScrobble(event)

        // Clean up per-item caches for ended sessions
        this.episodeMetaCache.delete(prev.ratingKey)
        this.movieMetaCache.delete(prev.ratingKey)
      }

      this.previousSessions = new Map(sessions.map((s) => [s.sessionKey, s]))
    } catch (err) {
      this.log('error', `Poll error: ${(err as Error).message}`)
    }
  }

  /**
   * Pairs with the raw-GUID lines logged when metadata is cached, so a debug log shows
   * both what Plex sent and what it parsed into — enough to diagnose a "nothing matches"
   * report without asking the user for raw dumps.
   */
  private logResolvedIds(event: NormalizedEvent): void {
    const episode = Object.keys(event.episodeIds).length
      ? ` episode=${JSON.stringify(event.episodeIds)}`
      : ''
    this.log('debug', `Resolved ids: show=${JSON.stringify(event.ids)}${episode}`)
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
        // At show level the legacy scalar is already a clean id (`thetvdb://468006`).
        guids: firstNonEmpty(meta.Guid, scalarGuids(meta.guid)),
        originalTitle: meta.originalTitle ?? null,
        contentRating: meta.contentRating ?? null,
        raw: guidSnapshot(`/library/metadata/${gpKey} (show)`, meta),
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

      // Episode ids come from `Guid[]` only. The scalar `guid` of a legacy episode is the
      // *show* id plus season/episode numbers, so feeding it here would scrobble the wrong
      // thing — see docs/plex-legacy-guids-research.md §5.1. The asymmetry with
      // getShowMeta/getMovieMeta is deliberate.
      const episodeMeta: EpisodeMeta = {
        guids: meta?.Guid ?? [],
        raw: guidSnapshot(`/library/metadata/${ratingKey} (episode)`, meta),
      }

      // Cached even when empty: legacy libraries never return `Guid[]`, and bailing out
      // before this line re-fetched the same metadata on every poll tick.
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

      // Only the top-level item is read. `Related` and `Extras` in the same response carry
      // GUIDs of *other* titles — see docs/plex-legacy-guids-research.md §11.5.
      const movieMeta: MovieMeta = {
        guids: firstNonEmpty(meta?.Guid, scalarGuids(meta?.guid)),
        raw: guidSnapshot(`/library/metadata/${ratingKey} (movie)`, meta),
      }

      // Cached even when empty, for the same reason as getEpisodeMeta.
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

    // MyShows tracks shows/movies only. Plex `/status/sessions` also surfaces
    // music (`track`), trailers/extras (`clip`) and photos — drop anything that
    // isn't a movie or episode so a played track never scrobbles as an episode.
    const playing = sessions.filter((s) => isScrobblableType((s as { type?: string }).type))

    // Hidden `user_filter` (config-only) additionally restricts to specific viewers.
    const { admitted, droppedMessage } = applyUserFilter(
      playing,
      sessionUser,
      this.config.userFilter,
    )
    if (droppedMessage) {
      this.log('debug', droppedMessage)
    }

    return admitted.map((s) => ({
      ...s,
      ratingKey: s.ratingKey || s.key?.split('/').pop() || '',
    }))
  }

  private async fetchMetadataWithRating(ratingKey: string): Promise<{
    userRating: number | null
    guids?: PlexGuid[]
    raw?: GuidSnapshot
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
        // This is the session-end path, which produces the scrobble that actually counts —
        // it needs the legacy scalar just as much as the in-progress paths do.
        guids: firstNonEmpty(metadata.Guid, scalarGuids(metadata.guid)),
        raw: guidSnapshot(`/library/metadata/${ratingKey} (session end)`, metadata),
      }
    } catch (err) {
      this.log('error', `Metadata fetch error: ${(err as Error).message}`)
      return null
    }
  }
}
