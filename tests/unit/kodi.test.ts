import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test'
import { KodiAdapter } from '../../src/adapters/kodi.js'
import type { SourceConfig, NormalizedEvent } from '../../src/types.js'

function makeAdapter(emitted: NormalizedEvent[]): KodiAdapter {
  const config: SourceConfig = {
    type: 'kodi',
    enabled: true,
    url: 'http://localhost:8080',
    token: '',
    pollInterval: 5000,
    userFilter: [],
  }
  return new KodiAdapter(config, {
    onScrobble: async (e) => {
      emitted.push(e)
    },
    onLog: () => {},
  })
}

function rpcResponse(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function tick(adapter: KodiAdapter): Promise<void> {
  await (adapter as unknown as { poll(): Promise<void> }).poll()
}

function zeroTime() {
  return { hours: 0, minutes: 0, seconds: 0, milliseconds: 0 }
}

function timeAt(seconds: number) {
  return {
    hours: Math.floor(seconds / 3600),
    minutes: Math.floor((seconds % 3600) / 60),
    seconds: seconds % 60,
    milliseconds: 0,
  }
}

const movieItem = {
  id: 1,
  type: 'movie',
  label: 'Inception',
  title: 'Inception',
  year: 2010,
  imdbnumber: 'tt1375666',
  uniqueid: { imdb: 'tt1375666' },
}

describe('KodiAdapter polling diff', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubFirstTick(): void {
    // Each poll makes: GetActivePlayers → (per player) GetItem + GetProperties
    fetchMock
      .mockResolvedValueOnce(rpcResponse([{ playerid: 1, playertype: 'internal', type: 'video' }]))
      .mockResolvedValueOnce(rpcResponse({ item: movieItem }))
      .mockResolvedValueOnce(
        rpcResponse({
          time: timeAt(120),
          totaltime: timeAt(8880),
          percentage: 1.35,
          speed: 1,
        }),
      )
  }

  it('emits progress for the first active player', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = makeAdapter(emitted)
    ;(adapter as unknown as { running: boolean }).running = true

    stubFirstTick()
    await tick(adapter)

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      action: 'progress',
      sessionId: 'player:1:item:1',
      state: 'playing',
      type: 'movie',
      title: 'Inception',
      imdbId: 'tt1375666',
      source: 'kodi',
    })
  })

  it('enriches progress from Kodi item metadata', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = makeAdapter(emitted)
    ;(adapter as unknown as { running: boolean }).running = true

    fetchMock
      .mockResolvedValueOnce(rpcResponse([{ playerid: 1, playertype: 'internal', type: 'video' }]))
      .mockResolvedValueOnce(
        rpcResponse({
          item: {
            ...movieItem,
            imdbnumber: '467905',
            uniqueid: { imdb: 'tt4357198', tmdb: '467905' },
            mpaa: 'Rated R',
            runtime: 6328,
            file: 'F:\\Media\\How.To.Make.A.Killing.2026.WEB-DL.2160p.DD5.1.Atmos.DV.HDR-DVT.mkv',
            streamdetails: {
              video: [
                {
                  codec: 'hevc',
                  hdrtype: 'dolbyvision',
                  width: 3836,
                  height: 1604,
                },
              ],
              audio: [{ codec: 'eac3', channels: 6, language: 'eng' }],
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        rpcResponse({
          time: timeAt(120),
          totaltime: timeAt(6328),
          percentage: 1.9,
          speed: 1,
          currentaudiostream: { codec: 'ac3', channels: 6, language: 'rus' },
        }),
      )

    await tick(adapter)

    expect(emitted[0]).toMatchObject({
      imdbId: 'tt4357198',
      tmdbId: '467905',
      contentRating: 'Rated R',
      runtimeMinutes: 105,
      media: {
        resolution: '2160',
        hdr: 'dolby_vision',
        audioCodec: 'ac3',
        audioChannels: 6,
        audioLanguage: 'ru',
        container: 'mkv',
      },
      dubTeam: 'DVT',
    })
  })

  it('emits progress with state=paused when speed is 0', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = makeAdapter(emitted)
    ;(adapter as unknown as { running: boolean }).running = true

    stubFirstTick()
    // second tick: same player, paused
    fetchMock
      .mockResolvedValueOnce(rpcResponse([{ playerid: 1, playertype: 'internal', type: 'video' }]))
      .mockResolvedValueOnce(rpcResponse({ item: movieItem }))
      .mockResolvedValueOnce(
        rpcResponse({
          time: timeAt(120),
          totaltime: timeAt(8880),
          percentage: 1.35,
          speed: 0,
        }),
      )

    await tick(adapter)
    await tick(adapter)

    expect(emitted).toHaveLength(2)
    expect(emitted[0].state).toBe('playing')
    expect(emitted[1].state).toBe('paused')
  })

  it('emits a stopped event when the player disappears', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = makeAdapter(emitted)
    ;(adapter as unknown as { running: boolean }).running = true

    stubFirstTick()
    // second tick: no active players
    fetchMock.mockResolvedValueOnce(rpcResponse([]))

    await tick(adapter)
    await tick(adapter)

    // Because totaltime is zero during timeAt(0) construction, use real values from stubFirstTick
    expect(emitted).toHaveLength(2)
    expect(emitted[0].action).toBe('progress')
    expect(emitted[1].action).toBe('stopped')
    expect(emitted[1].sessionId).toBe('player:1:item:1')
    expect(emitted[1].title).toBe('Inception')
    // Ensure kodi stopped uses the last known offset
    expect(emitted[1].viewOffset).toBe(120 * 1000)
  })

  // Eliminate unused helper warning in case no test needs zero time
  void zeroTime
})
