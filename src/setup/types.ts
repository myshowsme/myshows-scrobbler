import type { PlayerId } from '../utils/process-monitor.js'

/**
 * One-click setup framework — types.
 *
 * The framework lets us flip a flag in a third-party player's config (Windows
 * registry, INI file, etc.) with explicit consent, snapshot the previous state,
 * and reversibly restore it later. Each "setup action" implements the
 * `SetupAction` interface; the runtime in `runtime.ts` wraps apply/restore with
 * snapshot+audit guards so individual actions don't reinvent that machinery.
 *
 * Why this exists as a framework instead of ad-hoc per-player code: writing
 * other people's player configs is a trust contract. The framework enforces
 * the seven principles (consent, snapshot, atomic restore, diff display,
 * not-while-running, detect external changes, audit log) once, in one place.
 */

/** Kind of storage the action will mutate. */
export type SetupTargetKind = 'windows-registry' | 'ini-file' | 'text-file' | 'macos-defaults'

/**
 * A single property the action touches. The `current` field is captured at
 * `diff()` time and used to construct the restore snapshot; `next` is what
 * the action would write.
 *
 * Both can be `null`. `current: null` means "currently absent" (we will create
 * it). `next: null` means "delete it" (used during restore when we created
 * a key from scratch).
 */
export interface SetupChange {
  kind: SetupTargetKind
  /** Human-readable target path: registry key, file path, or similar. */
  target: string
  /** Property identifier within `target`: registry value name or INI key. */
  property: string
  current: string | number | null
  next: string | number | null
}

/** Result of inspecting whether a player is in a state where we shouldn't write. */
export interface PlayerGuardResult {
  /** True if we should refuse to apply (e.g. the player is running). */
  blocked: boolean
  /** User-facing reason when blocked. English fallback; the UI prefers `reasonCode`. */
  reason?: string
  /**
   * Stable, language-agnostic code for the block reason (e.g. `player-running`).
   * The UI maps it to a localized string (`setup.reason.<code>`); `reason` is
   * only shown when no code is provided.
   */
  reasonCode?: string
}

export interface SetupAction {
  /** Stable identifier — used in URLs, snapshot filenames, audit log. kebab-case. */
  id: string
  player: PlayerId
  /** Short user-facing name shown on the action card. */
  name: string
  /** One-paragraph description shown in the consent modal. */
  description: string
  /** Platform/feature predicate. False ⇒ action hidden from UI. */
  isSupported(): Promise<boolean>
  /**
   * Inspect what would change if applied. Returns one entry per property; each
   * entry has both `current` and `next` set. The UI displays this as a diff.
   *
   * When `current === next` for every entry, the action is already applied —
   * `isApplied()` is derived from this.
   */
  diff(): Promise<SetupChange[]>
  /**
   * Per-instance guard. The framework calls this before `apply()`; if the
   * result is `blocked: true`, the apply is refused with `reason` surfaced
   * to the UI. Typically checks "is the player running" via process scan.
   */
  guard?(): Promise<PlayerGuardResult>
  /** Write the changes. Must be idempotent — second call must succeed. */
  apply(changes: SetupChange[]): Promise<void>
  /**
   * Restore from a snapshot's recorded previous state. The `previous` array
   * comes from the snapshot file and contains the original `current` values
   * (now in the `next` field — see snapshot-store.ts for the swap convention).
   */
  restore(previous: SetupChange[]): Promise<void>
  /**
   * After apply and (typically) a player restart, confirm the change worked.
   * Implementations usually try to connect to the now-enabled HTTP endpoint
   * or open the IPC pipe. Returns false on any failure (no throwing).
   */
  verify(): Promise<boolean>
}

export interface SetupSnapshot {
  /** UUID; also used as the JSON filename in `setup-snapshots/`. */
  id: string
  actionId: string
  player: PlayerId
  /** ISO timestamp when applied. */
  appliedAt: string
  /** ISO timestamp when restored. Absent ⇒ still active. */
  restoredAt?: string
  /**
   * Original state. Each entry's `next` field carries the value that
   * `restore()` should write back (so restore semantics mirror apply).
   */
  previousChanges: SetupChange[]
  /** The state after apply — what we actually wrote. */
  appliedChanges: SetupChange[]
}

/** Append-only audit log entry. One per apply / restore / verify outcome. */
export interface AuditEntry {
  timestamp: string
  actionId: string
  player: PlayerId
  event: 'apply' | 'restore' | 'verify-ok' | 'verify-fail' | 'external-change-detected'
  snapshotId?: string
  message?: string
}
