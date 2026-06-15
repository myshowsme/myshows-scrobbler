import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const execAsync = promisify(exec)

export type OsaPlayerId = 'vlc' | 'quicktime' | 'tv'

export interface OsaPlayback {
  player: OsaPlayerId
  isPlaying: boolean
  /** Episode name (TV) or filename (VLC/QuickTime). */
  title: string
  /** Local file path — only set for VLC and QuickTime. */
  filePath: string | null
  positionSeconds: number
  durationSeconds: number
}

let cachedScriptPath: string | null | undefined

/**
 * Resolve the JXA probe script next to the source tree (dev) or next to the
 * packed dist (prod). The script is shipped as raw JavaScript so it's never
 * bundled — it has to live on disk for osascript to execute it.
 */
function locateScript(): string | null {
  if (cachedScriptPath !== undefined) {
    return cachedScriptPath
  }
  const here = path.dirname(fileURLToPath(import.meta.url))
  // Search order:
  //   1. dev tree:        src/utils/ → ../../scripts/macos-osa-probe.js
  //   2. packed server:   dist/server/ → ../../scripts/macos-osa-probe.js
  //   3. monorepo root:   walk up two more levels just in case.
  // In a packaged Electron app the bundle lives in app.asar, so the relative
  // paths below miss — the raw script is shipped to Resources via
  // build.extraResources and found through process.resourcesPath instead.
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  const candidates = [
    ...(resourcesPath ? [path.join(resourcesPath, 'macos-osa-probe.js')] : []),
    path.resolve(here, '../../scripts/macos-osa-probe.js'),
    path.resolve(here, '../scripts/macos-osa-probe.js'),
    path.resolve(here, '../../../scripts/macos-osa-probe.js'),
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

/**
 * Spawn the JXA probe and return all detected playback sessions. Returns an
 * empty array on non-macOS platforms or when the script can't be located.
 *
 * AppleScript dialect: JavaScript for Automation (JXA). The probe talks to
 * VLC, QuickTime Player, Music.app, and TV.app via their scripting bridges.
 * Each cold osascript invocation takes ~150-250ms — the script does all four
 * apps in a single run so we pay that cost once per poll.
 */
export async function probeMacosPlayers(): Promise<OsaPlayback[]> {
  if (process.platform !== 'darwin') {
    return []
  }
  const script = locateScript()
  if (!script) {
    return []
  }
  try {
    const { stdout } = await execAsync(`osascript -l JavaScript "${script}"`, {
      timeout: 6000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    })
    const trimmed = stdout.trim()
    if (!trimmed) {
      return []
    }
    const parsed = JSON.parse(trimmed) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter(isOsaPlayback)
  } catch {
    return []
  }
}

function isOsaPlayback(value: unknown): value is OsaPlayback {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const v = value as Record<string, unknown>
  return (
    (v.player === 'vlc' || v.player === 'quicktime' || v.player === 'tv') &&
    typeof v.isPlaying === 'boolean' &&
    typeof v.title === 'string' &&
    typeof v.positionSeconds === 'number' &&
    typeof v.durationSeconds === 'number'
  )
}
