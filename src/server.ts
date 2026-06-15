import Fastify from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import type {
  NormalizedEvent,
  ScrobbleEvent,
  PollingLog,
  SourceType,
  NowPlayingEntry,
} from './types.js'
import { Logger, setDefaultLogger } from './logger.js'
import { readConfig, requireMyShowsUrl, setConfigPath, DEFAULT_PORT } from './config.js'
import { MyShowsClient, MYSHOWS_ENDPOINTS } from './scrobblers/myshows.js'
import type { ScrobbleEndpoint } from './scrobblers/myshows.js'
import { toScrobbleRequest } from './scrobblers/converter.js'
import { BaseAdapter } from './adapters/base.js'
import { createAdapter, hasAdapter, registerAdapter } from './adapters/registry.js'
import { PlexAdapter } from './adapters/plex.js'
import { JellyfinAdapter } from './adapters/jellyfin.js'
import { EmbyAdapter } from './adapters/emby.js'
import { KodiAdapter } from './adapters/kodi.js'
import { PlayerAdapter } from './adapters/player.js'
import type { PlayerId } from './utils/process-monitor.js'
import { MpcHttpAdapter } from './adapters/mpc-http.js'
import { MpvIpcAdapter } from './adapters/mpv-ipc.js'
import { IinaIpcAdapter } from './adapters/iina-ipc.js'
import { VlcHttpAdapter } from './adapters/vlc-http.js'
import { registerSetupAction } from './setup/registry.js'
import { mpcHcWebInterfaceAction, mpcBeWebInterfaceAction } from './setup/actions/mpc.js'
import { mpvIpcSetupAction } from './setup/actions/mpv.js'
import { iinaIpcSetupAction } from './setup/actions/iina.js'
import { vlcHttpInterfaceAction } from './setup/actions/vlc.js'
import { apiRoutes } from './routes/api.js'
import { healthRoutes } from './routes/health.js'
import type { AppConfig, UpdateController } from './types.js'
import { bootstrapKodiFromLocal } from './utils/kodi-bootstrap.js'
import { bootstrapPlexFromLocal } from './utils/plex-bootstrap.js'
import { bootstrapSourcesForAppliedSetups } from './utils/setup-source-bootstrap.js'

// Register built-in adapters
export function registerBuiltInAdapters(): void {
  registerAdapter('plex', PlexAdapter)
  registerAdapter('jellyfin', JellyfinAdapter)
  registerAdapter('emby', EmbyAdapter)
  registerAdapter('kodi', KodiAdapter)
  registerAdapter('player', PlayerAdapter)
  registerAdapter('mpc', MpcHttpAdapter)
  registerAdapter('mpv', MpvIpcAdapter)
  registerAdapter('iina', IinaIpcAdapter)
  registerAdapter('vlc', VlcHttpAdapter)
}

/**
 * Register built-in one-click setup actions. Symmetric with
 * `registerBuiltInAdapters()` — each Stage 3+ adapter that needs a
 * pre-flight config flip adds its action here.
 */
export function registerBuiltInSetupActions(): void {
  registerSetupAction(mpcHcWebInterfaceAction)
  registerSetupAction(mpcBeWebInterfaceAction)
  registerSetupAction(mpvIpcSetupAction)
  registerSetupAction(iinaIpcSetupAction)
  registerSetupAction(vlcHttpInterfaceAction)
}

registerBuiltInAdapters()
registerBuiltInSetupActions()

export interface ServerOptions {
  ui: boolean
  interceptOnly?: boolean
  configPath?: string
  port?: number
  host?: string
  configOverride?: AppConfig
  configProvider?: () => AppConfig
  /** Electron app-update bridge (absent in headless mode). */
  updates?: UpdateController
  /** Skip the local-source bootstrap (Plex / Kodi auto-discovery). Used by
   *  tests so a real PMS / Kodi install on the dev machine doesn't add
   *  unexpected sources to the seeded test config. */
  skipBootstrap?: boolean
}

function contentKey(event: NormalizedEvent): string {
  return `${event.source}:${event.sessionId}`
}

function formatTitle(event: NormalizedEvent): string {
  if (event.type === 'episode') {
    // Anime releases often carry only an absolute episode number — no season.
    const season = event.season != null ? `S${event.season}` : ''
    const episode = event.episode != null ? `E${event.episode}` : ''
    const marker = season || episode ? ` ${season}${episode}` : ''
    return `${event.showTitle ?? 'Show'}${marker} - ${event.title}`
  }
  return `${event.title}${event.year ? ` (${event.year})` : ''}`
}

function percentOf(event: NormalizedEvent): number {
  const duration = event.duration ?? 0
  const viewOffset = event.viewOffset ?? 0
  return duration > 0 ? (viewOffset / duration) * 100 : 0
}

function normalizedThreshold(value: number): number {
  if (!Number.isFinite(value)) {
    return 80
  }
  return Math.min(100, Math.max(0, value))
}

const PROGRESS_ANTISPAM_THRESHOLD = 0.01

export async function createServer(options: ServerOptions) {
  const listenPortFallback = DEFAULT_PORT

  if (options.configPath) {
    setConfigPath(options.configPath)
  }

  const getConfig = (): AppConfig =>
    options.configProvider?.() ?? options.configOverride ?? readConfig()
  const config = getConfig()
  const myshowsUrl = requireMyShowsUrl(config)
  const logger = new Logger(config.logLevel)
  setDefaultLogger(logger)

  const fastify = Fastify({ logger: false })

  const myShowsClient = new MyShowsClient(config.myshowsToken, myshowsUrl)

  // ── In-memory stores ──

  const MAX_EVENTS = 50
  const MAX_LOGS = 100

  const recentEvents: ScrobbleEvent[] = []
  const pollingLogs: PollingLog[] = []
  const wsClients = new Set<import('ws').WebSocket>()
  const adapters = new Map<SourceType, BaseAdapter>()

  // Live progress board: one entry per content key, updated on every poll tick.
  const nowPlaying = new Map<string, NowPlayingEntry>()
  // Anti-spam: last percent broadcast per key.
  const lastBroadcastPercent = new Map<string, number>()
  // Track which sessions have sent SCROBBLE_START to MyShows.
  const startedSessions = new Set<string>()

  // ── Helpers ──

  function addEvent(event: ScrobbleEvent): void {
    recentEvents.unshift(event)
    while (recentEvents.length > MAX_EVENTS) recentEvents.pop()
    broadcastWs({ type: 'event', data: event })
  }

  function addPollingLog(level: string, message: string): void {
    const existingIndex = pollingLogs.findIndex(
      (log) => log.level === level && log.message === message,
    )
    if (existingIndex !== -1) {
      const entry = pollingLogs[existingIndex]
      entry.timestamp = new Date().toISOString()
      entry.repeatCount = (entry.repeatCount ?? 1) + 1
      pollingLogs.splice(existingIndex, 1)
      pollingLogs.unshift(entry)
      broadcastWs({ type: 'log', data: entry })
      return
    }

    const entry: PollingLog = { timestamp: new Date().toISOString(), level, message }
    pollingLogs.unshift(entry)
    while (pollingLogs.length > MAX_LOGS) pollingLogs.pop()
    broadcastWs({ type: 'log', data: entry })
  }

  function broadcastWs(msg: unknown): void {
    const payload = JSON.stringify(msg)
    for (const client of wsClients) {
      try {
        client.send(payload)
      } catch {
        wsClients.delete(client)
      }
    }
  }

  function broadcastNowPlaying(): void {
    broadcastWs({ type: 'nowPlaying', data: Array.from(nowPlaying.values()) })
  }

  // ── Scrobble handler ──

  async function handleScrobble(
    event: NormalizedEvent,
  ): Promise<{ status: string; reason?: string }> {
    const key = contentKey(event)
    const percent = percentOf(event)
    const title = formatTitle(event)

    if (event.action === 'progress') {
      // Anti-spam: skip unless the percent actually moved.
      const last = lastBroadcastPercent.get(key)
      if (
        last !== undefined &&
        Math.abs(percent - last) < PROGRESS_ANTISPAM_THRESHOLD &&
        nowPlaying.has(key)
      ) {
        const prev = nowPlaying.get(key)
        if (prev && prev.event.state === event.state) {
          return { status: 'ignored', reason: 'no_change' }
        }
      }
      lastBroadcastPercent.set(key, percent)

      nowPlaying.set(key, {
        key,
        event,
        percent,
        updatedAt: new Date().toISOString(),
      })
      broadcastNowPlaying()

      // Determine endpoint: first event for this key → start, subsequent → pause
      const endpoint: ScrobbleEndpoint = startedSessions.has(key)
        ? MYSHOWS_ENDPOINTS.SCROBBLE_PAUSE
        : MYSHOWS_ENDPOINTS.SCROBBLE_START
      if (!startedSessions.has(key)) {
        startedSessions.add(key)
      }

      logger.debug(`${endpoint}: ${title} [${event.state}] ${percent.toFixed(2)}%`)

      // Send to MyShows
      await sendToMyShows(endpoint, event, percent, title)

      return { status: endpoint === MYSHOWS_ENDPOINTS.SCROBBLE_START ? 'started' : 'tracking' }
    }

    // action === 'stopped' — session ended.
    nowPlaying.delete(key)
    lastBroadcastPercent.delete(key)
    startedSessions.delete(key)
    broadcastNowPlaying()

    const currentConfig = getConfig()
    const threshold = normalizedThreshold(currentConfig.scrobblePercent)
    const intercept = options.interceptOnly || currentConfig.interceptOnly

    if (percent < threshold) {
      const reason = `Below threshold: ${percent.toFixed(1)}% < ${threshold}%`
      logger.info(`Skipped: ${title} (${reason})`)
      addEvent({
        ...event,
        timestamp: new Date().toISOString(),
        status: 'skipped',
        error: reason,
        intercept,
      })
      return { status: 'skipped', reason: 'below_threshold' }
    }

    logger.info(`Stopped: ${title} (${percent.toFixed(1)}%)`)

    await sendToMyShows(MYSHOWS_ENDPOINTS.SCROBBLE_STOP, event, percent, title)

    return { status: 'stopped' }
  }

  async function sendToMyShows(
    endpoint: ScrobbleEndpoint,
    event: NormalizedEvent,
    percent: number,
    title: string,
  ): Promise<void> {
    const payload = toScrobbleRequest(event, percent)
    logger.debug(`${endpoint} payload: ${JSON.stringify(payload)}`)

    const currentConfig = getConfig()
    const intercept = options.interceptOnly || currentConfig.interceptOnly

    if (intercept) {
      logger.info(`[Intercept-only] ${endpoint}: ${title}`)
      addEvent({
        ...event,
        timestamp: new Date().toISOString(),
        status: 'success',
        intercept: true,
      })
      return
    }

    if (!myShowsClient.getToken()) {
      logger.error('MyShows token not configured')
      addEvent({
        ...event,
        timestamp: new Date().toISOString(),
        status: 'error',
        error: 'No token',
        intercept: false,
      })
      return
    }

    const result = await myShowsClient.sendScrobble(endpoint, payload)

    addEvent({
      ...event,
      timestamp: new Date().toISOString(),
      status: result.success ? 'success' : 'error',
      error: result.error,
      intercept: false,
    })

    if (result.success) {
      logger.info(`${endpoint}: ${title} -> OK`)
    } else {
      logger.error(`${endpoint}: ${title} -> FAIL: ${result.error}`)
    }
  }

  // ── Bootstrap adapters ──

  function initAdapters(): void {
    for (const adapter of adapters.values()) adapter.stop()
    adapters.clear()
    nowPlaying.clear()
    lastBroadcastPercent.clear()
    startedSessions.clear()
    broadcastNowPlaying()

    const currentConfig = getConfig()

    for (const source of currentConfig.sources) {
      if (!source.enabled) {
        continue
      }
      if (!hasAdapter(source.type)) {
        logger.warn(`Skipping unknown source type "${source.type}" — not registered`)
        continue
      }
      try {
        const adapter = createAdapter(source, {
          onScrobble: async (event) => {
            await handleScrobble(event)
          },
          onLog: addPollingLog,
        })
        adapters.set(source.type, adapter)

        adapter.start()
        logger.info(`Adapter loaded: ${source.type} (polling ${source.pollInterval}ms)`)
      } catch (err) {
        logger.error(`Failed to load adapter ${source.type}`, err)
      }
    }

    // Source-precedence: a dedicated precise source (mpc/mpv/iina) owns its
    // player, so the generic process-scan player adapter must skip it —
    // otherwise the same playback is counted twice (precise + uptime estimate).
    const playerAdapter = adapters.get('player')
    if (playerAdapter instanceof PlayerAdapter) {
      const PRECISE_PLAYER_SOURCES: readonly SourceType[] = ['mpc', 'mpv', 'iina', 'vlc']
      const claimed = currentConfig.sources
        .filter((s) => s.enabled && PRECISE_PLAYER_SOURCES.includes(s.type))
        .map((s) => s.type as PlayerId)
      playerAdapter.setExcludedPlayers(claimed)
      if (claimed.length > 0) {
        logger.info(`Player adapter excluding (owned by precise source): ${claimed.join(', ')}`)
      }
    }
  }

  // ── WebSocket ──

  await fastify.register(fastifyWebsocket)

  fastify.get('/ws', { websocket: true }, (ws) => {
    wsClients.add(ws)

    // Replay recent events + current now-playing board to new client
    for (const event of [...recentEvents].reverse()) {
      try {
        ws.send(JSON.stringify({ type: 'event', data: event }))
      } catch {
        /* noop */
      }
    }
    try {
      ws.send(JSON.stringify({ type: 'nowPlaying', data: Array.from(nowPlaying.values()) }))
    } catch {
      /* noop */
    }

    ws.on('close', () => wsClients.delete(ws))
    ws.on('error', () => wsClients.delete(ws))
  })

  // ── Routes ──

  await apiRoutes(fastify, {
    getEvents: () => recentEvents,
    getPollingLogs: () => pollingLogs,
    getNowPlaying: () => Array.from(nowPlaying.values()),
    clearEvents: () => {
      recentEvents.length = 0
    },
    adapters,
    reloadAdapters: initAdapters,
    myShowsClient,
    cliInterceptOnly: options.interceptOnly === true,
    updates: options.updates,
  })

  if (process.env.NODE_ENV !== 'production') {
    const { devApiRoutes } = await import('./routes/api.dev.js')
    await devApiRoutes(fastify, { myShowsClient })
  }

  await healthRoutes(fastify)

  // Optional UI
  if (options.ui) {
    const { registerUI } = await import('./ui.js')
    await registerUI(fastify)
  }

  // Best-effort: if a local Plex Media Server is installed and we don't
  // already have a Plex token configured, add/fill the source from PMS's
  // Preferences.xml before adapters spin up. Same story for Kodi —
  // credentials come from `guisettings.xml`.
  if (!options.skipBootstrap) {
    await Promise.all([
      bootstrapPlexFromLocal(logger),
      bootstrapKodiFromLocal(logger),
      bootstrapSourcesForAppliedSetups(logger),
    ])
  }

  // Init adapters
  initAdapters()

  // Graceful shutdown. `stop()` tears down adapters and the HTTP server
  // without exiting the process — embedders (Electron) own the lifecycle.
  let closed = false
  const stop = async () => {
    if (closed) {
      return
    }
    closed = true
    logger.info('Shutting down...')
    for (const adapter of adapters.values()) adapter.stop()
    await fastify.close()
  }
  const shutdown = async () => {
    await stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  return {
    fastify,
    logger,
    config,
    myShowsClient,
    adapters,
    start: async () => {
      const address = await fastify.listen({
        port: options.port ?? listenPortFallback,
        host: options.host ?? '0.0.0.0',
      })
      logger.info(`Server listening at ${address}`)
      return address
    },
    stop,
  }
}
