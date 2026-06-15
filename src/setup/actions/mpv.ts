import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { SetupAction, SetupChange } from '../types.js'
import { readIni, getIniValue, writeIniValue, deleteIniValue } from '../helpers/ini-file.js'
import { defaultMpvSocketPath, queryMpvProperties } from '../../utils/mpv-ipc.js'
import { debug } from '../../logger.js'

/**
 * mpv "enable JSON IPC" one-click setup action.
 *
 * mpv reads `mpv.conf` only at launch and never rewrites it, so — unlike MPC —
 * there's no "close it first" guard; the change simply takes effect on the
 * next mpv start. We append a single line:
 *
 *   input-ipc-server=<platform default socket>
 *
 * The same socket path is what `MpvIpcAdapter` connects to, so apply + restart
 * mpv + enable the `mpv` source is the whole flow.
 *
 * `mpv.conf` is a flat key=value file (no sections), so we use the INI helper
 * with a null section.
 */

const IPC_KEY = 'input-ipc-server'

/**
 * Resolve the mpv.conf path mpv itself would read at launch.
 *
 * Mirrors mpv's own lookup order on Windows so portable builds (the common
 * sourceforge .7z install) get their config in the right place — writing to
 * %APPDATA% there silently does nothing because mpv never looks at it.
 *
 * Order (Windows):
 *   1. `$MPV_HOME\mpv.conf` if `MPV_HOME` is set.
 *   2. `portable_config\mpv.conf` next to `mpv.exe`, if that dir already
 *      exists. Portable mpv (sourceforge build) reads this and ignores
 *      %APPDATA% entirely. Detected by locating `mpv.exe` via `where mpv`
 *      and checking for the sibling `portable_config` directory.
 *   3. `%APPDATA%\mpv\mpv.conf` — what installed builds (and portable builds
 *      with no `portable_config` dir) actually use.
 *
 * Unix is simple: `~/.config/mpv/mpv.conf`.
 *
 * Async because finding mpv.exe shells out to `where`. Errors at any step
 * fall through to the next fallback rather than throw, so a missing mpv
 * binary still resolves to %APPDATA%.
 *
 * Result is cached per-process — mpv's install location doesn't change
 * mid-session, and the UI calls `diff()` once per setup-action card on every
 * render. Without the cache each render shells out to `cmd /c where mpv`,
 * which is the single most expensive thing in the setup pipeline. The cache
 * holds a Promise so concurrent diffs share one resolution.
 */
let cachedMpvConfPath: Promise<string> | null = null

export async function resolveMpvConfPath(): Promise<string> {
  if (!cachedMpvConfPath) {
    cachedMpvConfPath = resolveMpvConfPathUncached()
  }
  return cachedMpvConfPath
}

/** Drop the cache. For tests that change env mid-run. */
export function clearMpvConfPathCache(): void {
  cachedMpvConfPath = null
}

async function resolveMpvConfPathUncached(): Promise<string> {
  const resolved = await resolveMpvConfPathForPlatform()
  debug(`mpv conf resolved → ${resolved}`)
  return resolved
}

async function resolveMpvConfPathForPlatform(): Promise<string> {
  if (process.platform !== 'win32') {
    // macOS and Linux both default to ~/.config/mpv/mpv.conf for modern mpv.
    return path.join(os.homedir(), '.config', 'mpv', 'mpv.conf')
  }
  if (process.env.MPV_HOME) {
    return path.join(process.env.MPV_HOME, 'mpv.conf')
  }
  const portable = await findPortableMpvConfPath()
  if (portable) {
    return portable
  }
  return path.join(
    process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
    'mpv',
    'mpv.conf',
  )
}

/**
 * Locate `mpv.exe` via PATH (using Windows' `where`) and return the
 * `portable_config\mpv.conf` path next to it — but only if `portable_config`
 * already exists. mpv only treats the install as portable when that directory
 * is present, so we mirror that rule. Returns null otherwise.
 */
async function findPortableMpvConfPath(): Promise<string | null> {
  const exe = await whichMpvExe()
  if (!exe) {
    return null
  }
  const portableDir = path.join(path.dirname(exe), 'portable_config')
  try {
    const stat = await fs.stat(portableDir)
    if (stat.isDirectory()) {
      return path.join(portableDir, 'mpv.conf')
    }
  } catch {
    // portable_config absent → mpv falls back to %APPDATA% anyway.
  }
  return null
}

/**
 * Resolve the first `mpv.exe`/`mpv.com` found in PATH, or null. Windows-only.
 *
 * Goes through `cmd.exe /c where mpv` instead of `spawn('where', …)` directly
 * because PowerShell aliases `where` to `Where-Object`, and depending on how
 * the parent shell propagates its environment, Node's PATH lookup can resolve
 * `where` to that alias (it can't — spawn ignores aliases — but more
 * importantly, this form is what the user can reproduce manually for
 * diagnostics, so it's the same code path on both sides). Output can contain
 * multiple lines (e.g. both `mpv.com` and `mpv.exe` in the same dir); we take
 * the first because both share the install directory we care about.
 */
async function whichMpvExe(): Promise<string | null> {
  const viaWhere = await whichViaCmd()
  if (viaWhere) {
    return viaWhere
  }
  // Fallback 1: walk $env:PATH ourselves. Works when `where` fails but PATH is
  // populated (e.g. `cmd.exe` not on PATH — odd but possible in restricted envs).
  const viaPath = await whichViaPathScan()
  if (viaPath) {
    return viaPath
  }
  // Fallback 2: probe well-known per-user install dirs. Dev servers launched
  // from a context with a stripped PATH (some IDE integrations, container
  // shells) still need the action to find mpv — Scoop and the standard
  // installers all put it in predictable per-user / Program Files locations.
  return whichViaWellKnownDirs()
}

function whichViaCmd(): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('cmd.exe', ['/c', 'where', 'mpv'], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += chunk.toString()
    })
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      if (code !== 0) {
        return resolve(null)
      }
      const first = out.split(/\r?\n/).find((line) => line.trim().length > 0)
      resolve(first ? first.trim() : null)
    })
  })
}

async function whichViaPathScan(): Promise<string | null> {
  const pathEnv = process.env.PATH ?? process.env.Path ?? ''
  const dirs = pathEnv.split(path.delimiter).filter(Boolean)
  // Two candidates per dir × ~30 dirs on a typical Windows PATH means up to
  // 60 stat() calls — running them serially turns this fallback into a real
  // delay when the binary isn't on PATH at all. Probe everything in parallel
  // and let the first hit win.
  const probes = dirs.flatMap((dir) => ['mpv.com', 'mpv.exe'].map((name) => path.join(dir, name)))
  return firstSuccessful(probes, async (p) => {
    await fs.access(p)
    return p
  })
}

/**
 * Probe predictable per-user and machine-wide install locations. Aimed at
 * recovering from the case where `where` returns nothing AND `process.env.PATH`
 * doesn't include the install dir (happens when the dev server is launched
 * from a context that has a stripped PATH — some IDE integrations, login
 * shells with `clean_env`, etc.).
 *
 * Order is per-user first (Scoop / winget / chocolatey-portable) since those
 * are how most Windows users actually get mpv these days; then machine-wide
 * Program Files locations.
 */
async function whichViaWellKnownDirs(): Promise<string | null> {
  const home = os.homedir()
  const candidates: string[] = [
    // Scoop — most common for power users on Windows.
    path.join(home, 'scoop', 'apps', 'mpv', 'current', 'mpv.com'),
    path.join(home, 'scoop', 'apps', 'mpv', 'current', 'mpv.exe'),
    path.join(home, 'scoop', 'shims', 'mpv.exe'),
    // Standard machine-wide installers.
    'C:\\Program Files\\mpv\\mpv.exe',
    'C:\\Program Files (x86)\\mpv\\mpv.exe',
  ]
  return firstSuccessful(candidates, async (c) => {
    await fs.access(c)
    return c
  })
}

/**
 * Run `probe` over every input in parallel and return the first one that
 * resolves; null if all reject. Short-circuits on first success via
 * `Promise.any`, so the latency floor is `min(probe_i)` not `max(probe_i)`.
 */
async function firstSuccessful<T, R>(
  inputs: readonly T[],
  probe: (input: T) => Promise<R>,
): Promise<R | null> {
  if (inputs.length === 0) {
    return null
  }
  try {
    return await Promise.any(inputs.map(probe))
  } catch {
    // AggregateError → all probes rejected.
    return null
  }
}

export const mpvIpcSetupAction: SetupAction = {
  id: 'mpv-ipc',
  player: 'mpv',
  name: 'mpv JSON IPC',
  description:
    'Включает JSON IPC mpv для точного трекинга позиции и состояния. Дописывает строку `input-ipc-server=<сокет>` в mpv.conf. mpv нужно перезапустить, чтобы изменение вступило в силу. Обратимо.',

  async isSupported() {
    // mpv is cross-platform; the IPC mechanism works on win32 (named pipe) and
    // unix (socket) alike.
    return true
  },

  async diff(): Promise<SetupChange[]> {
    const confPath = await resolveMpvConfPath()
    const socket = defaultMpvSocketPath()
    const read = await readIni(confPath)
    const current = read ? getIniValue(read, null, IPC_KEY) : null
    return [
      {
        kind: 'ini-file',
        target: confPath,
        property: IPC_KEY,
        current,
        next: socket,
      },
    ]
  },

  async apply(changes: SetupChange[]): Promise<void> {
    for (const change of changes) {
      if (change.next === null) {
        await deleteIniValue(change.target, null, change.property)
        continue
      }
      await writeIniValue(change.target, null, change.property, String(change.next))
    }
  },

  async restore(previous: SetupChange[]): Promise<void> {
    for (const change of previous) {
      if (change.next === null) {
        // The key didn't exist before we applied — remove our line entirely
        // rather than leaving an empty/placeholder value.
        await deleteIniValue(change.target, null, change.property)
        continue
      }
      await writeIniValue(change.target, null, change.property, String(change.next))
    }
  },

  async verify(): Promise<boolean> {
    // Only succeeds if mpv is already running with the new conf — typically
    // false immediately after apply (user hasn't restarted mpv yet), which is
    // expected. The UI polls verify() until it flips true.
    const props = await queryMpvProperties(defaultMpvSocketPath(), 1000)
    return props !== null
  },
}
