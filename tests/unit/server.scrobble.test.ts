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

  it('progress crossing scrobblePercent sends STOP, then stops tracking the title', async () => {
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

    await emitVia(server, sampleEpisode({ viewOffset: 282000 })) // 10% → START
    expect(spy.mock.calls[0][0]).toBe(MYSHOWS_ENDPOINTS.SCROBBLE_START)

    await emitVia(server, sampleEpisode({ viewOffset: 2540000 })) // ~90% → STOP
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy.mock.calls[1][0]).toBe(MYSHOWS_ENDPOINTS.SCROBBLE_STOP)

    // Title is no longer tracked.
    const nowRes = await fastify.inject({ method: 'GET', url: '/api/now-playing' })
    expect(JSON.parse(nowRes.payload).nowPlaying).toHaveLength(0)

    // Further progress ticks are ignored (no PAUSE spam).
    await emitVia(server, sampleEpisode({ viewOffset: 2679000 })) // ~95%
    expect(spy).toHaveBeenCalledTimes(2)

    // The eventual stopped event does not re-send STOP.
    await emitVia(server, sampleEpisode({ action: 'stopped', viewOffset: 2679000 }))
    expect(spy).toHaveBeenCalledTimes(2)

    await fastify.close()
  })

  it('first observed tick already past threshold sends START then STOP', async () => {
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

    await emitVia(server, sampleEpisode({ viewOffset: 2679000 })) // ~95%, never started
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy.mock.calls[0][0]).toBe(MYSHOWS_ENDPOINTS.SCROBBLE_START)
    expect(spy.mock.calls[1][0]).toBe(MYSHOWS_ENDPOINTS.SCROBBLE_STOP)

    await fastify.close()
  })

  it('videos shorter than minDurationMinutes are ignored entirely', async () => {
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

    const shortClip = { duration: 120000 } // 2 min, below the 5 min default

    await emitVia(server, sampleEpisode({ ...shortClip, viewOffset: 60000 })) // 50% progress
    await emitVia(server, sampleEpisode({ ...shortClip, action: 'stopped', viewOffset: 108000 })) // 90%

    expect(spy).not.toHaveBeenCalled()

    const nowRes = await fastify.inject({ method: 'GET', url: '/api/now-playing' })
    expect(JSON.parse(nowRes.payload).nowPlaying).toHaveLength(0)

    const evRes = await fastify.inject({ method: 'GET', url: '/api/events' })
    expect(JSON.parse(evRes.payload).events).toHaveLength(0)

    await fastify.close()
  })

  it('stopAtThreshold=false keeps tracking past the threshold (STOP only on stop)', async () => {
    const server = await buildServer({
      stop_at_threshold: false,
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

    await emitVia(server, sampleEpisode({ viewOffset: 282000 })) // 10% → START
    await emitVia(server, sampleEpisode({ viewOffset: 2540000 })) // ~90% → PAUSE, not STOP
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy.mock.calls[1][0]).toBe(MYSHOWS_ENDPOINTS.SCROBBLE_PAUSE)

    // Still tracked.
    const nowRes = await fastify.inject({ method: 'GET', url: '/api/now-playing' })
    expect(JSON.parse(nowRes.payload).nowPlaying).toHaveLength(1)

    // STOP only fires when playback actually ends.
    await emitVia(server, sampleEpisode({ action: 'stopped', viewOffset: 2540000 }))
    expect(spy).toHaveBeenCalledTimes(3)
    expect(spy.mock.calls[2][0]).toBe(MYSHOWS_ENDPOINTS.SCROBBLE_STOP)

    await fastify.close()
  })

  it('failed STOP at threshold falls back to PAUSE and retries on the next tick', async () => {
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
    const spy = vi
      .spyOn(server.myShowsClient, 'sendScrobble')
      .mockResolvedValueOnce({ success: true }) // START @10%
      .mockResolvedValueOnce({ success: false, error: 'network' }) // STOP @90% fails
      .mockResolvedValue({ success: true }) // PAUSE @90%, then STOP @95%

    await emitVia(server, sampleEpisode({ viewOffset: 282000 })) // 10% → START
    await emitVia(server, sampleEpisode({ viewOffset: 2540000 })) // ~90% → STOP(fail) → PAUSE

    expect(spy.mock.calls[1][0]).toBe(MYSHOWS_ENDPOINTS.SCROBBLE_STOP)
    expect(spy.mock.calls[2][0]).toBe(MYSHOWS_ENDPOINTS.SCROBBLE_PAUSE)

    // Not finalized — still tracked.
    let nowRes = await fastify.inject({ method: 'GET', url: '/api/now-playing' })
    expect(JSON.parse(nowRes.payload).nowPlaying).toHaveLength(1)

    // Next changed tick retries STOP, which now succeeds → finalized.
    await emitVia(server, sampleEpisode({ viewOffset: 2679000 })) // ~95% → STOP(ok)
    expect(spy.mock.calls[3][0]).toBe(MYSHOWS_ENDPOINTS.SCROBBLE_STOP)
    expect(spy).toHaveBeenCalledTimes(4)

    nowRes = await fastify.inject({ method: 'GET', url: '/api/now-playing' })
    expect(JSON.parse(nowRes.payload).nowPlaying).toHaveLength(0)

    await fastify.close()
  })

  it('cleans up now-playing when duration resolves late to under the minimum', async () => {
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

    // Duration unknown on the first tick → tracked.
    await emitVia(server, sampleEpisode({ duration: null, viewOffset: 0 }))
    let nowRes = await fastify.inject({ method: 'GET', url: '/api/now-playing' })
    expect(JSON.parse(nowRes.payload).nowPlaying).toHaveLength(1)

    // Duration resolves to a 2 min clip → key is torn down, board cleared.
    await emitVia(server, sampleEpisode({ duration: 120000, viewOffset: 60000 }))
    nowRes = await fastify.inject({ method: 'GET', url: '/api/now-playing' })
    expect(JSON.parse(nowRes.payload).nowPlaying).toHaveLength(0)

    // Only the first (unknown-duration) tick produced a call; the short one didn't.
    expect(spy).toHaveBeenCalledTimes(1)

    await fastify.close()
  })

  it('minDurationMinutes=0 disables the short-video skip', async () => {
    const server = await buildServer({
      min_duration_minutes: 0,
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

    await emitVia(server, sampleEpisode({ duration: 120000, viewOffset: 12000 })) // 2 min clip, 10%
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toBe(MYSHOWS_ENDPOINTS.SCROBBLE_START)

    await fastify.close()
  })
})
