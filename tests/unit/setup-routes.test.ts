import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../../src/server.js'
import { PlexAdapter } from '../../src/adapters/plex.js'
import { registerSetupAction } from '../../src/setup/registry.js'
import { setSnapshotDir } from '../../src/setup/snapshot-store.js'
import { setAuditLogPath } from '../../src/setup/audit-log.js'
import type { SetupAction, SetupChange } from '../../src/setup/types.js'

/**
 * Exercises the /api/setup/* routes against an in-memory fake action so we
 * never touch the real registry / mpv.conf. The fake is registered once at
 * module scope (after server.js has registered the built-in actions).
 */

const store: { value: number | null } = { value: null }

const fakeAction: SetupAction = {
  id: 'test-fake-setup',
  player: 'mpc',
  name: 'Test Fake Setup',
  description: 'fixture for route tests',
  async isSupported() {
    return true
  },
  async diff(): Promise<SetupChange[]> {
    return [{ kind: 'ini-file', target: '/fake', property: 'flag', current: store.value, next: 1 }]
  },
  async apply(changes) {
    for (const c of changes) {
      store.value = c.next as number
    }
  },
  async restore(previous) {
    for (const c of previous) {
      store.value = c.next as number | null
    }
  },
  async verify() {
    return true
  },
}
registerSetupAction(fakeAction)

let tmpDir: string
let configPath: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrobbler-setup-routes-'))
  configPath = path.join(tmpDir, 'config.json')
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      myshows_token: 'stub',
      myshows_url: 'https://api.myshows.me/v2/rpc/',
      scrobble_percent: 80,
      log_level: 'info',
      sources: [],
    }),
  )
  setSnapshotDir(path.join(tmpDir, 'snapshots'))
  setAuditLogPath(path.join(tmpDir, 'audit.log'))
  store.value = null
  vi.spyOn(PlexAdapter.prototype, 'start').mockImplementation(() => {})
})

afterEach(() => {
  setSnapshotDir(null)
  setAuditLogPath(null)
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function build() {
  return createServer({ ui: false, configPath, skipBootstrap: true })
}

describe('GET /api/setup/actions', () => {
  it('lists registered actions including the built-in mpc/mpv plus the fixture', async () => {
    const { fastify } = await build()
    const res = await fastify.inject({ method: 'GET', url: '/api/setup/actions' })
    expect(res.statusCode).toBe(200)
    const actions = JSON.parse(res.payload).actions as Array<{ id: string; supported: boolean }>
    const ids = actions.map((a) => a.id)
    expect(ids).toContain('test-fake-setup')
    expect(ids).toContain('mpc-hc-web-interface')
    expect(ids).toContain('mpv-ipc')
    const fake = actions.find((a) => a.id === 'test-fake-setup')
    expect(fake?.supported).toBe(true)
    await fastify.close()
  })
})

describe('apply / restore over HTTP', () => {
  it('applies the fixture action, mutating the store and returning a snapshot id', async () => {
    const { fastify } = await build()
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/setup/actions/test-fake-setup/apply',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.status).toBe('success')
    expect(body.verified).toBe(true)
    expect(typeof body.snapshotId).toBe('string')
    expect(store.value).toBe(1)
    await fastify.close()
  })

  it('restores via the latest active snapshot (no body needed)', async () => {
    const { fastify } = await build()
    store.value = 0
    await fastify.inject({ method: 'POST', url: '/api/setup/actions/test-fake-setup/apply' })
    expect(store.value).toBe(1)

    const restore = await fastify.inject({
      method: 'POST',
      url: '/api/setup/actions/test-fake-setup/restore',
    })
    expect(restore.statusCode).toBe(200)
    expect(JSON.parse(restore.payload).status).toBe('success')
    expect(store.value).toBe(0)
    await fastify.close()
  })

  it('returns 404 for an unknown action', async () => {
    const { fastify } = await build()
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/setup/actions/no-such-action/apply',
    })
    expect(res.statusCode).toBe(404)
    await fastify.close()
  })

  it('returns 404 restoring when there is no active snapshot', async () => {
    const { fastify } = await build()
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/setup/actions/test-fake-setup/restore',
    })
    expect(res.statusCode).toBe(404)
    await fastify.close()
  })
})

describe('GET /api/setup/actions/:id/diff and /api/setup/history', () => {
  it('returns the planned changes', async () => {
    const { fastify } = await build()
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/setup/actions/test-fake-setup/diff',
    })
    expect(res.statusCode).toBe(200)
    const changes = JSON.parse(res.payload).changes
    expect(changes[0]).toMatchObject({ property: 'flag', next: 1 })
    await fastify.close()
  })

  it('records apply/restore in the audit history', async () => {
    const { fastify } = await build()
    await fastify.inject({ method: 'POST', url: '/api/setup/actions/test-fake-setup/apply' })
    const res = await fastify.inject({ method: 'GET', url: '/api/setup/history' })
    expect(res.statusCode).toBe(200)
    const events = (JSON.parse(res.payload).entries as Array<{ event: string }>).map((e) => e.event)
    expect(events).toContain('apply')
    await fastify.close()
  })
})
