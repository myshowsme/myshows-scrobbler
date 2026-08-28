import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test'
import { PlexAdapter } from '../../src/adapters/plex.js'
import type { SourceConfig, NormalizedEvent } from '../../src/types.js'

function makeAdapter(
  emitted: NormalizedEvent[],
  userFilter: string[] = [],
  logs?: string[],
): PlexAdapter {
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
    onLog: (_level, message) => {
      logs?.push(message)
    },
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

async function tick(adapter: PlexAdapter): Promise<void> {
  // Use the private poll via access — cast to any to reach the protected member.
  await (adapter as unknown as { poll(): Promise<void> }).poll()
}

function startedAdapter(emitted: NormalizedEvent[]): PlexAdapter {
  const adapter = makeAdapter(emitted)
  ;(adapter as unknown as { running: boolean }).running = true
  return adapter
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PlexAdapter polling diff', () => {
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

  it('logs the viewers the filter turned away instead of dropping them silently', async () => {
    const emitted: NormalizedEvent[] = []
    const logs: string[] = []
    const adapter = makeAdapter(emitted, ['JuFrolov'], logs)
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

    expect(logs.some((l) => l.includes('user_filter dropped 1 session(s): SomeoneElse (2)'))).toBe(
      true,
    )
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

/**
 * Libraries built on retired metadata agents never send `Guid[]`; the id arrives in the
 * scalar `guid` / `grandparentGuid` attributes instead.
 */
describe('PlexAdapter legacy agent libraries', () => {
  const SHOW_GUID = 'com.plexapp.agents.thetvdb://468006?lang=en'
  const EPISODE_GUID = 'com.plexapp.agents.thetvdb://468006/1/1?lang=en'
  const MOVIE_GUID = 'com.plexapp.agents.imdb://tt29768334?lang=en'

  const legacyEpisodeSession = {
    sessionKey: 'k-legacy',
    ratingKey: '60239',
    grandparentRatingKey: '60237',
    type: 'episode',
    title: 'Episode 1',
    grandparentTitle: 'Agent Kim Reactivated',
    parentIndex: 1,
    index: 1,
    year: 2026,
    duration: 4073770,
    viewOffset: 100000,
    guid: EPISODE_GUID,
    grandparentGuid: SHOW_GUID,
    Player: { state: 'playing' },
  }

  const legacyMovieSession = {
    sessionKey: 'k-movie',
    ratingKey: '59121',
    type: 'movie',
    title: 'Train Dreams',
    year: 2025,
    duration: 6220291,
    viewOffset: 100000,
    Player: { state: 'playing' },
  }

  it('takes the show id from the scalar GUID and leaves episode ids empty', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = startedAdapter(emitted)

    vi.stubGlobal(
      'fetch',
      routedFetch({
        '/status/sessions': () => sessionsResponse([legacyEpisodeSession]),
        '/library/metadata/60237': () =>
          metadataResponse([{ guid: SHOW_GUID, title: 'Agent Kim Reactivated' }]),
        '/library/metadata/60239': () => metadataResponse([{ guid: EPISODE_GUID }]),
      }),
    )

    await tick(adapter)

    expect(emitted[0]).toMatchObject({
      type: 'episode',
      ids: { tvdb: '468006' },
      tvdbId: '468006',
      season: 1,
      episode: 1,
    })
    // The episode's own GUID carries the *show* id plus S/E numbers, so it must not leak
    // into episode ids — that would scrobble the wrong thing.
    expect(emitted[0]?.episodeIds).toEqual({})
    expect(emitted[0]?.episodeTvdbId).toBeNull()
  })

  it('falls back to grandparentGuid when the show metadata fetch fails', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = startedAdapter(emitted)

    vi.stubGlobal(
      'fetch',
      routedFetch({
        '/status/sessions': () => sessionsResponse([legacyEpisodeSession]),
        // No route for /library/metadata — both extra fetches 404.
      }),
    )

    await tick(adapter)

    expect(emitted[0]).toMatchObject({ ids: { tvdb: '468006' } })
  })

  it('reads the scalar GUID for movies', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = startedAdapter(emitted)

    vi.stubGlobal(
      'fetch',
      routedFetch({
        '/status/sessions': () => sessionsResponse([legacyMovieSession]),
        '/library/metadata/59121': () => metadataResponse([{ guid: MOVIE_GUID }]),
      }),
    )

    await tick(adapter)

    expect(emitted[0]).toMatchObject({ type: 'movie', ids: { imdb: 'tt29768334' } })
  })

  it('ignores GUIDs of neighbouring titles in Related/Extras', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = startedAdapter(emitted)

    vi.stubGlobal(
      'fetch',
      routedFetch({
        '/status/sessions': () => sessionsResponse([legacyMovieSession]),
        '/library/metadata/59121': () =>
          metadataResponse([
            {
              guid: MOVIE_GUID,
              // A real Plex response embeds other movies here, each with a valid legacy GUID.
              Related: [{ Video: [{ guid: 'com.plexapp.agents.imdb://tt31193180?lang=en' }] }],
              Extras: [{ Video: [{ guid: 'iva://api.internetvideoarchive.com/2.0/x?lang=en' }] }],
            },
          ]),
      }),
    )

    await tick(adapter)

    expect(emitted[0]?.ids).toEqual({ imdb: 'tt29768334' })
  })

  it('keeps the modern GUID array in front of the scalar one', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = startedAdapter(emitted)

    vi.stubGlobal(
      'fetch',
      routedFetch({
        '/status/sessions': () => sessionsResponse([legacyMovieSession]),
        '/library/metadata/59121': () =>
          metadataResponse([{ Guid: [{ id: 'imdb://tt0000001' }], guid: MOVIE_GUID }]),
      }),
    )

    await tick(adapter)

    expect(emitted[0]?.ids).toEqual({ imdb: 'tt0000001' })
  })

  it('sends the id on the session-end scrobble too', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = startedAdapter(emitted)

    let sessions: unknown[] = [legacyMovieSession]
    vi.stubGlobal(
      'fetch',
      routedFetch({
        '/status/sessions': () => sessionsResponse(sessions),
        '/library/metadata/59121': () => metadataResponse([{ guid: MOVIE_GUID }]),
      }),
    )

    await tick(adapter)
    sessions = []
    await tick(adapter)

    const stopped = emitted.find((e) => e.action === 'stopped')
    expect(stopped).toMatchObject({ ids: { imdb: 'tt29768334' } })
  })

  it('keeps the show id on the session-end scrobble when show metadata is unavailable', async () => {
    // Show metadata fails on both ticks, but the episode's own metadata succeeds. The
    // episode scalar carries the show id plus S/E numbers (or a `local://` id under HAMA),
    // so it must not shadow `grandparentGuid` on the stop path.
    for (const episodeGuid of [EPISODE_GUID, 'local://60239']) {
      const emitted: NormalizedEvent[] = []
      const adapter = startedAdapter(emitted)

      let sessions: unknown[] = [{ ...legacyEpisodeSession, guid: episodeGuid }]
      vi.stubGlobal(
        'fetch',
        routedFetch({
          '/status/sessions': () => sessionsResponse(sessions),
          '/library/metadata/60239': () => metadataResponse([{ guid: episodeGuid }]),
          // No route for /library/metadata/60237 — show metadata 404s.
        }),
      )

      await tick(adapter)
      sessions = []
      await tick(adapter)

      const stopped = emitted.find((e) => e.action === 'stopped')
      expect(stopped).toMatchObject({ ids: { tvdb: '468006' }, tvdbId: '468006' })
      expect(stopped?.episodeIds).toEqual({})
    }
  })

  it('retries instead of caching when the metadata container is empty', async () => {
    // A 200 with no `Metadata` is Plex mid-scan/refresh, not a legacy library. Pinning
    // `{ guids: [] }` for the session would strip ids from every later scrobble.
    const emitted: NormalizedEvent[] = []
    const adapter = startedAdapter(emitted)

    let movieFetches = 0
    let viewOffset = 100000
    vi.stubGlobal('fetch', ((url: string) => {
      if (url.includes('/status/sessions')) {
        viewOffset += 50000
        return Promise.resolve(sessionsResponse([{ ...legacyMovieSession, viewOffset }]))
      }
      if (url.includes('/library/metadata/59121')) {
        movieFetches += 1
        return Promise.resolve(
          movieFetches === 1 ? metadataResponse([]) : metadataResponse([{ guid: MOVIE_GUID }]),
        )
      }
      return Promise.resolve(new Response('{}', { status: 404 }))
    }) as typeof fetch)

    await tick(adapter)
    await tick(adapter)
    await tick(adapter)

    expect(emitted.map((e) => e.ids)).toEqual([{}, { imdb: 'tt29768334' }, { imdb: 'tt29768334' }])
    // First response was empty and not cached; second was cached.
    expect(movieFetches).toBe(2)
  })

  it('caches metadata for legacy items instead of refetching on every tick', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = startedAdapter(emitted)

    const calls: string[] = []
    let viewOffset = 100000
    vi.stubGlobal('fetch', ((url: string) => {
      calls.push(url)
      if (url.includes('/status/sessions')) {
        // The offset must move, otherwise the second tick sees no change and fetches nothing.
        viewOffset += 50000
        return Promise.resolve(sessionsResponse([{ ...legacyEpisodeSession, viewOffset }]))
      }
      if (url.includes('/library/metadata/60237')) {
        return Promise.resolve(metadataResponse([{ guid: SHOW_GUID }]))
      }
      if (url.includes('/library/metadata/60239')) {
        return Promise.resolve(metadataResponse([{ guid: EPISODE_GUID }]))
      }
      return Promise.resolve(new Response('{}', { status: 404 }))
    }) as typeof fetch)

    await tick(adapter)
    await tick(adapter)

    // Legacy items return no `Guid[]`; before the fix that empty result was never cached,
    // so this fetch repeated on every poll.
    expect(calls.filter((url) => url.includes('/library/metadata/60239'))).toHaveLength(1)
    expect(calls.filter((url) => url.includes('/library/metadata/60237'))).toHaveLength(1)
    expect(emitted).toHaveLength(2)
  })

  /**
   * Cases reported in https://github.com/myshowsme/myshows-scrobbler/issues/24 by a user
   * running the diagnostics build against a real HAMA-agent library (issue comment,
   * 2026-08-27). All of them were already handled correctly by the code above — these
   * tests pin that down so a future change can't silently regress it. HAMA is itself a
   * retired metadata agent, so it shares this suite's fixtures and setup.
   */
  describe('HAMA agent libraries', () => {
    it('resolves a HamaTV episode configured in tvdb mode (Goodbye, Lara S1E1)', async () => {
      const emitted: NormalizedEvent[] = []
      const adapter = startedAdapter(emitted)

      const session = {
        sessionKey: 'k-hama-tvdb',
        ratingKey: '60527',
        grandparentRatingKey: '60522',
        type: 'episode',
        title: 'Mermaid Princess Lara',
        grandparentTitle: 'Goodbye, Lara',
        parentIndex: 1,
        index: 1,
        duration: 1400000,
        viewOffset: 100000,
        guid: 'com.plexapp.agents.hama://tvdb-450228/1/1?lang=en',
        parentGuid: 'com.plexapp.agents.hama://tvdb-450228/1?lang=en',
        grandparentGuid: 'com.plexapp.agents.hama://tvdb-450228?lang=en',
        Player: { state: 'playing' },
      }

      vi.stubGlobal(
        'fetch',
        routedFetch({
          '/status/sessions': () => sessionsResponse([session]),
          '/library/metadata/60522': () =>
            metadataResponse([{ guid: 'com.plexapp.agents.hama://tvdb-450228?lang=en' }]),
          '/library/metadata/60527': () => metadataResponse([{}]),
        }),
      )

      await tick(adapter)

      expect(emitted[0]).toMatchObject({ ids: { tvdb: '450228' }, tvdbId: '450228' })
    })

    it('resolves the same HamaTV show configured in anidb mode instead', async () => {
      const emitted: NormalizedEvent[] = []
      const adapter = startedAdapter(emitted)

      const session = {
        sessionKey: 'k-hama-anidb',
        ratingKey: '60524',
        grandparentRatingKey: '60522',
        type: 'episode',
        title: 'Running Through Shiga',
        grandparentTitle: 'Sayonara Lara',
        parentIndex: 1,
        index: 2,
        duration: 1400000,
        viewOffset: 100000,
        guid: 'com.plexapp.agents.hama://anidb-18643/1/2?lang=en',
        parentGuid: 'com.plexapp.agents.hama://anidb-18643/1?lang=en',
        grandparentGuid: 'com.plexapp.agents.hama://anidb-18643?lang=en',
        Player: { state: 'playing' },
      }

      vi.stubGlobal(
        'fetch',
        routedFetch({
          '/status/sessions': () => sessionsResponse([session]),
          '/library/metadata/60522': () =>
            metadataResponse([{ guid: 'com.plexapp.agents.hama://anidb-18643?lang=en' }]),
          '/library/metadata/60524': () => metadataResponse([{}]),
        }),
      )

      await tick(adapter)

      expect(emitted[0]).toMatchObject({ ids: { anidb: 18643 } })
    })

    it('falls back to grandparentGuid when the episode-level guid is a meaningless local:// id (multi-season HAMA)', async () => {
      const emitted: NormalizedEvent[] = []
      const adapter = startedAdapter(emitted)

      // Real-world shape: HAMA's scanner assigns `local://` guids per-episode once a show
      // has multiple seasons; the actual provider id only survives on grandparentGuid.
      const session = {
        sessionKey: 'k-hama-local',
        ratingKey: '60293',
        grandparentRatingKey: '60291',
        type: 'episode',
        title: '2026-07-04',
        grandparentTitle: 'Mushoku Tensei: Jobless Reincarnation',
        parentIndex: 3,
        index: 1,
        duration: 1400000,
        viewOffset: 100000,
        guid: 'local://60293',
        parentGuid: 'local://60292',
        grandparentGuid: 'com.plexapp.agents.hama://tvdb-371310?lang=en',
        Player: { state: 'playing' },
      }

      vi.stubGlobal(
        'fetch',
        routedFetch({
          '/status/sessions': () => sessionsResponse([session]),
          '/library/metadata/60291': () =>
            metadataResponse([{ guid: 'com.plexapp.agents.hama://tvdb-371310?lang=en' }]),
          '/library/metadata/60293': () => metadataResponse([{}]),
        }),
      )

      await tick(adapter)

      expect(emitted[0]).toMatchObject({ ids: { tvdb: '371310' }, tvdbId: '371310' })
    })

    it('resolves a HamaMovies title in anidb mode', async () => {
      const emitted: NormalizedEvent[] = []
      const adapter = startedAdapter(emitted)

      const session = {
        sessionKey: 'k-hama-movie',
        ratingKey: '54357',
        type: 'movie',
        title: 'Gekijouban Pocket Monsters: Kimi ni Kimeta!',
        year: 2017,
        duration: 1400000,
        viewOffset: 100000,
        Player: { state: 'playing' },
        // /status/sessions never returns Guid[] for legacy movies either.
      }

      vi.stubGlobal(
        'fetch',
        routedFetch({
          '/status/sessions': () => sessionsResponse([session]),
          '/library/metadata/54357': () =>
            metadataResponse([{ guid: 'com.plexapp.agents.hama://anidb-12646?lang=en' }]),
        }),
      )

      await tick(adapter)

      expect(emitted[0]).toMatchObject({ type: 'movie', ids: { anidb: 12646 } })
    })

    it('resolves an anime movie filed under HamaTV inside a TV library (local:// episode wrapping a movie)', async () => {
      const emitted: NormalizedEvent[] = []
      const adapter = startedAdapter(emitted)

      // HAMA's popular "movie as a single-episode show" layout for TV libraries: the
      // episode's own guid is another meaningless local:// id, same fallback as above.
      const session = {
        sessionKey: 'k-hama-movie-in-tv',
        ratingKey: '60917',
        grandparentRatingKey: '60915',
        type: 'episode',
        title: 'Episode 1',
        grandparentTitle: 'Pokemon the Movie: I Choose You!',
        parentIndex: 1,
        index: 1,
        duration: 1400000,
        viewOffset: 100000,
        guid: 'local://60917',
        parentGuid: 'local://60916',
        grandparentGuid: 'com.plexapp.agents.hama://anidb-12646?lang=en',
        Player: { state: 'playing' },
      }

      vi.stubGlobal(
        'fetch',
        routedFetch({
          '/status/sessions': () => sessionsResponse([session]),
          '/library/metadata/60915': () =>
            metadataResponse([{ guid: 'com.plexapp.agents.hama://anidb-12646?lang=en' }]),
          '/library/metadata/60917': () => metadataResponse([{}]),
        }),
      )

      await tick(adapter)

      expect(emitted[0]).toMatchObject({ ids: { anidb: 12646 } })
    })
  })
})
