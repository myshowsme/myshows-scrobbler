import type { NormalizedEvent, SourceType } from '../types.js'
import type { StremioLibItem, StremioLibItemState } from './stremio-api.js'
import { msToRuntimeMinutes } from './time.js'
import { BaseAdapter } from './base.js'
import { datastoreMeta, datastoreGet } from './stremio-api.js'

const VIDEO_ID_RE = /^(tt\d+):(\d+):(\d+)$/

// API returns the video id as snake_case `video_id`; some clients use camelCase.
function videoIdOf(state: StremioLibItemState): string | undefined {
  return state.video_id ?? state.videoId
}

/**
 * Per-video suffix for the sessionId. Falls back to season/episode when there's
 * no video id, so two episodes of the same show don't share a session key.
 */
function sessionSuffix(
  state: StremioLibItemState,
  parsed: { season: number | null; episode: number | null },
): string {
  const vid = videoIdOf(state)
  if (vid) {
    return vid
  }
  if (parsed.season != null && parsed.episode != null) {
    return `s${parsed.season}e${parsed.episode}`
  }
  return ''
}

export function parseStremioId(item: StremioLibItem): {
  type: 'movie' | 'episode'
  imdbId: string | null
  season: number | null
  episode: number | null
} {
  const imdbFromId = item._id.startsWith('tt') ? item._id : null

  if (item.type !== 'series') {
    return { type: 'movie', imdbId: imdbFromId, season: null, episode: null }
  }

  const vid = videoIdOf(item.state)
  const m = vid ? VIDEO_ID_RE.exec(vid) : null
  if (m) {
    return {
      type: 'episode',
      imdbId: m[1],
      season: Number.parseInt(m[2], 10),
      episode: Number.parseInt(m[3], 10),
    }
  }

  return {
    type: 'episode',
    imdbId: imdbFromId,
    season: item.state.season ?? null,
    episode: item.state.episode ?? null,
  }
}

export function buildEventFromLibItem(item: StremioLibItem): NormalizedEvent | null {
  const parsed = parseStremioId(item)
  if (!parsed.imdbId) {
    return null
  }
  const duration = item.state.duration ?? null
  if (!duration) {
    return null
  }
  // Report the real position and ignore Stremio's watched flag (it can be set
  // manually or mid-watch). The threshold downstream decides what counts as
  // watched, and a finished title sits near the end anyway.
  const viewOffset = item.state.timeOffset ?? null

  // Stremio gives `year` as a string, often "" — coerce to a positive number or null.
  const yearNum = Number.parseInt(String(item.year ?? ''), 10)
  const year = Number.isFinite(yearNum) && yearNum > 0 ? yearNum : null

  return {
    type: parsed.type,
    sessionId: `stremio:${item._id}:${sessionSuffix(item.state, parsed)}`,
    ids: { imdb: parsed.imdbId },
    imdbId: parsed.imdbId,
    tmdbId: null,
    tvdbId: null,
    episodeIds: {},
    episodeImdbId: null,
    episodeTmdbId: null,
    episodeTvdbId: null,
    title: item.name,
    originalTitle: null,
    year,
    showTitle: parsed.type === 'episode' ? item.name : null,
    showOriginalTitle: null,
    season: parsed.season,
    episode: parsed.episode,
    userRating: null,
    contentRating: null,
    runtimeMinutes: msToRuntimeMinutes(duration),
    duration,
    viewOffset,
    source: 'stremio',
    // Polling never sees a stop, so every emit is progress; the threshold marks watched.
    action: 'progress',
    state: 'playing',
    appVersion: null,
    media: null,
    dubTeam: null,
  }
}

function errorMessage(err: unknown): string {
  return (err as { message?: string }).message ?? 'Stremio API error'
}

export function pickChangedIds(meta: [string, number][], prev: Map<string, number>): string[] {
  const changed: string[] = []
  for (const [id, mtime] of meta) {
    const before = prev.get(id)
    if (before === undefined || mtime > before) {
      changed.push(id)
    }
  }
  return changed
}

export class StremioAdapter extends BaseAdapter {
  private lastMeta = new Map<string, number>()
  private primed = false

  get name(): SourceType {
    return 'stremio'
  }

  async checkConnection(): Promise<boolean> {
    if (!this.config.token) {
      this.setConnectionError('No Stremio authKey set')
      return false
    }
    try {
      await datastoreMeta(this.config.token)
      this.clearConnectionError()
      return true
    } catch (err) {
      this.setConnectionError(errorMessage(err))
      return false
    }
  }

  protected override resetState(): void {
    this.lastMeta.clear()
    this.primed = false
  }

  protected async poll(): Promise<void> {
    if (!this.running || !this.config.token) {
      return
    }

    let meta: [string, number][]
    try {
      meta = await datastoreMeta(this.config.token)
      this.clearConnectionError()
    } catch (err) {
      this.setConnectionError(errorMessage(err))
      return
    }

    const changed = pickChangedIds(meta, this.lastMeta)

    // First poll only sets the baseline; never scrobble the entire
    // pre-existing library.
    if (!this.primed) {
      this.primed = true
      this.lastMeta = new Map(meta)
      return
    }
    if (changed.length === 0) {
      this.lastMeta = new Map(meta)
      return
    }

    let items: StremioLibItem[]
    try {
      items = await datastoreGet(this.config.token, changed)
    } catch (err) {
      // Don't advance lastMeta: a failed fetch leaves these ids "changed", so the
      // next poll retries them instead of losing the scrobble.
      this.setConnectionError(errorMessage(err))
      return
    }

    for (const item of items) {
      // Keep `removed: true` items: Stremio marks anything you watched but didn't
      // "Add to Library" as removed, yet they still carry the watch progress.
      // buildEventFromLibItem drops the junk (no imdb id, no duration).
      const event = buildEventFromLibItem(item)
      if (event) {
        await this.emitScrobble(event)
      }
    }

    // Advance the baseline only after a clean fetch+emit pass.
    this.lastMeta = new Map(meta)
  }
}
