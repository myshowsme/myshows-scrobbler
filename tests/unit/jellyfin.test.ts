import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test'
import { JellyfinAdapter } from '../../src/adapters/jellyfin.js'
import { EmbyAdapter } from '../../src/adapters/emby.js'
import type { SourceConfig, NormalizedEvent } from '../../src/types.js'
import type { BaseAdapter } from '../../src/adapters/base.js'

function makeConfig(type: 'jellyfin' | 'emby'): SourceConfig {
  return {
    type,
    enabled: true,
    url: 'http://localhost:8096',
    token: 't',
    pollInterval: 5000,
    userFilter: [],
  }
}

function sessionsResponse(sessions: unknown[]): Response {
  return new Response(JSON.stringify(sessions), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function itemResponse(item: unknown): Response {
  return new Response(JSON.stringify(item), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const baseSession = {
  Id: 'sess-1',
  UserId: 'user1',
  ApplicationVersion: '10.11.8',
  PlayState: { PositionTicks: 100_000_000, IsPaused: false },
  NowPlayingItem: {
    Id: 'item-1',
    Name: 'Inception',
    Type: 'Movie',
    OfficialRating: 'PG-13',
    ProductionYear: 2010,
    RunTimeTicks: 88_800_000_000,
    ProviderIds: { Imdb: 'tt1375666' },
    MediaSources: [
      {
        Path: 'F:\\Movies\\Inception.2010.2160p.mkv',
        Container: 'mkv',
        MediaStreams: [
          {
            Type: 'Video',
            Width: 3840,
            Height: 2160,
            VideoRange: 'HDR',
            VideoRangeType: 'DOVIWithHDR10Plus',
            VideoDoViTitle: 'Dolby Vision Profile 8.1 (HDR10)',
            Hdr10PlusPresentFlag: true,
          },
          {
            Type: 'Audio',
            Codec: 'eac3',
            Channels: 6,
            Language: 'eng',
            IsDefault: true,
          },
        ],
      },
    ],
  },
}

async function tick(adapter: BaseAdapter): Promise<void> {
  await (adapter as unknown as { poll(): Promise<void> }).poll()
}

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

describe('JellyfinAdapter polling diff', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('emits progress for a new session on the first tick', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = new JellyfinAdapter(makeConfig('jellyfin'), {
      onScrobble: async (e) => {
        emitted.push(e)
      },
      onLog: () => {},
    })
    ;(adapter as unknown as { running: boolean }).running = true

    vi.stubGlobal(
      'fetch',
      routedFetch({
        '/Sessions': () => sessionsResponse([baseSession]),
        '/Items/item-1': () => itemResponse(baseSession.NowPlayingItem),
      }),
    )

    await tick(adapter)

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      action: 'progress',
      sessionId: 'sess-1:item:item-1',
      state: 'playing',
      type: 'movie',
      title: 'Inception',
      year: 2010,
      imdbId: 'tt1375666',
      source: 'jellyfin',
      contentRating: 'PG-13',
      appVersion: '10.11.8',
      dubTeam: null,
      media: {
        resolution: '2160',
        hdr: 'dolby_vision',
        audioCodec: 'eac3',
        audioChannels: 6,
        audioLanguage: 'en',
        container: 'mkv',
      },
    })
  })

  it('ignores music (Audio) and other non-video item types', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = new JellyfinAdapter(makeConfig('jellyfin'), {
      onScrobble: async (e) => {
        emitted.push(e)
      },
      onLog: () => {},
    })
    ;(adapter as unknown as { running: boolean }).running = true

    const audioSession = {
      Id: 'sess-audio',
      UserId: 'user1',
      PlayState: { PositionTicks: 100_000_000, IsPaused: false },
      NowPlayingItem: {
        Id: 'track-1',
        Name: 'Some Song',
        Type: 'Audio',
        RunTimeTicks: 2_000_000_000,
      },
    }

    vi.stubGlobal(
      'fetch',
      routedFetch({
        '/Sessions': () => sessionsResponse([audioSession]),
        '/Items/track-1': () => itemResponse(audioSession.NowPlayingItem),
      }),
    )

    await tick(adapter)

    expect(emitted).toHaveLength(0)
  })

  it('emits a stopped event when the session disappears', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = new JellyfinAdapter(makeConfig('jellyfin'), {
      onScrobble: async (e) => {
        emitted.push(e)
      },
      onLog: () => {},
    })
    ;(adapter as unknown as { running: boolean }).running = true

    let first = true
    vi.stubGlobal('fetch', ((url: string) => {
      if (url.includes('/Sessions')) {
        if (first) {
          first = false
          return Promise.resolve(sessionsResponse([baseSession]))
        }
        return Promise.resolve(sessionsResponse([]))
      }
      if (url.includes('/Items/item-1')) {
        return Promise.resolve(itemResponse(baseSession.NowPlayingItem))
      }
      return Promise.resolve(new Response('{}', { status: 404 }))
    }) as typeof fetch)

    await tick(adapter)
    await tick(adapter)

    expect(emitted).toHaveLength(2)
    expect(emitted[1]).toMatchObject({ action: 'stopped', title: 'Inception' })
    expect(emitted[1].sessionId).toBe('sess-1:item:item-1')
  })

  it('emits progress with state=paused when IsPaused flips', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = new JellyfinAdapter(makeConfig('jellyfin'), {
      onScrobble: async (e) => {
        emitted.push(e)
      },
      onLog: () => {},
    })
    ;(adapter as unknown as { running: boolean }).running = true

    let first = true
    vi.stubGlobal('fetch', ((url: string) => {
      if (url.includes('/Sessions')) {
        const session = first
          ? baseSession
          : {
              ...baseSession,
              PlayState: { PositionTicks: 100_000_000, IsPaused: true },
            }
        first = false
        return Promise.resolve(sessionsResponse([session]))
      }
      if (url.includes('/Items/item-1')) {
        return Promise.resolve(itemResponse(baseSession.NowPlayingItem))
      }
      return Promise.resolve(new Response('{}', { status: 404 }))
    }) as typeof fetch)

    await tick(adapter)
    await tick(adapter)

    expect(emitted).toHaveLength(2)
    expect(emitted[0].state).toBe('playing')
    expect(emitted[1].state).toBe('paused')
  })

  it('enriches episode metadata with show original title and episode ids', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = new JellyfinAdapter(makeConfig('jellyfin'), {
      onScrobble: async (e) => {
        emitted.push(e)
      },
      onLog: () => {},
    })
    ;(adapter as unknown as { running: boolean }).running = true

    const episodeSession = {
      Id: 'sess-ep-1',
      UserId: 'user1',
      PlayState: { PositionTicks: 100_000_000, IsPaused: false },
      NowPlayingItem: {
        Id: 'ep-1',
        Name: 'Pilot',
        Type: 'Episode',
        SeriesName: 'Breaking Bad',
        SeriesId: 'show-1',
        ParentIndexNumber: 1,
        IndexNumber: 1,
        RunTimeTicks: 3_000_000_000,
      },
    }

    vi.stubGlobal(
      'fetch',
      routedFetch({
        '/Sessions': () => sessionsResponse([episodeSession]),
        '/Users/user1/Items/ep-1': () =>
          itemResponse({
            ...episodeSession.NowPlayingItem,
            OriginalTitle: 'Pilot Original',
            OfficialRating: 'TV-MA',
            ProviderIds: { Imdb: 'tt0959622', Tmdb: '62086', Tvdb: '349232' },
            MediaSources: [
              {
                Path: 'F:\\Shows\\Breaking.Bad\\Breaking.Bad.S01E01.2160p.AKTEP.mkv',
                Container: 'mkv',
                MediaStreams: [
                  {
                    Type: 'Video',
                    Width: 3840,
                    Height: 1600,
                    VideoRange: 'HDR',
                    VideoRangeType: 'DOVIWithHDR10Plus',
                    VideoDoViTitle: 'Dolby Vision Profile 8.1 (HDR10)',
                    Hdr10PlusPresentFlag: true,
                  },
                  {
                    Type: 'Audio',
                    Codec: 'eac3',
                    Channels: 6,
                    Language: 'rus',
                    IsDefault: true,
                  },
                ],
              },
            ],
          }),
        '/Users/user1/Items/show-1': () =>
          itemResponse({
            Id: 'show-1',
            Name: 'Breaking Bad',
            OriginalTitle: 'Breaking Bad Original',
            OfficialRating: 'TV-MA',
            ProviderIds: { Imdb: 'tt0903747', Tmdb: '1396', Tvdb: '81189' },
          }),
      }),
    )

    await tick(adapter)

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      type: 'episode',
      title: 'Pilot',
      originalTitle: 'Pilot Original',
      showTitle: 'Breaking Bad',
      showOriginalTitle: 'Breaking Bad Original',
      imdbId: 'tt0903747',
      tmdbId: '1396',
      tvdbId: '81189',
      episodeImdbId: 'tt0959622',
      episodeTmdbId: '62086',
      episodeTvdbId: '349232',
      contentRating: 'TV-MA',
      appVersion: null,
      dubTeam: 'AKTEP',
      media: {
        resolution: '2160',
        hdr: 'dolby_vision',
        audioCodec: 'eac3',
        audioChannels: 6,
        audioLanguage: 'ru',
        container: 'mkv',
      },
    })
  })
})

describe('EmbyAdapter inherits Jellyfin polling', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('emits normalized events with source=emby', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = new EmbyAdapter(makeConfig('emby'), {
      onScrobble: async (e) => {
        emitted.push(e)
      },
      onLog: () => {},
    })
    ;(adapter as unknown as { running: boolean }).running = true

    vi.stubGlobal(
      'fetch',
      routedFetch({
        '/Sessions': () => sessionsResponse([baseSession]),
        '/Items/item-1': () => itemResponse(baseSession.NowPlayingItem),
      }),
    )

    await tick(adapter)

    expect(emitted).toHaveLength(1)
    expect(emitted[0].source).toBe('emby')
    expect(emitted[0].sessionId).toBe('sess-1:item:item-1')
    expect(emitted[0].action).toBe('progress')
  })
})
