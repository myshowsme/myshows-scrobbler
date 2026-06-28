import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import type {
  AppConfig,
  AppConfigSnapshot,
  ScrobbleEvent,
  PollingLog,
  SourceErrorCode,
  SourceType,
  SourceConfig,
  NowPlayingEntry,
  UpdateController,
} from '../types.js'
import { isLocalSource, sourceNeedsUrl, SOURCE_TYPES } from '../types.js'
import type { BaseAdapter } from '../adapters/base.js'
import { createAdapter } from '../adapters/registry.js'
import {
  DEFAULT_SOURCE_POLL_INTERVAL,
  getConfigPath,
  readConfig,
  requireMyShowsUrl,
  writeConfig,
} from '../config.js'
import { MyShowsClient } from '../scrobblers/myshows.js'
import { listSetupActions, getSetupAction } from '../setup/registry.js'
import {
  applySetup,
  forceRestoreSetup,
  restoreSetup,
  SetupBlockedError,
  SetupUnsupportedError,
} from '../setup/runtime.js'
import { listSnapshots } from '../setup/snapshot-store.js'
import { readAuditEntries } from '../setup/audit-log.js'
import type { SetupAction } from '../setup/types.js'
import { EmbySignInError, signInToEmby } from '../utils/emby-signin.js'
import {
  initiateQuickConnect,
  pollQuickConnect,
  QuickConnectError,
} from '../utils/jellyfin-quick-connect.js'
import { discoverKodiCredentials } from '../utils/kodi-credentials-discovery.js'
import { discoverPlexToken } from '../utils/plex-token-discovery.js'

interface ApiContext {
  getEvents: () => ScrobbleEvent[]
  getPollingLogs: () => PollingLog[]
  getNowPlaying: () => NowPlayingEntry[]
  clearEvents: () => void
  adapters: Map<SourceType, BaseAdapter>
  reloadAdapters: () => void
  myShowsClient: MyShowsClient
  /** True when the process was started with --intercept-only (CLI lock). */
  cliInterceptOnly: boolean
  /** Electron app-update bridge (absent in headless mode). */
  updates?: UpdateController
}

function unmaskToken(nextToken: string, currentToken: string): string {
  if (!nextToken) {
    return ''
  }
  if (!nextToken.startsWith('***')) {
    return nextToken
  }
  if (!currentToken) {
    return nextToken
  }

  const suffix = nextToken.slice(3)
  if (suffix && currentToken.endsWith(suffix)) {
    return currentToken
  }

  return nextToken
}

function classifyError(message: string | null | undefined): SourceErrorCode {
  if (!message) {
    return 'unreachable'
  }
  const m = message.toLowerCase()
  if (
    m.includes('401') ||
    m.includes('403') ||
    m.includes('auth') ||
    m.includes('unauthor') ||
    m.includes('token')
  ) {
    return 'auth'
  }
  if (
    m.includes('econn') ||
    m.includes('enotfound') ||
    m.includes('etimedout') ||
    m.includes('timeout') ||
    m.includes('network') ||
    m.includes('fetch failed')
  ) {
    return 'network'
  }
  return 'unreachable'
}

// Derived from the canonical list so new source types (mpc, mpv, iina, …) are
// accepted by the source endpoints without a second edit here.
const VALID_SOURCE_TYPES: ReadonlySet<string> = new Set<SourceType>(SOURCE_TYPES)

export async function apiRoutes(fastify: FastifyInstance, ctx: ApiContext): Promise<void> {
  // GET /api/events
  fastify.get('/api/events', async () => {
    return { events: ctx.getEvents() }
  })

  // DELETE /api/events
  fastify.delete('/api/events', async () => {
    ctx.clearEvents()
    return { status: 'ok' }
  })

  // ── App auto-update (Electron only) ──

  // GET /api/update — availability for the UI's version indicator/prompt.
  fastify.get('/api/update', async () => {
    return ctx.updates?.getStatus() ?? { available: false, version: null, downloading: false }
  })

  // POST /api/update/install — user opted to update.
  fastify.post('/api/update/install', async () => {
    ctx.updates?.install()
    return { status: 'success' }
  })

  // POST /api/update/skip — user opted to skip this version.
  fastify.post('/api/update/skip', async () => {
    ctx.updates?.skip()
    return { status: 'success' }
  })

  // GET /api/plex/auto-token — best-effort read of the local PMS token.
  // Returns either { token } or { token: null, reason }. The UI calls this
  // when the user enables the Plex source with an empty token; the CLI
  // dispatches a similar nudge when `--source plex` runs with no token
  // configured.
  fastify.get('/api/plex/auto-token', async () => {
    return discoverPlexToken()
  })

  // GET /api/kodi/auto-token — best-effort read of Kodi's local web
  // credentials. Returns either { token, port } or { token: null, reason }.
  // Symmetric to /api/plex/auto-token; the UI shows a "Find token" button on
  // the Kodi source row when the token field is empty.
  fastify.get('/api/kodi/auto-token', async () => {
    return discoverKodiCredentials()
  })

  // ── Quick Connect (Jellyfin / Emby) ────────────────────────────────────
  // Two thin proxies over the user's media server. The frontend orchestrates
  // the state machine (display code, poll, give up on timeout); the backend
  // just shields it from CORS / cross-origin auth header quirks.

  fastify.post<{ Body: { url?: string } }>('/api/quick-connect/initiate', async (req, reply) => {
    const url = req.body?.url ?? ''
    if (!url.trim()) {
      return reply.code(400).send({ error: 'url required' })
    }
    try {
      return await initiateQuickConnect(url)
    } catch (err) {
      if (err instanceof QuickConnectError) {
        return reply.code(400).send({ error: err.reason, detail: err.detail })
      }
      throw err
    }
  })

  fastify.get<{ Querystring: { url?: string; secret?: string; deviceId?: string } }>(
    '/api/quick-connect/poll',
    async (req, reply) => {
      const { url = '', secret = '', deviceId = '' } = req.query
      if (!url.trim() || !secret || !deviceId) {
        return reply.code(400).send({ error: 'url, secret, deviceId required' })
      }
      try {
        return await pollQuickConnect(url, secret, deviceId)
      } catch (err) {
        if (err instanceof QuickConnectError) {
          return reply.code(400).send({ error: err.reason, detail: err.detail })
        }
        throw err
      }
    },
  )

  // ── Emby sign-in (username / password → access token) ──────────────────
  // Thin proxy to /Users/AuthenticateByName. The password lives only in the
  // request body; we hand back the resulting access token and forget the
  // rest. Used by the inline Emby sign-in form when Quick Connect isn't
  // available (community installs don't ship it).
  fastify.post<{ Body: { url?: string; username?: string; password?: string } }>(
    '/api/emby/sign-in',
    async (req, reply) => {
      const { url = '', username = '', password = '' } = req.body ?? {}
      if (!url.trim() || !username) {
        return reply.code(400).send({ error: 'url and username required' })
      }
      try {
        return await signInToEmby(url, username, password)
      } catch (err) {
        if (err instanceof EmbySignInError) {
          return reply.code(400).send({ error: err.reason, detail: err.detail })
        }
        throw err
      }
    },
  )

  // GET /api/config — runtime snapshot (includes cliInterceptOnlyLocked)
  fastify.get('/api/config', async () => {
    const cfg = readConfig()
    const snapshot: AppConfigSnapshot = {
      ...cfg,
      cliInterceptOnlyLocked: ctx.cliInterceptOnly,
      configPath: path.resolve(getConfigPath()),
    }
    return snapshot
  })

  // POST /api/config — full config update (legacy, used by old UI)
  fastify.post<{ Body: AppConfig }>('/api/config', async (request, reply) => {
    const currentConfig = readConfig()
    const newConfig: AppConfig = {
      ...request.body,
      myshowsToken: unmaskToken(request.body.myshowsToken, currentConfig.myshowsToken),
      sources: request.body.sources.map((source, index) => ({
        ...source,
        token: unmaskToken(source.token, currentConfig.sources[index]?.token ?? ''),
      })),
    }

    try {
      newConfig.myshowsUrl = requireMyShowsUrl(newConfig)
    } catch (err) {
      reply.code(400)
      return { status: 'error', reason: (err as Error).message }
    }

    ctx.myShowsClient.setToken(newConfig.myshowsToken)
    ctx.myShowsClient.setBaseUrl(newConfig.myshowsUrl)

    const success = writeConfig(newConfig)
    if (success) {
      ctx.reloadAdapters()
      return { status: 'success' }
    }
    reply.code(500)
    return { status: 'error', reason: 'Failed to save config' }
  })

  // PATCH /api/config — partial update (v2 UI)
  fastify.patch<{
    Body: Partial<
      Pick<
        AppConfig,
        | 'interceptOnly'
        | 'scrobblePercent'
        | 'minDurationMinutes'
        | 'stopAtThreshold'
        | 'logLevel'
        | 'myshowsToken'
        | 'myshowsUrl'
      >
    >
  }>('/api/config', async (request, reply) => {
    const body = request.body ?? {}

    if (body.interceptOnly !== undefined && ctx.cliInterceptOnly) {
      reply.code(409)
      return {
        status: 'error',
        reason: 'interceptOnly is locked by --intercept-only CLI flag',
      }
    }

    const current = readConfig()
    const next: AppConfig = { ...current }

    if (body.interceptOnly !== undefined) {
      next.interceptOnly = !!body.interceptOnly
    }
    if (body.scrobblePercent !== undefined) {
      next.scrobblePercent = body.scrobblePercent
    }
    if (body.minDurationMinutes !== undefined) {
      next.minDurationMinutes = body.minDurationMinutes
    }
    if (body.stopAtThreshold !== undefined) {
      next.stopAtThreshold = !!body.stopAtThreshold
    }
    if (body.logLevel !== undefined) {
      next.logLevel = body.logLevel
    }
    if (body.myshowsToken !== undefined) {
      next.myshowsToken = unmaskToken(body.myshowsToken, current.myshowsToken)
    }
    if (body.myshowsUrl !== undefined) {
      next.myshowsUrl = body.myshowsUrl
    }

    try {
      next.myshowsUrl = requireMyShowsUrl(next)
    } catch (err) {
      reply.code(400)
      return { status: 'error', reason: (err as Error).message }
    }

    if (body.myshowsToken !== undefined) {
      ctx.myShowsClient.setToken(next.myshowsToken)
    }
    if (body.myshowsUrl !== undefined) {
      ctx.myShowsClient.setBaseUrl(next.myshowsUrl)
    }

    const ok = writeConfig(next)
    if (!ok) {
      reply.code(500)
      return { status: 'error', reason: 'Failed to save config' }
    }
    return { status: 'success' }
  })

  // POST /api/config/sources — add or update source (legacy)
  fastify.post<{ Body: SourceConfig }>('/api/config/sources', async (request) => {
    const config = readConfig()
    const newSource = request.body

    const existingIndex = config.sources.findIndex(
      (s) => s.type === newSource.type && s.url === newSource.url,
    )
    if (existingIndex >= 0) {
      config.sources[existingIndex] = newSource
    } else {
      config.sources.push(newSource)
    }

    writeConfig(config)
    ctx.reloadAdapters()
    return { status: 'ok', sources: config.sources }
  })

  // DELETE /api/config/sources/:index (legacy)
  fastify.delete<{ Params: { index: string } }>(
    '/api/config/sources/:index',
    async (request, reply) => {
      const config = readConfig()
      const index = parseInt(request.params.index, 10)

      if (isNaN(index) || index < 0 || index >= config.sources.length) {
        reply.code(400)
        return { status: 'error', reason: 'Invalid source index' }
      }

      config.sources.splice(index, 1)
      writeConfig(config)
      ctx.reloadAdapters()
      return { status: 'ok', sources: config.sources }
    },
  )

  // PATCH /api/sources/:type — partial update of one source (v2 UI)
  fastify.patch<{
    Params: { type: string }
    Body: Partial<Pick<SourceConfig, 'enabled' | 'url' | 'token'>>
  }>('/api/sources/:type', async (request, reply) => {
    const type = request.params.type
    if (!VALID_SOURCE_TYPES.has(type)) {
      reply.code(400)
      return { status: 'error', reason: `Unknown source type: ${type}` }
    }

    const config = readConfig()
    const sourceType = type as SourceType
    let source = config.sources.find((s) => s.type === sourceType)

    if (!source) {
      source = {
        type: sourceType,
        enabled: false,
        url: '',
        token: '',
        pollInterval: DEFAULT_SOURCE_POLL_INTERVAL,
        userFilter: [],
      }
      config.sources.push(source)
    }

    const body = request.body ?? {}
    if (body.enabled !== undefined) {
      source.enabled = !!body.enabled
    }
    if (body.url !== undefined) {
      source.url = String(body.url)
    }
    if (body.token !== undefined) {
      source.token = unmaskToken(String(body.token), source.token)
    }

    const ok = writeConfig(config)
    if (!ok) {
      reply.code(500)
      return { status: 'error', reason: 'Failed to save config' }
    }

    ctx.reloadAdapters()
    return { status: 'success', source }
  })

  // POST /api/sources/:type/check — stateless connectivity check (v2 UI)
  fastify.post<{
    Params: { type: string }
    Body: { url: string; token: string }
  }>('/api/sources/:type/check', async (request, reply) => {
    const type = request.params.type
    if (!VALID_SOURCE_TYPES.has(type)) {
      reply.code(400)
      return {
        ok: false,
        error: `Unknown source type: ${type}`,
        code: 'unreachable' as SourceErrorCode,
      }
    }

    const { url, token } = request.body ?? {}
    // Local sources (e.g. process-scanning `player`) need no credentials.
    // Token-only sources (Stremio) use a fixed endpoint and need just the token.
    // Everything else needs both a URL and a token.
    const sourceType = type as SourceType
    if (!isLocalSource(sourceType)) {
      const needsUrl = sourceNeedsUrl(sourceType)
      if (needsUrl ? !url || !token : !token) {
        const error = needsUrl ? 'url and token are required' : 'token is required'
        return { ok: false, error, code: 'auth' as SourceErrorCode }
      }
    }

    try {
      const adapter = createAdapter(
        {
          type: type as SourceType,
          enabled: true,
          url,
          token,
          pollInterval: DEFAULT_SOURCE_POLL_INTERVAL,
          userFilter: [],
        },
        {
          onScrobble: async () => {
            /* noop */
          },
          onLog: () => {
            /* noop */
          },
        },
      )

      const success = await adapter.checkConnection()
      if (success) {
        return { ok: true }
      }
      const error = adapter.getLastConnectionError() ?? 'Connection check failed'
      return { ok: false, error, code: classifyError(error) }
    } catch (err) {
      const message = (err as Error).message
      return { ok: false, error: message, code: classifyError(message) }
    }
  })

  // POST /api/myshows/check — verify a token (v2 UI)
  fastify.post<{ Body: { token?: string } }>('/api/myshows/check', async (request) => {
    const provided = request.body?.token
    const tokenToUse = provided
      ? unmaskToken(provided, ctx.myShowsClient.getToken())
      : ctx.myShowsClient.getToken()

    if (!tokenToUse) {
      return { ok: false, error: 'Token is empty' }
    }

    const client = new MyShowsClient(tokenToUse, ctx.myShowsClient.getBaseUrl())
    const result = await client.checkToken()
    return { ok: result.valid, error: result.error }
  })

  // ── Legacy check endpoints (still used by old UI; removed in M10) ──

  // POST /api/check-token
  fastify.post<{ Body: { token: string; baseUrl?: string } }>(
    '/api/check-token',
    async (request) => {
      const { token, baseUrl } = request.body
      if (!token) {
        return { valid: false, error: 'Token is required' }
      }
      const client = new MyShowsClient(token, baseUrl ?? requireMyShowsUrl(readConfig()))
      return await client.checkToken()
    },
  )

  // POST /api/check-myshows
  fastify.post('/api/check-myshows', async () => {
    return await ctx.myShowsClient.checkToken()
  })

  // POST /api/check-source
  fastify.post<{ Body: SourceConfig }>('/api/check-source', async (request, reply) => {
    const source = request.body

    if (!source?.type) {
      reply.code(400)
      return { success: false, error: 'Source config is required' }
    }

    try {
      const adapter = createAdapter(source, {
        onScrobble: async () => {
          /* noop */
        },
        onLog: () => {
          /* noop */
        },
      })

      const ok = await adapter.checkConnection()
      return {
        success: ok,
        error: ok ? undefined : (adapter.getLastConnectionError() ?? 'Connection check failed'),
      }
    } catch (err) {
      reply.code(400)
      return { success: false, error: (err as Error).message }
    }
  })

  // POST /api/check-source/:type
  fastify.post<{ Params: { type: string } }>('/api/check-source/:type', async (request, reply) => {
    const type = request.params.type as SourceType
    const adapter = ctx.adapters.get(type)

    if (!adapter) {
      reply.code(404)
      return { success: false, error: `Adapter '${type}' not found` }
    }

    try {
      const ok = await adapter.checkConnection()
      return {
        success: ok,
        error: ok ? undefined : (adapter.getLastConnectionError() ?? 'Connection check failed'),
      }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // GET /api/status
  fastify.get('/api/status', async () => {
    const adapterStatuses = Array.from(ctx.adapters.entries()).map(([type, adapter]) => ({
      type,
      running: adapter.isRunning(),
      url: adapter.config.url,
    }))

    return {
      adapters: adapterStatuses,
      hasToken: !!ctx.myShowsClient.getToken(),
    }
  })

  // GET /api/polling-logs
  fastify.get('/api/polling-logs', async () => {
    return { logs: ctx.getPollingLogs() }
  })

  // GET /api/now-playing
  fastify.get('/api/now-playing', async () => {
    return { nowPlaying: ctx.getNowPlaying() }
  })

  // ── One-click setup actions (Stage 2 framework over HTTP) ──

  // Latest still-active (not restored) snapshot id for an action, if any.
  async function activeSnapshotId(actionId: string): Promise<string | undefined> {
    const snapshots = await listSnapshots()
    return snapshots.find((s) => s.actionId === actionId && !s.restoredAt)?.id
  }

  // "applied" = every planned change already matches its target (current === next).
  async function isApplied(action: SetupAction): Promise<boolean> {
    try {
      const changes = await action.diff()
      return changes.length > 0 && changes.every((c) => c.current === c.next)
    } catch {
      return false
    }
  }

  // GET /api/setup/actions — list with supported/applied state + active snapshot
  fastify.get('/api/setup/actions', async () => {
    const actions = listSetupActions()
    const result = await Promise.all(
      actions.map(async (action) => ({
        id: action.id,
        name: action.name,
        description: action.description,
        player: action.player,
        supported: await action.isSupported().catch(() => false),
        applied: await isApplied(action),
        activeSnapshotId: await activeSnapshotId(action.id),
      })),
    )
    return { actions: result }
  })

  // GET /api/setup/actions/:id/diff — planned changes (consent modal data)
  fastify.get<{ Params: { id: string } }>('/api/setup/actions/:id/diff', async (request, reply) => {
    const action = getSetupAction(request.params.id)
    if (!action) {
      reply.code(404)
      return { status: 'error', reason: `Unknown setup action: ${request.params.id}` }
    }
    return { changes: await action.diff() }
  })

  // POST /api/setup/actions/:id/apply
  fastify.post<{ Params: { id: string } }>(
    '/api/setup/actions/:id/apply',
    async (request, reply) => {
      const action = getSetupAction(request.params.id)
      if (!action) {
        reply.code(404)
        return { status: 'error', reason: `Unknown setup action: ${request.params.id}` }
      }
      try {
        const { snapshot, verified } = await applySetup(action)
        return {
          status: 'success',
          snapshotId: snapshot.id,
          verified,
          changes: snapshot.appliedChanges,
        }
      } catch (err) {
        if (err instanceof SetupBlockedError) {
          reply.code(409)
          return { status: 'blocked', reason: err.message, reasonCode: err.code }
        }
        if (err instanceof SetupUnsupportedError) {
          reply.code(400)
          return { status: 'unsupported', reason: err.message }
        }
        reply.code(500)
        return { status: 'error', reason: (err as Error).message }
      }
    },
  )

  // POST /api/setup/actions/:id/restore — body { snapshotId? }; defaults to latest active
  fastify.post<{ Params: { id: string }; Body: { snapshotId?: string } }>(
    '/api/setup/actions/:id/restore',
    async (request, reply) => {
      const action = getSetupAction(request.params.id)
      if (!action) {
        reply.code(404)
        return { status: 'error', reason: `Unknown setup action: ${request.params.id}` }
      }
      const snapshotId = request.body?.snapshotId ?? (await activeSnapshotId(action.id))
      if (!snapshotId) {
        // Snapshot wiped (between installs, user cleared userData, …) but
        // the action is in the applied state. Fall back to deleting the
        // properties we wrote so the user can actually turn it off.
        if (await isApplied(action)) {
          try {
            await forceRestoreSetup(action)
            return { status: 'success', mode: 'force' }
          } catch (err) {
            reply.code(500)
            return { status: 'error', reason: (err as Error).message }
          }
        }
        reply.code(404)
        return { status: 'error', reason: 'No active snapshot to restore' }
      }
      try {
        await restoreSetup(snapshotId, action)
        return { status: 'success' }
      } catch (err) {
        reply.code(400)
        return { status: 'error', reason: (err as Error).message }
      }
    },
  )

  // GET /api/setup/history — audit log, newest first
  fastify.get('/api/setup/history', async () => {
    return { entries: await readAuditEntries(50) }
  })
}
