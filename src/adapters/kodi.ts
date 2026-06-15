import type { SourceType, NormalizedEvent, PlaybackState, MediaInfo } from '../types.js'
import { extractDubTeam } from '../utils/dub-team.js'
import { BaseAdapter } from './base.js'
import { idsFromKodiUniqueIds, legacyIdFields, nonEmptyString } from './external-ids.js'
import {
  containerFromFile,
  hdrFromText,
  mediaInfoOrNull,
  resolutionFromDimensions,
} from './media-info.js'
import { mediaTimeToMs, secondsToRuntimeMinutes } from './time.js'
import { languageToIso } from '../utils/audio-track.js'
import { fetchWithTimeout } from '../http.js'

// Kodi JSON-RPC types

interface JsonRpcResponse<T = unknown> {
  id: number
  jsonrpc: string
  result?: T
  error?: { code: number; message: string }
}

interface KodiActivePlayer {
  playerid: number
  playertype: string
  type: string // 'video', 'audio', 'picture'
}

interface KodiStream {
  codec?: string
  language?: string
  channels?: number
  width?: number
  height?: number
  hdrtype?: string
  HdrType?: string
  isdefault?: boolean
  isDefault?: boolean
}

interface KodiStreamDetails {
  video?: KodiStream[]
  audio?: KodiStream[]
  subtitle?: KodiStream[]
}

interface KodiPlayerItem {
  id: number
  type: string // 'movie', 'episode', 'unknown'
  label: string
  title?: string
  originaltitle?: string
  imdbnumber?: string
  uniqueid?: Record<string, string>
  year?: number
  season?: number
  episode?: number
  showtitle?: string
  tvshowid?: number
  mpaa?: string
  runtime?: number
  userrating?: number
  file?: string
  streamdetails?: KodiStreamDetails
}

interface KodiPlayerProperties {
  time: { hours: number; minutes: number; seconds: number; milliseconds: number }
  totaltime: { hours: number; minutes: number; seconds: number; milliseconds: number }
  percentage: number
  speed?: number
  currentaudiostream?: KodiStream
  currentvideostream?: KodiStream
}

interface KodiTVShowDetails {
  label?: string
  title?: string
  originaltitle?: string
  mpaa?: string
  uniqueid?: Record<string, string>
}

interface KodiSession {
  playerId: number
  item: KodiPlayerItem
  properties: KodiPlayerProperties
  showDetails: KodiTVShowDetails | null
}

function nonZero(value: number | null | undefined): number | null {
  return value && value > 0 ? value : null
}

function normalizeType(type?: string): 'movie' | 'episode' {
  if (type === 'episode') {
    return 'episode'
  }
  return 'movie'
}

function stateFromSession(session: KodiSession): PlaybackState {
  return (session.properties.speed ?? 1) === 0 ? 'paused' : 'playing'
}

function buildSessionId(session: KodiSession): string {
  return `player:${session.playerId}:item:${session.item.id}`
}

function extractHdr(stream?: KodiStream): string | null {
  return hdrFromText(stream?.hdrtype, stream?.HdrType)
}

function extractMediaInfo(session: KodiSession): MediaInfo | null {
  const item = session.item
  const streams = item.streamdetails
  const videoStream = streams?.video?.[0] ?? session.properties.currentvideostream
  const audioStream =
    session.properties.currentaudiostream ??
    streams?.audio?.find((stream) => stream.isdefault ?? stream.isDefault) ??
    streams?.audio?.[0]

  const info: MediaInfo = {
    resolution: resolutionFromDimensions(videoStream?.width, videoStream?.height),
    hdr: extractHdr(streams?.video?.[0] ?? videoStream),
    audioCodec: nonEmptyString(audioStream?.codec),
    audioChannels: audioStream?.channels ?? null,
    // Kodi reports ISO 639-2 ("rus"); the DTO wants 639-1 ("ru").
    audioLanguage: languageToIso(audioStream?.language),
    container: containerFromFile(item.file),
  }

  return mediaInfoOrNull(info)
}

function sessionToEvent(session: KodiSession, action: 'progress' | 'stopped'): NormalizedEvent {
  const item = session.item
  const props = session.properties
  const type = normalizeType(item.type)
  const showIds = session.showDetails?.uniqueid
  const itemIds = item.uniqueid
  const ids =
    type === 'episode'
      ? idsFromKodiUniqueIds(showIds)
      : idsFromKodiUniqueIds(itemIds, item.imdbnumber)
  const episodeIds = type === 'episode' ? idsFromKodiUniqueIds(itemIds, item.imdbnumber) : null
  const legacyIds = legacyIdFields(ids)
  const legacyEpisodeIds = legacyIdFields(episodeIds ?? {})

  return {
    type,
    sessionId: buildSessionId(session),
    ids,
    imdbId: legacyIds.imdbId,
    tmdbId: legacyIds.tmdbId,
    tvdbId: legacyIds.tvdbId,
    episodeIds: episodeIds ?? {},
    episodeImdbId: legacyEpisodeIds.imdbId,
    episodeTmdbId: legacyEpisodeIds.tmdbId,
    episodeTvdbId: legacyEpisodeIds.tvdbId,
    title: item.title || item.label || '',
    originalTitle: nonEmptyString(item.originaltitle),
    year: item.year ?? null,
    showTitle:
      type === 'episode'
        ? (nonEmptyString(item.showtitle) ??
          nonEmptyString(session.showDetails?.title) ??
          nonEmptyString(session.showDetails?.label))
        : null,
    showOriginalTitle:
      type === 'episode' ? nonEmptyString(session.showDetails?.originaltitle) : null,
    season: type === 'episode' ? (item.season ?? null) : null,
    episode: type === 'episode' ? (item.episode ?? null) : null,
    userRating: nonZero(item.userrating),
    contentRating:
      type === 'episode'
        ? nonEmptyString(session.showDetails?.mpaa ?? item.mpaa)
        : nonEmptyString(item.mpaa),
    runtimeMinutes: secondsToRuntimeMinutes(item.runtime),
    duration: mediaTimeToMs(props.totaltime),
    viewOffset: mediaTimeToMs(props.time),
    source: 'kodi',
    action,
    state: stateFromSession(session),
    appVersion: null,
    media: extractMediaInfo(session),
    dubTeam: extractDubTeam(item.file),
  }
}

export class KodiAdapter extends BaseAdapter {
  private previousSessions = new Map<number, KodiSession>()

  get name(): SourceType {
    return 'kodi'
  }

  private async rpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const url = `${this.config.url}/jsonrpc`
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method,
      params: params ?? {},
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }

    if (this.config.token) {
      const encoded = Buffer.from(this.config.token).toString('base64')
      headers['Authorization'] = `Basic ${encoded}`
    }

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      throw new Error(`Kodi JSON-RPC error: ${response.status}`)
    }

    const result = (await response.json()) as JsonRpcResponse<T>
    if (result.error) {
      throw new Error(`Kodi RPC: ${result.error.message}`)
    }

    return result.result as T
  }

  async checkConnection(): Promise<boolean> {
    try {
      this.clearConnectionError()
      await this.rpc('JSONRPC.Ping')
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
  }

  protected async poll(): Promise<void> {
    if (!this.running) {
      return
    }

    try {
      const currentSessions = await this.fetchCurrentSessions()
      const currentIds = new Set(currentSessions.map((s) => s.playerId))

      this.log(
        'debug',
        `Active players: ${currentSessions.length}, previous: ${this.previousSessions.size}`,
      )

      for (const s of currentSessions) {
        const prev = this.previousSessions.get(s.playerId)
        const prevMs = prev ? mediaTimeToMs(prev.properties.time) : -1
        const curMs = mediaTimeToMs(s.properties.time)
        const changed =
          !prev || prevMs !== curMs || (prev.properties.speed ?? 1) !== (s.properties.speed ?? 1)

        if (changed) {
          await this.emitScrobble(sessionToEvent(s, 'progress'))
        }
      }

      for (const [playerId, prev] of this.previousSessions) {
        if (currentIds.has(playerId)) {
          continue
        }

        const percent = prev.properties.percentage
        this.log(
          'info',
          `Playback ended: ${prev.item.title || prev.item.label} (${percent.toFixed(1)}%)`,
        )

        await this.emitScrobble(sessionToEvent(prev, 'stopped'))
      }

      this.previousSessions = new Map(currentSessions.map((s) => [s.playerId, s]))
    } catch (err) {
      this.log('error', `Poll error: ${(err as Error).message}`)
    }
  }

  private async fetchShowDetails(tvshowid?: number): Promise<KodiTVShowDetails | null> {
    if (!tvshowid || tvshowid < 1) {
      return null
    }

    try {
      const result = await this.rpc<{ tvshowdetails: KodiTVShowDetails }>(
        'VideoLibrary.GetTVShowDetails',
        {
          tvshowid,
          properties: ['title', 'originaltitle', 'mpaa', 'uniqueid'],
        },
      )
      return result?.tvshowdetails ?? null
    } catch {
      return null
    }
  }

  private async fetchCurrentSessions(): Promise<KodiSession[]> {
    const players = await this.rpc<KodiActivePlayer[]>('Player.GetActivePlayers')
    if (!players || players.length === 0) {
      return []
    }

    const sessions: KodiSession[] = []

    for (const player of players) {
      if (player.type !== 'video') {
        continue
      }

      const itemResult = await this.rpc<{ item: KodiPlayerItem }>('Player.GetItem', {
        playerid: player.playerid,
        properties: [
          'title',
          'originaltitle',
          'imdbnumber',
          'uniqueid',
          'year',
          'season',
          'episode',
          'showtitle',
          'tvshowid',
          'mpaa',
          'runtime',
          'userrating',
          'file',
          'streamdetails',
        ],
      })

      const props = await this.rpc<KodiPlayerProperties>('Player.GetProperties', {
        playerid: player.playerid,
        properties: [
          'time',
          'totaltime',
          'percentage',
          'speed',
          'currentaudiostream',
          'currentvideostream',
        ],
      })

      if (itemResult?.item && props) {
        sessions.push({
          playerId: player.playerid,
          item: itemResult.item,
          properties: props,
          showDetails: await this.fetchShowDetails(itemResult.item.tvshowid),
        })
      }
    }

    return sessions
  }
}
