import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  applySetup,
  restoreSetup,
  SetupBlockedError,
  SetupUnsupportedError,
} from '../../src/setup/runtime.js'
import { setSnapshotDir, listSnapshots } from '../../src/setup/snapshot-store.js'
import { setAuditLogPath, readAuditEntries } from '../../src/setup/audit-log.js'
import type { SetupAction, SetupChange } from '../../src/setup/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scrobbler-runtime-'))
  setSnapshotDir(path.join(tmpDir, 'snapshots'))
  setAuditLogPath(path.join(tmpDir, 'audit.log'))
})

afterEach(async () => {
  setSnapshotDir(null)
  setAuditLogPath(null)
  await fs.rm(tmpDir, { recursive: true, force: true })
})

/**
 * In-memory fake action that mutates a `store` map instead of touching real
 * registry/files. Verifies the runtime drives apply/restore correctly without
 * needing a real player.
 */
function makeFakeAction(opts: {
  store: Map<string, string | number | null>
  supported?: boolean
  guardBlocked?: string | null
  verifyResult?: boolean
}): SetupAction & { verifyCount: number } {
  let verifyCount = 0
  return {
    id: 'fake-action',
    player: 'mpc',
    name: 'Fake',
    description: 'Test fixture',
    async isSupported() {
      return opts.supported ?? true
    },
    async guard() {
      return opts.guardBlocked ? { blocked: true, reason: opts.guardBlocked } : { blocked: false }
    },
    async diff(): Promise<SetupChange[]> {
      return [
        {
          kind: 'ini-file',
          target: '/fake/path',
          property: 'EnableWebServer',
          current: opts.store.get('EnableWebServer') ?? null,
          next: 1,
        },
      ]
    },
    async apply(changes) {
      for (const c of changes) {
        opts.store.set(c.property, c.next)
      }
    },
    async restore(previous) {
      for (const c of previous) {
        if (c.next === null) {
          opts.store.delete(c.property)
        } else {
          opts.store.set(c.property, c.next)
        }
      }
    },
    async verify() {
      verifyCount += 1
      return opts.verifyResult ?? true
    },
    get verifyCount() {
      return verifyCount
    },
  } as SetupAction & { verifyCount: number }
}

describe('applySetup', () => {
  it('writes the change, persists a snapshot, audits apply + verify-ok', async () => {
    const store = new Map<string, string | number | null>()
    const action = makeFakeAction({ store })
    const result = await applySetup(action)
    expect(store.get('EnableWebServer')).toBe(1)
    expect(result.verified).toBe(true)
    expect(result.snapshot.previousChanges[0].next).toBeNull()
    expect(result.snapshot.appliedChanges[0].next).toBe(1)
    const audit = await readAuditEntries()
    expect(audit.map((e) => e.event)).toEqual(['verify-ok', 'apply'])
  })

  it('audits verify-fail when verify returns false (but apply still recorded)', async () => {
    const store = new Map<string, string | number | null>()
    const action = makeFakeAction({ store, verifyResult: false })
    const result = await applySetup(action)
    expect(result.verified).toBe(false)
    const audit = await readAuditEntries()
    expect(audit[0].event).toBe('verify-fail')
    expect(audit[1].event).toBe('apply')
  })

  it('throws SetupUnsupportedError when isSupported returns false (no snapshot, no audit)', async () => {
    const store = new Map<string, string | number | null>()
    const action = makeFakeAction({ store, supported: false })
    await expect(applySetup(action)).rejects.toBeInstanceOf(SetupUnsupportedError)
    expect(store.size).toBe(0)
    expect(await listSnapshots()).toEqual([])
    expect(await readAuditEntries()).toEqual([])
  })

  it('throws SetupBlockedError when guard reports blocked', async () => {
    const store = new Map<string, string | number | null>()
    const action = makeFakeAction({ store, guardBlocked: 'MPC is running' })
    await expect(applySetup(action)).rejects.toBeInstanceOf(SetupBlockedError)
    expect(store.size).toBe(0)
    expect(await listSnapshots()).toEqual([])
  })
})

describe('restoreSetup', () => {
  it('restores the original state and marks the snapshot restored', async () => {
    const store = new Map<string, string | number | null>([['EnableWebServer', 0]])
    const action = makeFakeAction({ store })
    const { snapshot } = await applySetup(action)
    expect(store.get('EnableWebServer')).toBe(1)

    await restoreSetup(snapshot.id, action)
    expect(store.get('EnableWebServer')).toBe(0)

    const reloaded = (await listSnapshots()).find((s) => s.id === snapshot.id)
    expect(reloaded?.restoredAt).toBeTruthy()

    const audit = await readAuditEntries()
    // newest first: restore, verify-ok, apply
    expect(audit.map((e) => e.event)).toEqual(['restore', 'verify-ok', 'apply'])
  })

  it('refuses to restore a snapshot that was already restored', async () => {
    const store = new Map<string, string | number | null>()
    const action = makeFakeAction({ store })
    const { snapshot } = await applySetup(action)
    await restoreSetup(snapshot.id, action)
    await expect(restoreSetup(snapshot.id, action)).rejects.toThrow(/already restored/)
  })

  it('refuses to restore with a mismatched action', async () => {
    const store = new Map<string, string | number | null>()
    const a = makeFakeAction({ store })
    const { snapshot } = await applySetup(a)
    const b = { ...a, id: 'other-action' } as SetupAction
    await expect(restoreSetup(snapshot.id, b)).rejects.toThrow(/was created by/)
  })

  it('throws when the snapshot id is unknown', async () => {
    const store = new Map<string, string | number | null>()
    const action = makeFakeAction({ store })
    await expect(restoreSetup('no-such-id', action)).rejects.toThrow(/not found/)
  })
})
