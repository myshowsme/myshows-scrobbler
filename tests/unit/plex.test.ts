import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test'
import { PlexAdapter } from '../../src/adapters/plex.js'
import type { SourceConfig, NormalizedEvent } from '../../src/types.js'

function makeAdapter(emitted: NormalizedEvent[], userFilter: string[] = []): PlexAdapter {
  const config: SourceConfig = {
    type: 'plex',
    enabled: true,
    url: 'http://localhost:32400',
    token: 't',
    pollInterval: 5000,
    userFilter,
  }
  return new PlexAdapter(config, {
    onScrobble: async (e) => {
      emitted.push(e)
    },
    onLog: () => {},
  })
}

function sessionsResponse(metadata: unknown[]): Response {
  return new Response(JSON.stringify({ MediaContainer: { Metadata: metadata } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function metadataResponse(metadata: unknown[] = []): Response {
  return new Response(JSON.stringify({ MediaContainer: { Metadata: metadata } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const episodeSession = {
  sessionKey: 'k1',
  ratingKey: '42',
  grandparentRatingKey: '10',
  type: 'episode',
  title: 'Pilot',
  grandparentTitle: 'Breaking Bad',
  parentIndex: 1,
  index: 1,
  year: 2008,
  duration: 2820000,
  viewOffset: 100000,
  Guid: [{ id: 'imdb://tt0959621' }, { id: 'tmdb://62085' }],
  Player: { state: 'playing' },
}

/** Route fetch mock by URL pattern instead of call order. */
function routedFetch(routes: Record<string, () => Response>): typeof fetch {
  return ((url: string) => {
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return Promise.resolve(handler())
      }
    }
    return Promise.resolve(new Response('{}', { status: 404 }))
  }) as typeof fetch
}

describe('PlexAdapter polling diff', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function tick(adapter: PlexAdapter): Promise<void> {
    // Use the private poll via access — cast to any to reach the protected member.
    await (adapter as unknown as { poll(): Promise<void> }).poll()
  }

  it('emits progress for every new session on the first tick', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = makeAdapter(emitted)
    ;(adapter as unknown as { running: boolean }).running = true

    vi.stubGlobal(
      'fetch',
      routedFetch({
        '/status/sessions': () => sessionsResponse([episodeSession]),
        '/library/metadata/10': () =>
          metadataResponse([{ Guid: [{ id: 'imdb://tt0959621' }], originalTitle: 'BB' }]),
        '/library/metadata/42': () => metadataResponse([{ Guid: [{ id: 'imdb://tt0959622' }] }]),
      }),
    )

    await tick(adapter)

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      action: 'progress',
      sessionId: 'k1',
      state: 'playing',
      type: 'episode',
      imdbId: 'tt0959621',
      title: 'Pilot',
      showTitle: 'Breaking Bad',
      season: 1,
      episode: 1,
      source: 'plex',
    })
  })

  it('ignores non-video sessions (music track, clip, photo)', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = makeAdapter(emitted)
    ;(adapter as unknown as { running: boolean }).running = true

    const trackSession = {
      ...episodeSession,
      sessionKey: 'music1',
      type: 'track',
      title: 'Some Song',
      grandparentTitle: 'Some Artist',
    }

    vi.stubGlobal(
      'fetch',
      routedFetch({
        '/status/sessions': () => sessionsResponse([trackSession]),
      }),
    )

    await tick(adapter)

    expect(emitted).toHaveLength(0)
  })

  it('drops sessions of other users when a hidden user_filter is set', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = makeAdapter(emitted, ['JuFrolov'])
    ;(adapter as unknown as { running: boolean }).running = true

    const mine = { ...episodeSession, sessionKey: 'mine', User: { id: '1', title: 'JuFrolov' } }
    const theirs = {
      ...episodeSession,
      sessionKey: 'theirs',
      ratingKey: '99',
      grandparentRatingKey: '11',
      User: { id: '2', title: 'SomeoneElse' },
    }

    vi.stubGlobal(
      'fetch',
      routedFetch({
        '/status/sessions': () => sessionsResponse([mine, theirs]),
        '/library/metadata/10': () => metadataResponse([{ Guid: [{ id: 'imdb://tt0959621' }] }]),
        '/library/metadata/42': () => metadataResponse([{ Guid: [] }]),
      }),
    )

    await tick(adapter)

    expect(emitted).toHaveLength(1)
    expect(emitted[0].sessionId).toBe('mine')
  })

  it('emits another progress when viewOffset advances', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = makeAdapter(emitted)
    ;(adapter as unknown as { running: boolean }).running = true

    let tick1 = true
    vi.stubGlobal(
      'fetch',
      routedFetch({
        '/status/sessions': () => {
          const session = tick1 ? episodeSession : { ...episodeSession, viewOffset: 150000 }
          tick1 = false
          return sessionsResponse([session])
        },
        '/library/metadata/10': () => metadataResponse([{ Guid: [{ id: 'imdb://tt0959621' }] }]),
        '/library/metadata/42': () => metadataResponse([{ Guid: [] }]),
      }),
    )

    await tick(adapter)
    await tick(adapter)

    expect(emitted).toHaveLength(2)
    expect(emitted[0].viewOffset).toBe(100000)
    expect(emitted[1].viewOffset).toBe(150000)
    expect(emitted.every((e) => e.action === 'progress')).toBe(true)
  })

  it('does NOT re-emit when nothing changed between ticks', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = makeAdapter(emitted)
    ;(adapter as unknown as { running: boolean }).running = true

    vi.stubGlobal(
      'fetch',
      routedFetch({
        '/status/sessions': () => sessionsResponse([episodeSession]),
        '/library/metadata/10': () => metadataResponse([{ Guid: [{ id: 'imdb://tt0959621' }] }]),
        '/library/metadata/42': () => metadataResponse([{ Guid: [] }]),
      }),
    )

    await tick(adapter)
    await tick(adapter)

    expect(emitted).toHaveLength(1)
  })

  it('emits a progress with state=paused when the player flips to paused', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = makeAdapter(emitted)
    ;(adapter as unknown as { running: boolean }).running = true

    let tick1 = true
    vi.stubGlobal(
      'fetch',
      routedFetch({
        '/status/sessions': () => {
          const session = tick1
            ? episodeSession
            : { ...episodeSession, Player: { state: 'paused' } }
          tick1 = false
          return sessionsResponse([session])
        },
        '/library/metadata/10': () => metadataResponse([{ Guid: [{ id: 'imdb://tt0959621' }] }]),
        '/library/metadata/42': () => metadataResponse([{ Guid: [] }]),
      }),
    )

    await tick(adapter)
    await tick(adapter)

    expect(emitted).toHaveLength(2)
    expect(emitted[0].state).toBe('playing')
    expect(emitted[1].state).toBe('paused')
  })

  it('emits a stopped event when a session disappears', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = makeAdapter(emitted)
    ;(adapter as unknown as { running: boolean }).running = true

    let tick1 = true
    vi.stubGlobal(
      'fetch',
      routedFetch({
        '/status/sessions': () => {
          const sessions = tick1 ? [episodeSession] : []
          tick1 = false
          return sessionsResponse(sessions)
        },
        '/library/metadata/10': () => metadataResponse([{ Guid: [{ id: 'imdb://tt0959621' }] }]),
        '/library/metadata/42': () =>
          metadataResponse([
            {
              userRating: 8,
              Guid: [{ id: 'imdb://tt0959622' }, { id: 'tvdb://349232' }],
            },
          ]),
      }),
    )

    await tick(adapter)
    await tick(adapter)

    expect(emitted).toHaveLength(2)
    expect(emitted[0]).toMatchObject({ action: 'progress' })
    expect(emitted[1]).toMatchObject({
      action: 'stopped',
      sessionId: 'k1',
      userRating: 8,
      imdbId: 'tt0959621',
      episodeImdbId: 'tt0959622',
      episodeTvdbId: '349232',
    })
  })

  it('hydrates movie IDs from /library/metadata when /status/sessions omits Guid[]', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = makeAdapter(emitted)
    ;(adapter as unknown as { running: boolean }).running = true

    // `/status/sessions` does not honour includeGuids=1 for movies — only the
    // top-level `plex://movie/...` guid comes back. External IDs must be fetched
    // separately from /library/metadata/{ratingKey}.
    const movieSession = {
      sessionKey: 'mk1',
      ratingKey: '8115',
      type: 'movie',
      title: 'Достать ножи',
      originalTitle: 'Knives Out',
      year: 2019,
      duration: 7813344,
      viewOffset: 100000,
      Player: { state: 'playing' },
      // Note: no Guid[] here — mirrors real Plex behaviour.
    }

    let metadataCalls = 0
    let tick1 = true
    vi.stubGlobal(
      'fetch',
      routedFetch({
        '/status/sessions': () => {
          // Advance viewOffset on the second tick to force the "changed" branch.
          const session = tick1 ? movieSession : { ...movieSession, viewOffset: 200000 }
          tick1 = false
          return sessionsResponse([session])
        },
        '/library/metadata/8115': () => {
          metadataCalls += 1
          return metadataResponse([
            {
              Guid: [{ id: 'imdb://tt8946378' }, { id: 'tmdb://546554' }, { id: 'tvdb://35214' }],
            },
          ])
        },
      }),
    )

    await tick(adapter)
    await tick(adapter)

    expect(emitted).toHaveLength(2)
    expect(emitted[0]).toMatchObject({
      action: 'progress',
      type: 'movie',
      imdbId: 'tt8946378',
      tmdbId: '546554',
      tvdbId: '35214',
      ids: { imdb: 'tt8946378', tmdb: '546554', tvdb: '35214' },
    })
    expect(emitted[1]).toMatchObject({
      action: 'progress',
      type: 'movie',
      imdbId: 'tt8946378',
      viewOffset: 200000,
    })
    // Cache must short-circuit the second lookup — only one metadata fetch total.
    expect(metadataCalls).toBe(1)
  })

  it('resetState clears previousSessions on stop so the next start is a fresh snapshot', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = makeAdapter(emitted)
    ;(adapter as unknown as { running: boolean }).running = true

    vi.stubGlobal(
      'fetch',
      routedFetch({
        '/status/sessions': () => sessionsResponse([episodeSession]),
        '/library/metadata/10': () => metadataResponse([{ Guid: [{ id: 'imdb://tt0959621' }] }]),
        '/library/metadata/42': () => metadataResponse([{ Guid: [] }]),
      }),
    )

    await tick(adapter)
    expect(emitted).toHaveLength(1)

    adapter.stop()

    ;(adapter as unknown as { running: boolean }).running = true
    await tick(adapter)

    // Same session again — should emit again because previousSessions was cleared.
    expect(emitted).toHaveLength(2)
  })
})
