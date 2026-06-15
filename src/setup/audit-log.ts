import fs from 'node:fs/promises'
import path from 'node:path'
import { getConfigPath } from '../config.js'
import type { AuditEntry } from './types.js'

/**
 * Append-only audit log for one-click setup actions. JSON lines format —
 * one `AuditEntry` per line. Lives next to `config.json` by default;
 * overridable via `setAuditLogPath` for tests.
 *
 * This is intentionally separate from the snapshot store: snapshots are
 * the *state* needed to restore, the audit log is the *narrative* shown
 * to the user ("we applied X at 12:34, you restored it at 18:00").
 */

let logPathOverride: string | null = null

function logPath(): string {
  if (logPathOverride) {
    return logPathOverride
  }
  return path.join(path.dirname(getConfigPath()), 'setup-audit.log')
}

export function setAuditLogPath(p: string | null): void {
  logPathOverride = p
}

export async function appendAudit(entry: AuditEntry): Promise<void> {
  const file = logPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, JSON.stringify(entry) + '\n', 'utf8')
}

/** Read the last `limit` entries, newest first. Malformed lines are skipped. */
export async function readAuditEntries(limit = 100): Promise<AuditEntry[]> {
  let raw: string
  try {
    raw = await fs.readFile(logPath(), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw err
  }
  const lines = raw.split('\n').filter((line) => line.length > 0)
  const tail = lines.slice(-limit)
  const entries: AuditEntry[] = []
  for (const line of tail) {
    try {
      entries.push(JSON.parse(line) as AuditEntry)
    } catch {
      continue
    }
  }
  return entries.reverse()
}
