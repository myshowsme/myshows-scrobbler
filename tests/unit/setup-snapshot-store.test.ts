import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  setSnapshotDir,
  saveSnapshot,
  loadSnapshot,
  listSnapshots,
  mintSnapshotId,
} from '../../src/setup/snapshot-store.js'
import type { SetupSnapshot } from '../../src/setup/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scrobbler-snapshot-'))
  setSnapshotDir(tmpDir)
})

afterEach(async () => {
  setSnapshotDir(null)
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function makeSnapshot(overrides: Partial<SetupSnapshot> = {}): SetupSnapshot {
  return {
    id: overrides.id ?? mintSnapshotId(),
    actionId: 'fake-action',
    player: 'mpc',
    appliedAt: '2026-05-28T10:00:00.000Z',
    previousChanges: [],
    appliedChanges: [],
    ...overrides,
  }
}

describe('snapshot-store', () => {
  it('saves and loads a snapshot by id', async () => {
    const snap = makeSnapshot({ appliedAt: '2026-05-28T11:00:00.000Z' })
    await saveSnapshot(snap)
    const loaded = await loadSnapshot(snap.id)
    expect(loaded).toEqual(snap)
  })

  it('returns null for unknown id', async () => {
    expect(await loadSnapshot('does-not-exist')).toBeNull()
  })

  it('lists snapshots newest-first by appliedAt', async () => {
    await saveSnapshot(makeSnapshot({ appliedAt: '2026-05-28T08:00:00.000Z' }))
    await saveSnapshot(makeSnapshot({ appliedAt: '2026-05-28T12:00:00.000Z' }))
    await saveSnapshot(makeSnapshot({ appliedAt: '2026-05-28T10:00:00.000Z' }))
    const all = await listSnapshots()
    expect(all.map((s) => s.appliedAt)).toEqual([
      '2026-05-28T12:00:00.000Z',
      '2026-05-28T10:00:00.000Z',
      '2026-05-28T08:00:00.000Z',
    ])
  })

  it('persists restoredAt when a snapshot is re-saved after restore', async () => {
    const snap = makeSnapshot()
    await saveSnapshot(snap)
    snap.restoredAt = '2026-05-28T15:00:00.000Z'
    await saveSnapshot(snap)
    const loaded = await loadSnapshot(snap.id)
    expect(loaded?.restoredAt).toBe('2026-05-28T15:00:00.000Z')
  })

  it('returns [] when the snapshot dir is empty', async () => {
    expect(await listSnapshots()).toEqual([])
  })
})
