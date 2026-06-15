import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Helpers for reading/writing IINA's macOS preferences (`com.colliderli.iina`).
 *
 * IINA is mpv under the hood. Pointing its mpv `input-ipc-server` option at a
 * socket makes that exact JSON IPC available — the same protocol the standalone
 * mpv adapter speaks. IINA exposes arbitrary mpv options through two prefs:
 *   - `enableAdvancedSettings` (Bool) — master switch; userOptions are ignored
 *     unless this is on.
 *   - `userOptions` (Array of [key, value] string pairs) — the mpv overrides.
 *
 * We manipulate those via `defaults`. `userOptions` is read by extracting just
 * that key to JSON (`plutil -extract`) — NOT by converting the whole domain,
 * which fails ("Invalid object in plist for JSON format") because IINA's plist
 * also stores non-JSON values (window frames, etc.). Converting the whole domain
 * used to make the read return empty, so a configured IINA showed as "not
 * applied" in the UI.
 *
 * IINA flushes its in-memory prefs to disk on quit, so it must be closed while
 * we write — otherwise it clobbers our change on exit. The setup action's guard
 * enforces that.
 */

export const IINA_DOMAIN = 'com.colliderli.iina'
export const ADVANCED_KEY = 'enableAdvancedSettings'
export const USER_OPTIONS_KEY = 'userOptions'

/** A single mpv option override as IINA stores it: [key, value]. */
export type UserOption = [string, string]

export interface IinaPrefs {
  /** Whether the master "advanced settings" switch is on. */
  advancedEnabled: boolean
  /** True when `enableAdvancedSettings` is present in the plist at all. */
  advancedPresent: boolean
  /** mpv option overrides. */
  userOptions: UserOption[]
}

/** Read IINA's relevant preferences. Returns empty defaults when IINA has none. */
export async function readIinaPrefs(): Promise<IinaPrefs> {
  const [userOptions, advanced] = await Promise.all([readUserOptions(), readAdvanced()])
  return {
    advancedEnabled: advanced.value,
    advancedPresent: advanced.present,
    userOptions,
  }
}

async function readUserOptions(): Promise<UserOption[]> {
  try {
    // Extract only userOptions to JSON — a whole-domain `plutil -convert json`
    // throws on IINA's non-JSON values and would zero out the read.
    const { stdout } = await execFileAsync('/bin/sh', [
      '-c',
      `defaults export ${IINA_DOMAIN} - | plutil -extract ${USER_OPTIONS_KEY} json -o - -`,
    ])
    return parseUserOptions(JSON.parse(stdout))
  } catch {
    // Key (or whole domain) absent.
    return []
  }
}

async function readAdvanced(): Promise<{ present: boolean; value: boolean }> {
  try {
    const { stdout } = await execFileAsync('defaults', ['read', IINA_DOMAIN, ADVANCED_KEY])
    return { present: true, value: stdout.trim() === '1' }
  } catch {
    return { present: false, value: false }
  }
}

/** Coerce IINA's `userOptions` plist value into a clean [key, value][] list. */
export function parseUserOptions(raw: unknown): UserOption[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const out: UserOption[] = []
  for (const entry of raw) {
    if (Array.isArray(entry) && entry.length >= 2) {
      out.push([String(entry[0]), String(entry[1])])
    }
  }
  return out
}

// ── Pure list operations (unit-testable, no IO) ──

export function getOption(options: UserOption[], key: string): string | null {
  const hit = options.find(([k]) => k === key)
  return hit ? hit[1] : null
}

/** Set `key=value`, replacing any existing entry for `key`. */
export function upsertOption(options: UserOption[], key: string, value: string): UserOption[] {
  return [...options.filter(([k]) => k !== key), [key, value]]
}

export function removeOption(options: UserOption[], key: string): UserOption[] {
  return options.filter(([k]) => k !== key)
}

// ── Writes (via `defaults`) ──

export async function setAdvancedEnabled(enabled: boolean): Promise<void> {
  await execFileAsync('defaults', [
    'write',
    IINA_DOMAIN,
    ADVANCED_KEY,
    '-bool',
    enabled ? 'YES' : 'NO',
  ])
}

export async function deleteKey(key: string): Promise<void> {
  try {
    await execFileAsync('defaults', ['delete', IINA_DOMAIN, key])
  } catch {
    // Key absent — nothing to delete.
  }
}

/**
 * Persist `userOptions`. Writes the whole array as an old-style plist literal
 * (`defaults` parses it natively); an empty list deletes the key so we never
 * leave a stray empty array behind.
 */
export async function writeUserOptions(options: UserOption[]): Promise<void> {
  if (options.length === 0) {
    await deleteKey(USER_OPTIONS_KEY)
    return
  }
  const literal = `(${options.map(([k, v]) => `(${quote(k)}, ${quote(v)})`).join(', ')})`
  await execFileAsync('defaults', ['write', IINA_DOMAIN, USER_OPTIONS_KEY, literal])
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}
