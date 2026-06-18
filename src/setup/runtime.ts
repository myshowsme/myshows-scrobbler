import { appendAudit } from './audit-log.js'
import { mintSnapshotId, saveSnapshot, loadSnapshot } from './snapshot-store.js'
import type { SetupAction, SetupSnapshot, SetupChange } from './types.js'

/**
 * Apply/restore orchestration. The runtime wraps a `SetupAction` with the
 * snapshot + audit + guard machinery so individual actions only have to
 * implement their domain-specific writes.
 */

export class SetupBlockedError extends Error {
  /** Stable code the UI maps to a localized message (`setup.reason.<code>`). */
  readonly code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'SetupBlockedError'
    this.code = code
  }
}

export class SetupUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SetupUnsupportedError'
  }
}

export interface ApplyResult {
  snapshot: SetupSnapshot
  /** True if `action.verify()` succeeded after apply. */
  verified: boolean
}

/**
 * Apply an action with full safety:
 *   1. platform support check
 *   2. guard (player-running, etc.) — refusal surfaces as SetupBlockedError
 *   3. diff() to capture current state
 *   4. action.apply()
 *   5. snapshot persisted
 *   6. audit log entry written
 *   7. action.verify() best-effort, separate audit entry for the outcome
 *
 * Returns the snapshot (with the id the caller can use later for restore).
 */
export async function applySetup(action: SetupAction): Promise<ApplyResult> {
  if (!(await action.isSupported())) {
    throw new SetupUnsupportedError(`Setup action "${action.id}" is not supported on this platform`)
  }

  if (action.guard) {
    const guard = await action.guard()
    if (guard.blocked) {
      throw new SetupBlockedError(
        guard.reason ?? `Setup action "${action.id}" blocked`,
        guard.reasonCode,
      )
    }
  }

  const changes = await action.diff()
  // Snapshot: each change becomes a restore-instruction by swapping current
  // into next. That way `restore()` receives entries in the same shape as
  // `apply()` and players don't need a separate restore protocol.
  const previousChanges: SetupChange[] = changes.map((c) => ({
    kind: c.kind,
    target: c.target,
    property: c.property,
    current: c.next,
    next: c.current,
  }))

  await action.apply(changes)

  const snapshot: SetupSnapshot = {
    id: mintSnapshotId(),
    actionId: action.id,
    player: action.player,
    appliedAt: new Date().toISOString(),
    previousChanges,
    appliedChanges: changes,
  }
  await saveSnapshot(snapshot)
  await appendAudit({
    timestamp: snapshot.appliedAt,
    actionId: action.id,
    player: action.player,
    event: 'apply',
    snapshotId: snapshot.id,
  })

  let verified = false
  try {
    verified = await action.verify()
  } catch {
    verified = false
  }
  await appendAudit({
    timestamp: new Date().toISOString(),
    actionId: action.id,
    player: action.player,
    event: verified ? 'verify-ok' : 'verify-fail',
    snapshotId: snapshot.id,
  })

  return { snapshot, verified }
}

/**
 * Snapshot-less revert. Used when an action is in the "applied" state but
 * the snapshot file is gone (cleared between installs, dev-build leftover,
 * a user who wiped userData). We synthesise a change list from `diff()` by
 * setting `next: null` on every entry — the action's `restore()` then deletes
 * those properties. Trade-off: loses whatever the user originally had in the
 * touched keys. Without this, an applied action is impossible to turn off.
 */
export async function forceRestoreSetup(action: SetupAction): Promise<void> {
  const changes = await action.diff()
  const wipe: SetupChange[] = changes.map((c) => ({
    kind: c.kind,
    target: c.target,
    property: c.property,
    current: c.next,
    next: null,
  }))
  await action.restore(wipe)
  await appendAudit({
    timestamp: new Date().toISOString(),
    actionId: action.id,
    player: action.player,
    event: 'restore',
    message: 'force-restore (no snapshot)',
  })
}

/**
 * Restore a previously-applied snapshot. Refuses to restore a snapshot that
 * was already restored — the caller should re-apply instead. Mutates the
 * snapshot file to record `restoredAt`.
 */
export async function restoreSetup(snapshotId: string, action: SetupAction): Promise<void> {
  const snapshot = await loadSnapshot(snapshotId)
  if (!snapshot) {
    throw new Error(`Snapshot not found: ${snapshotId}`)
  }
  if (snapshot.actionId !== action.id) {
    throw new Error(
      `Snapshot ${snapshotId} was created by "${snapshot.actionId}", not "${action.id}"`,
    )
  }
  if (snapshot.restoredAt) {
    throw new Error(`Snapshot ${snapshotId} was already restored at ${snapshot.restoredAt}`)
  }

  await action.restore(snapshot.previousChanges)

  snapshot.restoredAt = new Date().toISOString()
  await saveSnapshot(snapshot)
  await appendAudit({
    timestamp: snapshot.restoredAt,
    actionId: action.id,
    player: action.player,
    event: 'restore',
    snapshotId,
  })
}
