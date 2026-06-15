import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const execAsync = promisify(exec)

/**
 * Resolve the full filesystem path of a media file open by a Windows process,
 * using the NtQuerySystemInformation handle-enumeration trick (see the PS
 * script for details). This is the *only* path-resolution mechanism that
 * works for MPC-BE/HC and similar players that:
 *
 *   - don't pass the file path in argv (Open File dialog, drag-drop, recents)
 *   - don't publish to SMTC
 *   - don't expose a control-plane HTTP API by default
 *
 * Expensive (~1-2s per cold call due to PowerShell startup and full system
 * handle enumeration), so callers must cache aggressively. The exposed
 * function does its own (pid, filenameHint) → fullPath cache to keep the
 * polling loop fast: a long-running player only pays the cost once per
 * (pid, currently-open-file) pair.
 */

interface ResolverReply {
  path: string | null
}

let cachedScriptPath: string | null | undefined

function locateScript(): string | null {
  if (cachedScriptPath !== undefined) {
    return cachedScriptPath
  }
  const here = path.dirname(fileURLToPath(import.meta.url))
  // Packaged Electron app: shipped to Resources via build.extraResources.
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  const candidates = [
    ...(resourcesPath ? [path.join(resourcesPath, 'windows-resolve-handle-path.ps1')] : []),
    path.resolve(here, '../../scripts/windows-resolve-handle-path.ps1'),
    path.resolve(here, '../scripts/windows-resolve-handle-path.ps1'),
    path.resolve(here, '../../../scripts/windows-resolve-handle-path.ps1'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      cachedScriptPath = candidate
      return candidate
    }
  }
  cachedScriptPath = null
  return null
}

/** Cache entry. `path: null` is a *negative* cache — remember that resolution failed
 *  for this (pid, filename) so we don't keep paying the PowerShell cost. */
interface CacheEntry {
  path: string | null
  /** When the entry was recorded; we evict negative entries after a short TTL
   *  in case the user just hadn't started playback yet when we first probed. */
  recordedAt: number
}

const cache = new Map<string, CacheEntry>()
const NEGATIVE_TTL_MS = 60_000

function cacheKey(pid: number, filename: string): string {
  return `${pid}::${filename.toLowerCase()}`
}

/** Reset internal cache. Test helper. */
export function _resetHandleResolverCache(): void {
  cache.clear()
}

/**
 * Spawn the PowerShell helper and resolve the full file path for `filenameHint`
 * open by process `pid`. Returns null when:
 *   - non-Windows platform
 *   - script can't be located on disk (packed build without scripts/)
 *   - PowerShell call failed / timed out
 *   - process doesn't have any matching file handle (e.g. file was just closed)
 *
 * Results are cached per (pid, filename). Negative results expire after
 * NEGATIVE_TTL_MS so a player that hasn't opened the file *yet* gets retried.
 */
export async function resolveWindowsFilePath(
  pid: number,
  filenameHint: string,
): Promise<string | null> {
  if (process.platform !== 'win32') {
    return null
  }
  if (!filenameHint || !Number.isInteger(pid) || pid <= 0) {
    return null
  }
  const key = cacheKey(pid, filenameHint)
  const hit = cache.get(key)
  if (hit) {
    if (hit.path !== null || Date.now() - hit.recordedAt < NEGATIVE_TTL_MS) {
      return hit.path
    }
    cache.delete(key)
  }
  const script = locateScript()
  if (!script) {
    return null
  }
  const cmd =
    `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" ` +
    `-ProcessId ${pid} -FilenameHint "${filenameHint.replace(/"/g, '`"')}"`
  try {
    const { stdout } = await execAsync(cmd, {
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    })
    const trimmed = stdout.trim()
    if (!trimmed) {
      cache.set(key, { path: null, recordedAt: Date.now() })
      return null
    }
    const parsed = JSON.parse(trimmed) as ResolverReply
    const resolved = typeof parsed.path === 'string' && parsed.path.length > 0 ? parsed.path : null
    cache.set(key, { path: resolved, recordedAt: Date.now() })
    return resolved
  } catch {
    cache.set(key, { path: null, recordedAt: Date.now() })
    return null
  }
}
