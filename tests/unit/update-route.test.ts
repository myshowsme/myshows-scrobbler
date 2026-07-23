import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../../src/server.js'
import { IDLE_UPDATE_STATUS, type UpdateController, type UpdateStatus } from '../../src/types.js'

// The UI's update banner reads every field of UpdateStatus (progress bar,
// bytes readout, ETA). Headless mode has no updater at all, so the route must
// still answer with the full shape rather than a three-key stub.

let tmpDir: string
let configPath: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myshows-scrobbler-update-'))
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

async function buildServer(updates?: UpdateController) {
  return createServer({ ui: false, configPath, skipBootstrap: true, updates })
}

describe('GET /api/update', () => {
  it('reports the idle status when no updater is wired (headless)', async () => {
    const server = await buildServer()
    const res = await server.fastify.inject({ method: 'GET', url: '/api/update' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual(IDLE_UPDATE_STATUS)

    await server.fastify.close()
  })

  it('passes the updater download progress through', async () => {
    const status: UpdateStatus = {
      available: true,
      version: '1.2.3',
      downloading: true,
      percent: 42.5,
      transferred: 4_200_000,
      total: 9_800_000,
      bytesPerSecond: 1_100_000,
      installing: false,
      error: null,
    }
    const server = await buildServer({
      getStatus: () => status,
      install: () => {},
      skip: () => {},
    })
    const res = await server.fastify.inject({ method: 'GET', url: '/api/update' })

    expect(JSON.parse(res.payload)).toEqual(status)

    await server.fastify.close()
  })
})
