/**
 * Windows "launch at login" bookkeeping, split out from electron.ts so the
 * registry reasoning is unit-testable without an Electron app instance.
 *
 * Windows autostart lives in a single HKCU Run value written by
 * `app.setLoginItemSettings`. The subtlety is on the way back out:
 * `getLoginItemSettings().openAtLogin` compares the *whole* stored command
 * line — executable **and** arguments — against what it is asked about. We
 * register with `--hidden`, so a bare `getLoginItemSettings()` reports
 * `openAtLogin: false` even when the entry is right there, which is what makes
 * the tray checkbox look like it forgot the setting.
 */

/** Command-line args the login item is registered with (start parked in the tray). */
export const AUTOSTART_ARGS = ['--hidden']

/** The subset of Electron's LoginItemSettings this module reasons about. */
export interface LoginItemSnapshot {
  /** Exact path+args match against what we asked about. */
  openAtLogin: boolean
  /** Same executable registered with *any* args, and not switched off in Task Manager. */
  executableWillLaunchAtLogin: boolean
  /** Every Run entry Electron could parse, ours included. */
  launchItems?: { path?: string; enabled?: boolean }[]
}

function samePath(a: string | undefined, b: string): boolean {
  // Windows paths are case-insensitive, and the registry keeps whatever casing
  // the writer used — compare case-folded.
  return (a ?? '').toLowerCase() === b.toLowerCase()
}

/**
 * True when this executable will actually start at login. Falls back to
 * `executableWillLaunchAtLogin` so entries written by an older build (different
 * args) still read as enabled instead of silently looking lost.
 */
export function isWindowsAutostartActive(snapshot: LoginItemSnapshot): boolean {
  return snapshot.openAtLogin || snapshot.executableWillLaunchAtLogin
}

/**
 * True when a Run entry pointing at this executable exists at all — including
 * one the user switched off in Task Manager, which reports
 * `executableWillLaunchAtLogin: false` but is very much still registered.
 */
export function hasWindowsLaunchItem(snapshot: LoginItemSnapshot, execPath: string): boolean {
  return (snapshot.launchItems ?? []).some((item) => samePath(item.path, execPath))
}

/**
 * True when the stored preference says "launch at login" but Windows has no
 * entry for this executable at all — the state after a reinstall that landed
 * the app on a different path, or anything else that dropped the Run value.
 *
 * An entry that exists but is disabled in Task Manager is deliberately *not*
 * repaired: that is the user overruling us, and re-registering on every launch
 * would take the choice away from them.
 */
export function shouldRepairWindowsAutostart(
  preference: boolean | null,
  snapshot: LoginItemSnapshot,
  execPath: string,
): boolean {
  if (preference !== true) {
    return false
  }
  if (isWindowsAutostartActive(snapshot)) {
    return false
  }
  return !hasWindowsLaunchItem(snapshot, execPath)
}
