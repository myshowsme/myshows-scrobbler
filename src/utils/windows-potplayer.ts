import { findWindow, sendMessage, isWin32, type Hwnd } from './win32-bridge.js'

/**
 * Windows PotPlayer precise probe — talks directly to the running PotPlayer
 * window via documented WM_USER messages. Zero user configuration.
 *
 * Protocol (PotPlayer's public external-control API): wParam carries the
 * command, lParam carries the *value* for setters.
 *   SendMessage(hwnd, WM_USER, 0x5006, 0) -> playback status
 *     -1/0 = stopped, 1 = paused, 2 = playing
 *   SendMessage(hwnd, WM_USER, 0x5002, 0) -> total duration in milliseconds
 *   SendMessage(hwnd, WM_USER, 0x5004, 0) -> current position in milliseconds
 *
 * Only POT_GET_* commands belong here. The 0x500x block interleaves getters
 * and setters (0x5001 POT_SET_VOLUME, 0x5005 POT_SET_CURRENT_TIME, 0x5007
 * POT_SET_PLAY_STATUS, ...), so a wrong constant does not fail loudly — it
 * silently drives the user's player with lParam 0 on every poll.
 *
 * No file path is exposed by these messages. The adapter recovers the filename
 * from the process scan's window-title pass (`filenameFromWindowTitle`), so
 * the probe only contributes the precise position/duration/state reading.
 *
 * Window class names: PotPlayer ships as either 32-bit ("PotPlayer") or 64-bit
 * ("PotPlayer64"). We try the 64-bit name first since modern installs default
 * to it. PotPlayerMini variants register the same class names.
 */

const WM_USER = 0x0400

const POTPLAYER_CMD = {
  GET_TOTAL_TIME_MS: 0x5002,
  GET_PLAYBACK_TIME_MS: 0x5004,
  GET_PLAYBACK_STATUS: 0x5006,
} as const

const POTPLAYER_WINDOW_CLASSES = ['PotPlayer64', 'PotPlayer'] as const

export interface PotPlayerPlayback {
  isPlaying: boolean
  /** PotPlayer also reports a `paused` state; we collapse it to !isPlaying.
   *  Kept as a distinct field in case downstream wants to distinguish stopped
   *  from paused later. */
  isPaused: boolean
  positionSeconds: number
  durationSeconds: number
}

function findPotPlayerWindow(): Hwnd | null {
  for (const cls of POTPLAYER_WINDOW_CLASSES) {
    const hwnd = findWindow(cls, null)
    if (hwnd) {
      return hwnd
    }
  }
  return null
}

/**
 * Probe for a running PotPlayer instance. Returns null if PotPlayer is not
 * running, not on Windows, or the messages return zero duration (player is
 * idle / hasn't loaded a file yet).
 *
 * Synchronous in practice (SendMessage blocks until WndProc returns), but
 * declared async so the call site is uniform with the other probes (OSA,
 * MPRIS, SMTC) which are genuinely async.
 */
export async function probeWindowsPotPlayer(): Promise<PotPlayerPlayback | null> {
  if (!isWin32()) {
    return null
  }
  const hwnd = findPotPlayerWindow()
  if (!hwnd) {
    return null
  }
  let status: number
  let durationMs: number
  let positionMs: number
  try {
    status = sendMessage(hwnd, WM_USER, POTPLAYER_CMD.GET_PLAYBACK_STATUS, 0)
    durationMs = sendMessage(hwnd, WM_USER, POTPLAYER_CMD.GET_TOTAL_TIME_MS, 0)
    positionMs = sendMessage(hwnd, WM_USER, POTPLAYER_CMD.GET_PLAYBACK_TIME_MS, 0)
  } catch {
    return null
  }
  // PotPlayer with no file loaded reports duration 0 — nothing to scrobble.
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return null
  }
  // Clamp position to non-negative finite. Some PotPlayer builds briefly
  // report -1 (or huge values) during track changes.
  if (!Number.isFinite(positionMs) || positionMs < 0) {
    positionMs = 0
  }
  if (positionMs > durationMs) {
    positionMs = durationMs
  }
  return {
    isPlaying: status === 2,
    isPaused: status === 1,
    positionSeconds: positionMs / 1000,
    durationSeconds: durationMs / 1000,
  }
}
