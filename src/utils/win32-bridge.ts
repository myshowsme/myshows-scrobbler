/**
 * Win32 FFI bridge — koffi bindings for the user32.dll calls we need.
 *
 * koffi is loaded lazily (via require) on first use, and only on Windows. The
 * static `import` is intentionally avoided: koffi is a native addon, and merely
 * importing it loads its `.node` binary into the process — which is pure
 * overhead on non-Windows hosts (its only consumer is the Windows PotPlayer
 * probe) and outright fails to load on musl/Alpine. Deferring the require keeps
 * the server bootable on glibc *and* musl, with no koffi load on Linux/macOS at
 * all. All exported helpers throw on non-win32.
 *
 * Currently only the PotPlayer precise probe uses this. Other Win32 needs
 * (SMTC, MPC IPC if it ever becomes feasible) get added here as they appear.
 */

import { createRequire } from 'node:module'

const isWindows = process.platform === 'win32'

// Type-only — `typeof import(...)` is erased by the compiler and does NOT emit
// a runtime import, so the native addon stays unloaded until ensureBound().
type KoffiModule = (typeof import('koffi'))['default']
type KoffiLib = ReturnType<KoffiModule['load']>
type KoffiFunc = ReturnType<KoffiLib['func']>

const require = createRequire(import.meta.url)

let koffi: KoffiModule | null = null
let user32Lib: KoffiLib | null = null
let _findWindowW: KoffiFunc | null = null
let _sendMessageW: KoffiFunc | null = null

function ensureBound(): void {
  if (_findWindowW && _sendMessageW) {
    return
  }
  if (!isWindows) {
    throw new Error('win32-bridge: Windows-only API; current platform is ' + process.platform)
  }
  if (!koffi) {
    koffi = require('koffi') as KoffiModule
  }
  if (!user32Lib) {
    user32Lib = koffi.load('user32.dll')
  }
  // FindWindowW(LPCWSTR lpClassName, LPCWSTR lpWindowName) -> HWND
  //   HWND is a pointer-sized opaque handle; koffi returns `null` for NULL.
  _findWindowW = user32Lib.func('FindWindowW', 'void *', ['str16', 'str16'])
  // SendMessageW(HWND hWnd, UINT Msg, WPARAM wParam, LPARAM lParam) -> LRESULT
  //   On x64 Windows, WPARAM/LPARAM/LRESULT are all 64-bit; on x86 they're 32-bit.
  //   Using intptr_t/uintptr_t keeps this platform-correct.
  _sendMessageW = user32Lib.func('SendMessageW', 'intptr_t', [
    'void *',
    'uint',
    'uintptr_t',
    'intptr_t',
  ])
}

/**
 * Opaque Win32 window handle. koffi returns the underlying pointer-shaped
 * value; we treat it as a non-nullable opaque token so `Hwnd | null` in return
 * types stays meaningful (a found-vs-not-found distinction).
 */
export type Hwnd = NonNullable<unknown>

/**
 * Find a top-level window by class name and/or window title. Either argument
 * may be null to match anything. Returns `null` if no window matches.
 */
export function findWindow(className: string | null, windowName: string | null): Hwnd | null {
  ensureBound()
  const hwnd = (_findWindowW as (cn: string | null, wn: string | null) => unknown)(
    className,
    windowName,
  )
  // koffi normalises a NULL pointer to `null`; both 0n (BigInt) and 0 are also
  // treated as "not found" defensively.
  if (hwnd === null || hwnd === undefined || hwnd === 0 || hwnd === 0n) {
    return null
  }
  return hwnd
}

/**
 * Synchronously send a Win32 message and return the LRESULT.
 *
 * NOTE: SendMessage *blocks* until the receiving window's WndProc returns.
 * For PotPlayer-style query messages this is fine (the player responds
 * synchronously with an integer). Do NOT use against unresponsive windows —
 * use SendMessageTimeout if that ever becomes a concern.
 *
 * Numeric range: WPARAM/LPARAM/LRESULT are 64-bit on x64. JS numbers safely
 * represent up to 2^53; PotPlayer's biggest return value (duration in ms) fits
 * comfortably under that even for 100+ hour videos. We accept `number` here
 * and let koffi widen.
 */
export function sendMessage(hwnd: Hwnd, msg: number, wParam: number, lParam: number): number {
  ensureBound()
  const result = (
    _sendMessageW as (h: unknown, m: number, w: number, l: number) => number | bigint
  )(hwnd, msg, wParam, lParam)
  // intptr_t can come back as either number or bigint depending on koffi build /
  // value range; normalise to plain number (safe here — see the note above).
  return typeof result === 'bigint' ? Number(result) : result
}

/** True if this module's calls are usable on the current platform. */
export function isWin32(): boolean {
  return isWindows
}
