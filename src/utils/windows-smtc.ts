import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const execAsync = promisify(exec)

/**
 * One session reported by Windows SMTC. Shape mirrors `OsaPlayback`/`MprisPlayback`
 * so the precise-probe merge in player.ts stays uniform across platforms.
 *
 * Note: SMTC gives us *no* file path. Apps report metadata (title/artist) only.
 * For MyShows we use title-only matching downstream; not great for episode
 * detection without filename hints, but better than no detection at all.
 */
export interface SmtcPlayback {
  /** AUMID of the source app, e.g. "VideoLAN.VLC_pcvm4z2zphcb6!App" or "Spotify.Spotify". */
  appUserModelId: string
  title: string
  artist: string
  /**
   * `AlbumTitle` from the SMTC media properties. Empty string when the source
   * app doesn't publish one. Useful as a fallback show title for video apps
   * that put the series name into the album field (notably modern Windows
   * Media Player). Not consumed by the adapter yet — exposed so a downstream
   * step can opt in per-player without touching the probe again.
   */
  albumTitle: string
  /**
   * Media kind the app reports: "Music" | "Video" | "Image" | "Unknown" | "".
   * Optional/empty when the app doesn't publish it or a packaged build still
   * ships the older probe script. Used to drop songs/photos without guessing
   * from the app id.
   */
  playbackType?: string
  isPlaying: boolean
  positionSeconds: number
  durationSeconds: number
}

let cachedScriptPath: string | null | undefined

function locateScript(): string | null {
  if (cachedScriptPath !== undefined) {
    return cachedScriptPath
  }
  const here = path.dirname(fileURLToPath(import.meta.url))
  // Search order mirrors the macOS helper:
  //   1. dev tree:        src/utils/ → ../../scripts/windows-smtc-probe.ps1
  //   2. packed server:   dist/server/ → ../../scripts/...
  //   3. monorepo root.
  // Packaged Electron app: shipped to Resources via build.extraResources.
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  const candidates = [
    ...(resourcesPath ? [path.join(resourcesPath, 'windows-smtc-probe.ps1')] : []),
    path.resolve(here, '../../scripts/windows-smtc-probe.ps1'),
    path.resolve(here, '../scripts/windows-smtc-probe.ps1'),
    path.resolve(here, '../../../scripts/windows-smtc-probe.ps1'),
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
 * Spawn the PowerShell helper and return SMTC playback sessions.
 *
 * Returns [] on non-win32 platforms, when the helper script can't be located,
 * or when SMTC isn't available (Windows older than 1809). PowerShell cold
 * start + AsTask trick is slow — expect 800-1500ms on the first call, faster
 * after that.
 */
export async function probeWindowsSmtc(): Promise<SmtcPlayback[]> {
  if (process.platform !== 'win32') {
    return []
  }
  const script = locateScript()
  if (!script) {
    return []
  }
  try {
    const { stdout } = await execAsync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"`,
      { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 },
    )
    const trimmed = stdout.trim()
    if (!trimmed) {
      return []
    }
    const parsed = JSON.parse(trimmed) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter(isSmtcPlayback)
  } catch {
    return []
  }
}

export function isSmtcPlayback(value: unknown): value is SmtcPlayback {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const v = value as Record<string, unknown>
  return (
    typeof v.appUserModelId === 'string' &&
    typeof v.title === 'string' &&
    typeof v.artist === 'string' &&
    typeof v.albumTitle === 'string' &&
    (v.playbackType === undefined || typeof v.playbackType === 'string') &&
    typeof v.isPlaying === 'boolean' &&
    typeof v.positionSeconds === 'number' &&
    typeof v.durationSeconds === 'number'
  )
}

/**
 * Coarse mapping from AUMID to a logical player id used in NormalizedEvent.appVersion.
 * Exposed publicly so the adapter and tests can stay in sync.
 */
export function classifyAumid(aumid: string): string {
  const lower = aumid.toLowerCase()
  if (lower.includes('videolan') || lower.startsWith('vlc')) {
    return 'vlc'
  }
  if (lower.includes('mpchc') || lower.includes('mpc-hc')) {
    return 'mpc'
  }
  if (lower.includes('mpv')) {
    return 'mpv'
  }
  // PotPlayer publishes to SMTC with the executable name as the AUMID,
  // e.g. "PotPlayerMini64.exe" / "PotPlayer64.exe". Substring match covers
  // every build (Mini / full, 32 / 64-bit).
  if (lower.includes('potplayer')) {
    return 'potplayer'
  }
  if (
    lower.includes('zunevideo') ||
    lower.includes('microsoft.zune') ||
    lower.includes('microsoft.media.player')
  ) {
    return 'wmp'
  }
  if (lower.includes('wmplayer')) {
    return 'wmp'
  }
  if (lower.includes('spotify')) {
    return 'spotify'
  }
  if (
    lower.includes('chrome') ||
    lower.includes('edge') ||
    lower.includes('firefox') ||
    lower.includes('msedge')
  ) {
    return 'browser'
  }
  return 'unknown'
}
