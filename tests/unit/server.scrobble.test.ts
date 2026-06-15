import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../../src/server.js'
import { readConfig } from '../../src/config.js'
import { PlexAdapter } from '../../src/adapters/plex.js'
import { MYSHOWS_ENDPOINTS } from '../../src/scrobblers/myshows.js'
import type { NormalizedEvent } from '../../src/types.js'

let tmpDir: string
let configPath: string

function writeConfigFile(overrides: Record<string, unknown> = {}): void {
  const raw = {
    myshows_token: 'stub-token',
    myshows_url: 'https://api.myshows.me/v2/rpc/',
    scrobble_percent: 80,
    log_level: 'info',
    intercept_only: false,
    sources: [],
    ...overrides,
  }
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2))
}

const sampleEpisode = (overrides: Partial<NormalizedEvent> = {}): NormalizedEvent =>
  ({
    type: 'episode',
    sessionId: 'session-1',
    ids: { imdb: 'tt0959621' },
    imdbId: 'tt0959621',
    tmdbId: null,
    tvdbId: null,
    episodeIds: {},
    episodeImdbId: null,
    episodeTmdbId: null,
    episodeTvdbId: null,
    title: 'Pilot',
    originalTitle: null,
    year: 2008,
    showTitle: 'Breaking Bad',
    showOriginalTitle: null,
    season: 1,
    episode: 1,
    userRating: null,
    contentRating: null,
    runtimeMinutes: null,
    duration: 2820000,
    viewOffset: 282000, // 10%
    source: 'plex',
    action: 'progress',
    state: 'playing',
    appVersion: null,
    media: null,
    dubTeam: null,
    ...overrides,
  }) as NormalizedEvent

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myshows-scrobbler-srv-'))
  configPath = path.join(tmpDir, 'config.json')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function buildServer(
  overrides: Record<string, unknown> = {},
  opts: { interceptOnly?: boolean } = {},
) {
  writeConfigFile(overrides)
  vi.spyOn(PlexAdapter.prototype, 'start').mockImplementation(function () {
    /* noop */
  })

  const server = await createServer({
    ui: false,
    interceptOnly: opts.interceptOnly,
    configPath,
    skipBootstrap: true,
  })
  return server
}

function emitVia(
  server: Awaited<ReturnType<typeof buildServer>>,
  event: NormalizedEvent,
): Promise<void> {
  const adapter = server.adapters.get('plex')
  if (!adapter) {
    throw new Error('plex adapter not registered')
  }
  const emit = (
    adapter as unknown as {
      emitScrobble: (e: NormalizedEvent) => Promise<void>
    }
  ).emitScrobble.bind(adapter)
  return emit(event)
}

function mockSendScrobble(server: Awaited<ReturnType<typeof buildServer>>) {
  return vi.spyOn(server.myShowsClient, 'sendScrobble').mockResolvedValue({ success: true })
}

describe('handleScrobble pipeline', () => {
  it('first progress sends SCROBBLE_START, subsequent sends SCROBBLE_PAUSE', async () => {
    const server = await buildServer({
      sources: [
        {
          type: 'plex',
          enabled: true,
          url: 'http://x',
          token: 't',
          poll_interval: 5000,
          user_filter: [],
        },
      ],
    })
    const { fastify } = server
    const spy = mockSendScrobble(server)

    await emitVia(server, sampleEpisode({ viewOffset: 282000 })) // 10%
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toBe(MYSHOWS_ENDPOINTS.SCROBBLE_START)

    await emitVia(server, sampleEpisode({ viewOffset: 564000 })) // 20%
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy.mock.calls[1][0]).toBe(MYSHOWS_ENDPOINTS.SCROBBLE_PAUSE)

    const nowRes = await fastify.inject({ method: 'GET', url: '/api/now-playing' })
    const now = JSON.parse(nowRes.payload).nowPlaying
    expect(now).toHaveLength(1)
    expect(now[0].percent).toBeCloseTo(20, 0)

    await fastify.close()
  })

  it('stopped above scrobblePercent sends SCROBBLE_STOP', async () => {
    const server = await buildServer({
      sources: [
        {
          type: 'plex',
          enabled: true,
          url: 'http://x',
          token: 't',
          poll_interval: 5000,
          user_filter: [],
        },
      ],
    })
    const { fastify } = server
    const spy = mockSendScrobble(server)

    await emitVia(server, sampleEpisode({ action: 'stopped', viewOffset: 2540000 })) // ~90%

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toBe(MYSHOWS_ENDPOINTS.SCROBBLE_STOP)

    const evRes = await fastify.inject({ method: 'GET', url: '/api/events' })
    const events = JSON.parse(evRes.payload).events
    expect(events).toHaveLength(1)
    expect(events[0].status).toBe('success')

    await fastify.close()
  })

  it('interceptOnly=true → success in feed, no sendScrobble call', async () => {
    const server = await buildServer({
      intercept_only: true,
      sources: [
        {
          type: 'plex',
          enabled: true,
          url: 'http://x',
          token: 't',
          poll_interval: 5000,
          user_filter: [],
        },
      ],
    })
    const { fastify } = server
    const spy = mockSendScrobble(server)

    await emitVia(server, sampleEpisode({ action: 'stopped', viewOffset: 2540000 })) // ~90%

    expect(spy).not.toHaveBeenCalled()

    const evRes = await fastify.inject({ method: 'GET', url: '/api/events' })
    const events = JSON.parse(evRes.payload).events
    expect(events).toHaveLength(1)
    expect(events[0].status).toBe('success')

    await fastify.close()
  })

  it('interceptOnly=true does not require a MyShows token', async () => {
    const server = await buildServer({
      myshows_token: '',
      intercept_only: true,
      sources: [
        {
          type: 'plex',
          enabled: true,
          url: 'http://x',
          token: 't',
          poll_interval: 5000,
          user_filter: [],
        },
      ],
    })
    const { fastify } = server
    const spy = mockSendScrobble(server)

    await emitVia(server, sampleEpisode({ action: 'stopped', viewOffset: 2540000 }))

    expect(spy).not.toHaveBeenCalled()

    const evRes = await fastify.inject({ method: 'GET', url: '/api/events' })
    const events = JSON.parse(evRes.payload).events
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      status: 'success',
      intercept: true,
    })

    await fastify.close()
  })

  it('stopped below scrobblePercent is skipped without sending to MyShows', async () => {
    const server = await buildServer({
      sources: [
        {
          type: 'plex',
          enabled: true,
          url: 'http://x',
          token: 't',
          poll_interval: 5000,
          user_filter: [],
        },
      ],
    })
    const { fastify } = server
    const spy = mockSendScrobble(server)

    await emitVia(server, sampleEpisode({ action: 'stopped', viewOffset: 564000 })) // 20%

    expect(spy).not.toHaveBeenCalled()

    const evRes = await fastify.inject({ method: 'GET', url: '/api/events' })
    const events = JSON.parse(evRes.payload).events
    expect(events).toHaveLength(1)
    expect(events[0].status).toBe('skipped')
    expect(events[0].error).toContain('Below threshold')

    await fastify.close()
  })

  it('anti-spam: duplicate progress with no change is ignored', async () => {
    const server = await buildServer({
      sources: [
        {
          type: 'plex',
          enabled: true,
          url: 'http://x',
          token: 't',
          poll_interval: 5000,
          user_filter: [],
        },
      ],
    })
    const { fastify } = server
    const spy = mockSendScrobble(server)

    await emitVia(server, sampleEpisode({ viewOffset: 282000 })) // 10%
    await emitVia(server, sampleEpisode({ viewOffset: 282000 })) // same 10%

    // First call is start, second should be ignored (no change)
    expect(spy).toHaveBeenCalledTimes(1)

    await fastify.close()
  })

  it('deduplicates repeated polling logs', async () => {
    const server = await buildServer({
      sources: [
        {
          type: 'plex',
          enabled: true,
          url: 'http://x',
          token: 't',
          poll_interval: 5000,
          user_filter: [],
        },
      ],
    })
    const { fastify } = server
    const adapter = server.adapters.get('plex')
    if (!adapter) {
      throw new Error('plex adapter not registered')
    }

    const log = (adapter as unknown as { log: (level: string, message: string) => void }).log.bind(
      adapter,
    )
    log('error', 'Poll error: Kodi URL is not configured')
    log('error', 'Poll error: Kodi URL is not configured')

    const logsRes = await fastify.inject({ method: 'GET', url: '/api/polling-logs' })
    const logs = JSON.parse(logsRes.payload).logs
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      level: 'error',
      message: '[plex] Poll error: Kodi URL is not configured',
      repeatCount: 2,
    })

    await fastify.close()
  })

  it('configProvider applies CLI-style overrides over fresh file config', async () => {
    const source = {
      type: 'plex',
      enabled: true,
      url: 'http://x',
      token: 't',
      poll_interval: 5000,
      user_filter: [],
    }
    writeConfigFile({ scrobble_percent: 80, sources: [source] })
    vi.spyOn(PlexAdapter.prototype, 'start').mockImplementation(function () {
      /* noop */
    })

    const server = await createServer({
      ui: false,
      configPath,
      configProvider: () => ({ ...readConfig(), logLevel: 'debug' }),
      skipBootstrap: true,
    })
    const { fastify } = server
    const spy = mockSendScrobble(server)

    await emitVia(server, sampleEpisode({ action: 'stopped', viewOffset: 564000 }))
    expect(spy).not.toHaveBeenCalled()

    writeConfigFile({ scrobble_percent: 10, sources: [source] })
    await emitVia(
      server,
      sampleEpisode({ sessionId: 'session-2', action: 'stopped', viewOffset: 564000 }),
    )
    expect(spy).toHaveBeenCalledTimes(1)

    await fastify.close()
  })
})
