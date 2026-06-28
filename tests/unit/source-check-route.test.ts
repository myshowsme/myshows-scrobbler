import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../../src/server.js'
import { PlexAdapter } from '../../src/adapters/plex.js'
import { StremioAdapter } from '../../src/adapters/stremio.js'

// Regression net for the POST /api/sources/:type/check probe gate. It used to
// reject every non-local source lacking a URL, which broke token-only Stremio
// (no URL, just an authKey). The gate now keys off sourceNeedsUrl().

let tmpDir: string
let configPath: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myshows-scrobbler-check-'))
  configPath = path.join(tmpDir, 'config.json')
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      myshows_token: 'stub-token',
      myshows_url: 'https://api.myshows.me/v2/rpc/',
      scrobble_percent: 80,
      log_level: 'info',
      intercept_only: false,
      sources: [],
    }),
  )
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function buildServer() {
  vi.spyOn(PlexAdapter.prototype, 'start').mockImplementation(function () {
    /* noop */
  })
  return createServer({ ui: false, configPath, skipBootstrap: true })
}

describe('POST /api/sources/:type/check', () => {
  it('accepts a token-only Stremio probe with no URL', async () => {
    const check = vi.spyOn(StremioAdapter.prototype, 'checkConnection').mockResolvedValue(true)
    const server = await buildServer()
    const res = await server.fastify.inject({
      method: 'POST',
      url: '/api/sources/stremio/check',
      payload: { token: 'AUTHKEY', url: '' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual({ ok: true })
    expect(check).toHaveBeenCalledTimes(1)

    await server.fastify.close()
  })

  it('rejects a token-only Stremio probe with no token (before hitting the network)', async () => {
    const check = vi.spyOn(StremioAdapter.prototype, 'checkConnection').mockResolvedValue(true)
    const server = await buildServer()
    const res = await server.fastify.inject({
      method: 'POST',
      url: '/api/sources/stremio/check',
      payload: { token: '', url: '' },
    })

    const body = JSON.parse(res.payload)
    expect(body.ok).toBe(false)
    expect(body.error).toBe('token is required')
    expect(check).not.toHaveBeenCalled()

    await server.fastify.close()
  })

  it('still requires a URL for a normal url+token source (Plex)', async () => {
    const server = await buildServer()
    const res = await server.fastify.inject({
      method: 'POST',
      url: '/api/sources/plex/check',
      payload: { token: 'PLEXTOKEN', url: '' },
    })

    const body = JSON.parse(res.payload)
    expect(body.ok).toBe(false)
    expect(body.error).toBe('url and token are required')

    await server.fastify.close()
  })
})
