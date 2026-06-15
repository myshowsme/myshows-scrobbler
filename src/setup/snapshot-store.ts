import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getConfigPath } from '../config.js'
import type { SetupSnapshot } from './types.js'

/**
 * Snapshot persistence: one JSON file per applied setup action, stored in the
 * project's data dir next to `config.json`. The filename is the snapshot id;
 * the contents are the full `SetupSnapshot` shape.
 *
 * Tests override the directory via `setSnapshotDir`. In production it's
 * derived from the active config path so a CLI `--config` override puts
 * snapshots alongside the chosen config file.
 */

let snapshotDirOverride: string | null = null

function snapshotDir(): string {
  if (snapshotDirOverride) {
    return snapshotDirOverride
  }
  return path.join(path.dirname(getConfigPath()), 'setup-snapshots')
}

export function setSnapshotDir(dir: string | null): void {
  snapshotDirOverride = dir
}

async function ensureDir(): Promise<string> {
  const dir = snapshotDir()
  await fs.mkdir(dir, { recursive: true })
  return dir
}

function snapshotPath(dir: string, id: string): string {
  return path.join(dir, `${id}.json`)
}

export function mintSnapshotId(): string {
  return randomUUID()
}

export async function saveSnapshot(snapshot: SetupSnapshot): Promise<SetupSnapshot> {
  const dir = await ensureDir()
  await fs.writeFile(snapshotPath(dir, snapshot.id), JSON.stringify(snapshot, null, 2), 'utf8')
  return snapshot
}

export async function loadSnapshot(id: string): Promise<SetupSnapshot | null> {
  const dir = await ensureDir()
  try {
    const raw = await fs.readFile(snapshotPath(dir, id), 'utf8')
    return JSON.parse(raw) as SetupSnapshot
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw err
  }
}

/** List all snapshots, newest first. Corrupt entries are silently skipped — the audit log is the source of truth for "what happened". */
export async function listSnapshots(): Promise<SetupSnapshot[]> {
  const dir = await ensureDir()
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw err
  }
  const snapshots: SetupSnapshot[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue
    }
    try {
      const raw = await fs.readFile(path.join(dir, file), 'utf8')
      snapshots.push(JSON.parse(raw) as SetupSnapshot)
    } catch {
      continue
    }
  }
  return snapshots.sort((a, b) => b.appliedAt.localeCompare(a.appliedAt))
}
