import { describe, it, expect, vi, afterEach } from 'vite-plus/test'
import { parseStremioId, buildEventFromLibItem, pickChangedIds, StremioAdapter } from './stremio.js'
import * as api from './stremio-api.js'
import type { StremioLibItem } from './stremio-api.js'
import type { NormalizedEvent } from '../types.js'

function libItem(over: Partial<StremioLibItem> = {}): StremioLibItem {
  return {
    _id: 'tt1375666',
    name: 'Inception',
    type: 'movie',
    year: 2010,
    _mtime: 1000,
    state: { timeOffset: 600_000, duration: 1_200_000 },
    ...over,
  }
}

describe('parseStremioId', () => {
  it('maps a movie to its imdb id', () => {
    expect(parseStremioId(libItem())).toEqual({
      type: 'movie',
      imdbId: 'tt1375666',
      season: null,
      episode: null,
    })
  })

  it('parses series season/episode from videoId', () => {
    const item = libItem({
      _id: 'tt0903747',
      name: 'Breaking Bad',
      type: 'series',
      state: { videoId: 'tt0903747:2:5', timeOffset: 100, duration: 200 },
    })
    expect(parseStremioId(item)).toEqual({
      type: 'episode',
      imdbId: 'tt0903747',
      season: 2,
      episode: 5,
    })
  })

  it('parses series season/episode from snake_case video_id (live API shape)', () => {
    const item = libItem({
      _id: 'tt0903747',
      name: 'Breaking Bad',
      type: 'series',
      state: { video_id: 'tt0903747:2:5', timeOffset: 100, duration: 200 },
    })
    expect(parseStremioId(item)).toEqual({
      type: 'episode',
      imdbId: 'tt0903747',
      season: 2,
      episode: 5,
    })
  })

  it('falls back to state.season/episode when videoId is absent', () => {
    const item = libItem({
      _id: 'tt0903747',
      type: 'series',
      state: { season: 3, episode: 7, timeOffset: 1, duration: 2 },
    })
    expect(parseStremioId(item)).toEqual({
      type: 'episode',
      imdbId: 'tt0903747',
      season: 3,
      episode: 7,
    })
  })

  it('returns null imdbId for non-tt ids (local files / torrents)', () => {
    expect(parseStremioId(libItem({ _id: 'local:abc' })).imdbId).toBe(null)
  })
})

describe('buildEventFromLibItem', () => {
  it('builds a movie progress event in milliseconds', () => {
    const ev = buildEventFromLibItem(libItem())
    expect(ev).toMatchObject({
      type: 'movie',
      source: 'stremio',
      imdbId: 'tt1375666',
      ids: { imdb: 'tt1375666' },
      title: 'Inception',
      year: 2010,
      duration: 1_200_000,
      viewOffset: 600_000,
      runtimeMinutes: 20,
      action: 'progress',
      state: 'playing',
      season: null,
      episode: null,
    })
    expect(ev?.sessionId).toBe('stremio:tt1375666:')
  })

  it('builds an episode event with show title and season/episode', () => {
    const item = libItem({
      _id: 'tt0903747',
      name: 'Breaking Bad',
      type: 'series',
      state: { videoId: 'tt0903747:2:5', timeOffset: 60_000, duration: 2_700_000 },
    })
    const ev = buildEventFromLibItem(item)
    expect(ev).toMatchObject({
      type: 'episode',
      showTitle: 'Breaking Bad',
      season: 2,
      episode: 5,
      sessionId: 'stremio:tt0903747:tt0903747:2:5',
    })
  })

  it('coerces an empty-string year (Stremio shape) to null', () => {
    expect(buildEventFromLibItem(libItem({ year: '' }))?.year).toBe(null)
  })

  it('coerces a numeric-string year to a number', () => {
    expect(buildEventFromLibItem(libItem({ year: '1959' }))?.year).toBe(1959)
  })

  it('reports the real position for a flagged-watched item, not a forced 100%', () => {
    const ev = buildEventFromLibItem(
      libItem({ state: { timeOffset: 963_004, duration: 4_494_571, flaggedWatched: true } }),
    )
    // Real position, not a forced 100% from the watched flag.
    expect(ev?.viewOffset).toBe(963_004)
    expect(ev?.duration).toBe(4_494_571)
  })

  it('returns null when there is no imdb id', () => {
    expect(buildEventFromLibItem(libItem({ _id: 'local:x' }))).toBe(null)
  })

  it('returns null when duration is missing', () => {
    expect(buildEventFromLibItem(libItem({ state: { timeOffset: 1 } }))).toBe(null)
  })

  it('gives distinct sessionIds to episodes of the same show that lack a videoId', () => {
    const base = { _id: 'tt0903747', name: 'Breaking Bad', type: 'series' as const, year: 2008 }
    const e1 = buildEventFromLibItem(
      libItem({ ...base, state: { season: 1, episode: 1, timeOffset: 1, duration: 2 } }),
    )
    const e2 = buildEventFromLibItem(
      libItem({ ...base, state: { season: 1, episode: 2, timeOffset: 1, duration: 2 } }),
    )
    // Distinct keys so E2 isn't dropped as already-scrobbled after E1.
    expect(e1?.sessionId).not.toBe(e2?.sessionId)
  })
})

describe('pickChangedIds', () => {
  it('returns ids whose mtime advanced or are new', () => {
    const prev = new Map<string, number>([
      ['tt1', 1000],
      ['tt2', 2000],
    ])
    const meta: [string, number][] = [
      ['tt1', 1500],
      ['tt2', 2000],
      ['tt3', 50],
    ]
    expect(pickChangedIds(meta, prev).sort()).toEqual(['tt1', 'tt3'])
  })
})

function makeAdapter(onScrobble: (e: NormalizedEvent) => Promise<void>): StremioAdapter {
  const adapter = new StremioAdapter(
    { type: 'stremio', enabled: true, url: '', token: 'KEY', pollInterval: 1000, userFilter: [] },
    { onScrobble, onLog: () => {} },
  )
  ;(adapter as unknown as { running: boolean }).running = true
  return adapter
}

describe('StremioAdapter.poll', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('treats the first poll as a baseline and emits nothing', async () => {
    vi.spyOn(api, 'datastoreMeta').mockResolvedValue([['tt1375666', 1000]])
    const getSpy = vi.spyOn(api, 'datastoreGet')
    const events: NormalizedEvent[] = []
    const adapter = makeAdapter(async (e) => void events.push(e))
    await (adapter as unknown as { poll: () => Promise<void> }).poll()
    expect(events).toHaveLength(0)
    expect(getSpy).not.toHaveBeenCalled()
  })

  it('emits a progress event for an item whose mtime advanced after baseline', async () => {
    const metaSpy = vi.spyOn(api, 'datastoreMeta')
    metaSpy.mockResolvedValueOnce([['tt1375666', 1000]]) // baseline
    metaSpy.mockResolvedValueOnce([['tt1375666', 2000]]) // changed
    vi.spyOn(api, 'datastoreGet').mockResolvedValue([
      {
        _id: 'tt1375666',
        name: 'Inception',
        type: 'movie',
        year: 2010,
        _mtime: 2000,
        state: { timeOffset: 600_000, duration: 1_200_000 },
      },
    ])
    const events: NormalizedEvent[] = []
    const adapter = makeAdapter(async (e) => void events.push(e))
    await (adapter as unknown as { poll: () => Promise<void> }).poll() // baseline
    await (adapter as unknown as { poll: () => Promise<void> }).poll() // change
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ imdbId: 'tt1375666', source: 'stremio', action: 'progress' })
  })

  it('still scrobbles a removed item that carries real watch progress', async () => {
    // Watched-but-not-added titles come back as removed: true — must still scrobble.
    const metaSpy = vi.spyOn(api, 'datastoreMeta')
    metaSpy.mockResolvedValueOnce([['tt0051744', 1000]]) // baseline
    metaSpy.mockResolvedValueOnce([['tt0051744', 2000]]) // changed
    vi.spyOn(api, 'datastoreGet').mockResolvedValue([
      {
        _id: 'tt0051744',
        name: 'House on Haunted Hill',
        type: 'movie',
        _mtime: 2000,
        removed: true,
        state: { timeOffset: 1_101_017, duration: 4_494_571 },
      },
    ])
    const events: NormalizedEvent[] = []
    const adapter = makeAdapter(async (e) => void events.push(e))
    await (adapter as unknown as { poll: () => Promise<void> }).poll() // baseline
    await (adapter as unknown as { poll: () => Promise<void> }).poll() // change
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ imdbId: 'tt0051744', source: 'stremio' })
  })

  it('re-fetches changed ids on the next poll when datastoreGet fails', async () => {
    const metaSpy = vi.spyOn(api, 'datastoreMeta')
    metaSpy.mockResolvedValueOnce([['tt1375666', 1000]]) // baseline
    metaSpy.mockResolvedValueOnce([['tt1375666', 2000]]) // changed → get throws
    metaSpy.mockResolvedValueOnce([['tt1375666', 2000]]) // same mtime → must retry
    const getSpy = vi.spyOn(api, 'datastoreGet')
    getSpy.mockRejectedValueOnce({ status: 0, message: 'network blip' })
    getSpy.mockResolvedValueOnce([
      {
        _id: 'tt1375666',
        name: 'Inception',
        type: 'movie',
        year: 2010,
        _mtime: 2000,
        state: { timeOffset: 600_000, duration: 1_200_000 },
      },
    ])
    const events: NormalizedEvent[] = []
    const adapter = makeAdapter(async (e) => void events.push(e))
    await (adapter as unknown as { poll: () => Promise<void> }).poll() // baseline
    await (adapter as unknown as { poll: () => Promise<void> }).poll() // change → get fails
    expect(events).toHaveLength(0) // nothing committed yet
    await (adapter as unknown as { poll: () => Promise<void> }).poll() // same mtime → retried
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ imdbId: 'tt1375666', source: 'stremio' })
  })

  it('checkConnection returns false when the API rejects the key', async () => {
    vi.spyOn(api, 'datastoreMeta').mockRejectedValue({
      status: 1,
      message: 'Session does not exist',
    })
    const adapter = makeAdapter(async () => {})
    expect(await adapter.checkConnection()).toBe(false)
    expect(adapter.getLastConnectionError()).toContain('Session does not exist')
  })
})
