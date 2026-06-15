import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

const isWindows = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const isLinux = process.platform === 'linux'

/**
 * Force a UTF-8 locale for the `ps`/`lsof` children whose output we parse.
 * macOS apps launched outside a terminal (Finder/Dock, launchd) inherit no
 * LANG/LC_*, so those tools fall back to the POSIX "C" locale and escape every
 * non-ASCII byte in a path as \xNN — turning e.g. a Cyrillic filename into
 * garbage that mis-parses downstream. Forcing a UTF-8 charset keeps paths
 * intact regardless of how the app was started.
 */
const UTF8_LOCALE = isMac ? 'en_US.UTF-8' : 'C.UTF-8'
const execEnv: NodeJS.ProcessEnv = isWindows
  ? process.env
  : { ...process.env, LC_ALL: UTF8_LOCALE, LANG: UTF8_LOCALE }

export interface ProcessInfo {
  pid: number
  commandLine: string
  startedAt: Date
  /** Logical player id (e.g. "vlc", "mpv") — not the OS process name. */
  player: PlayerId
  /**
   * Top-level window title, when available. Windows-only — every player we
   * support stamps the currently-open filename into its title bar, which is
   * the only signal we have when the file isn't in argv (Open File dialog,
   * drag-drop, recents) AND the player doesn't publish to SMTC (MPC-BE).
   */
  windowTitle?: string
  /** Product version of the player binary (e.g. "1.7.22227"). Windows-only. */
  version?: string
}

export type PlayerId =
  | 'vlc'
  | 'mpv'
  | 'mpc'
  | 'potplayer'
  | 'iina'
  | 'infuse'
  | 'quicktime'
  | 'wmp'
  // Logical ids reported by Linux MPRIS / Windows SMTC precise backends —
  // not present in PLAYER_MATCHES (those backends discover players by
  // DBus / WinRT enumeration, not by process name).
  | 'smplayer'
  | 'celluloid'
  | 'totem'
  | 'rhythmbox'
  | 'browser'
  | 'spotify'
  | 'unknown'

interface PlayerMatch {
  player: PlayerId
  /** Process name candidates per-OS. Matched case-insensitively. */
  win?: string[]
  mac?: string[]
  linux?: string[]
}

const PLAYER_MATCHES: PlayerMatch[] = [
  { player: 'vlc', win: ['vlc.exe'], mac: ['VLC'], linux: ['vlc'] },
  {
    player: 'mpv',
    win: ['mpv.exe', 'mpvnet.exe'],
    mac: ['mpv'],
    linux: ['mpv'],
  },
  {
    player: 'mpc',
    win: ['mpc-hc.exe', 'mpc-hc64.exe', 'mpc-be.exe', 'mpc-be64.exe'],
  },
  {
    // PotPlayer ships in several builds: full installer and the Mini variant,
    // each in 32- and 64-bit flavours. Process name varies; window class names
    // are stable ("PotPlayer" / "PotPlayer64") — handled by the precise probe.
    player: 'potplayer',
    win: ['PotPlayer.exe', 'PotPlayer64.exe', 'PotPlayerMini.exe', 'PotPlayerMini64.exe'],
  },
  {
    // Built-in Windows media apps:
    //   - wmplayer.exe   legacy Windows Media Player (still ships on Win10/11 as optional)
    //   - Video.UI.exe   "Movies & TV" (Win10 UWP, Microsoft.ZuneVideo)
    //   - Microsoft.Media.Player.exe   new "Media Player" on Windows 11
    player: 'wmp',
    win: ['wmplayer.exe', 'Video.UI.exe', 'Microsoft.Media.Player.exe'],
  },
  { player: 'iina', mac: ['IINA'] },
  { player: 'infuse', mac: ['Infuse'] },
  // QuickTime ships only on macOS; the binary inside the .app has a space in
  // its name ("QuickTime Player"). The matchesProcessName fallback handles
  // that via the /{name}.app/ pattern check.
  { player: 'quicktime', mac: ['QuickTime Player'] },
]

const MEDIA_EXT =
  'mkv|mp4|avi|wmv|flv|mov|webm|m4v|ts|mts|ogv|3gp|divx|xvid|rm|rmvb|asf|mpg|mpeg|m2v|mpe|vob|dvr-ms|wtv|m2ts'

const MEDIA_EXT_RE = new RegExp(`\\.(?:${MEDIA_EXT})$`, 'i')

/**
 * Extract a media file path from a process command line.
 * Handles quoted Windows paths, unquoted Windows paths, and POSIX paths.
 */
export function extractFilePath(commandLine: string): string | null {
  const quoted = new RegExp(`"([^"]+\\.(?:${MEDIA_EXT}))"`, 'i').exec(commandLine)
  if (quoted) {
    return quoted[1]
  }

  const posix = new RegExp(`(/[^\\s]+\\.(?:${MEDIA_EXT}))`, 'i').exec(commandLine)
  if (posix) {
    return posix[1]
  }

  const win = new RegExp(`([A-Za-z]:\\\\[^\\s]+\\.(?:${MEDIA_EXT}))`, 'i').exec(commandLine)
  if (win) {
    return win[1]
  }

  return null
}

/** Seconds since a process started, clamped to non-negative. */
export function uptimeSeconds(startedAt: Date): number {
  return Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000))
}

/**
 * Resolve the currently-open media file for a process by inspecting its open
 * file descriptors via `lsof`. Used as a fallback when the file path isn't
 * present in argv (common on macOS GUI apps like VLC.app/IINA/QuickTime that
 * open files via Apple Events; also useful on Linux for GUI launchers that
 * pass the file through D-Bus or playlist plumbing instead of argv).
 *
 * Unix-only. Returns null on Windows, on invalid pid, or if lsof is missing
 * / unavailable for the process (e.g. denied by sandbox).
 */
export async function findOpenMediaFile(pid: number): Promise<string | null> {
  if (isWindows) {
    return null
  }
  // Defense-in-depth: `pid` is built from parseInt earlier, but if a future
  // caller ever forwards an unvalidated value, reject it before shell-exec.
  if (!Number.isInteger(pid) || pid <= 0) {
    return null
  }
  try {
    const { stdout } = await execAsync(`lsof -p ${pid} -Fn`, { timeout: 3000, env: execEnv })
    const candidates: string[] = []
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('n')) {
        continue
      }
      const path = line.slice(1)
      if (!path.startsWith('/')) {
        continue
      }
      if (MEDIA_EXT_RE.test(path)) {
        candidates.push(path)
      }
    }
    if (candidates.length === 0) {
      return null
    }
    // Prefer the longest path — typically the actual media file rather than
    // an adjacent thumbnail/subtitle/cache file the player may have opened.
    candidates.sort((a, b) => b.length - a.length)
    return candidates[0]
  } catch {
    return null
  }
}

export interface ProcessSnapshot {
  processes: ProcessInfo[]
  /** Brief reason when scanning failed (no supported platform, command missing, etc). */
  warning?: string
}

export async function scanPlayers(): Promise<ProcessSnapshot> {
  if (isWindows) {
    return scanWindows()
  }
  if (isMac || isLinux) {
    return scanUnix()
  }
  return {
    processes: [],
    warning: `Unsupported platform: ${process.platform}`,
  }
}

// ── Unix (macOS / Linux) ───────────────────────────────────────────────────

interface PsRow {
  pid: number
  etime: string
  command: string
}

async function scanUnix(): Promise<ProcessSnapshot> {
  let rows: PsRow[]
  try {
    rows = await readPs()
  } catch (err) {
    return { processes: [], warning: `ps failed: ${(err as Error).message}` }
  }

  const matches: ProcessInfo[] = []
  const now = Date.now()
  const platformKey = isMac ? 'mac' : 'linux'

  for (const row of rows) {
    for (const def of PLAYER_MATCHES) {
      const names = def[platformKey]
      if (!names) {
        continue
      }
      if (!matchesProcessName(row.command, names)) {
        continue
      }
      matches.push({
        pid: row.pid,
        commandLine: row.command,
        startedAt: new Date(now - parseEtimeSeconds(row.etime) * 1000),
        player: def.player,
      })
      break
    }
  }

  return { processes: matches }
}

async function readPs(): Promise<PsRow[]> {
  // `-o etime=` gives a clean elapsed-time column without header.
  const { stdout } = await execAsync('ps -axo pid=,etime=,command=', {
    timeout: 4000,
    env: execEnv,
  })
  const lines = stdout.split('\n')
  const rows: PsRow[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    // pid (digits) etime (e.g. "01:23" or "1-02:03:04") command (rest)
    const match = /^(\d+)\s+([\d:-]+)\s+(.*)$/.exec(trimmed)
    if (!match) {
      continue
    }
    rows.push({
      pid: parseInt(match[1], 10),
      etime: match[2],
      command: match[3],
    })
  }
  return rows
}

/** Check whether a `ps` command line invokes any of the given process names. */
function matchesProcessName(commandLine: string, candidates: string[]): boolean {
  const exe = commandLine.split(/\s+/)[0] ?? ''
  const base = exe.split('/').pop() ?? exe
  const lower = base.toLowerCase()
  return candidates.some((name) => {
    const target = name.toLowerCase()
    if (lower === target) {
      return true
    }
    // macOS app bundles: command may be "/Applications/VLC.app/Contents/MacOS/VLC"
    return commandLine.toLowerCase().includes(`/${target.toLowerCase()}.app/`)
  })
}

/** Parse `ps -o etime` output to seconds. Formats: "MM:SS", "HH:MM:SS", "D-HH:MM:SS". */
export function parseEtimeSeconds(etime: string): number {
  const [dayPart, timePart] = etime.includes('-') ? etime.split('-') : ['0', etime]
  const days = parseInt(dayPart, 10) || 0
  const segments = timePart.split(':').map((seg) => parseInt(seg, 10) || 0)
  while (segments.length < 3) {
    segments.unshift(0)
  }
  const [h, m, s] = segments
  return days * 86400 + h * 3600 + m * 60 + s
}

// ── Windows ────────────────────────────────────────────────────────────────

/**
 * Map a Windows process name (`vlc.exe`, `mpc-hc64.exe`, etc.) to the logical player id.
 * Returns null when the name doesn't belong to a known player.
 */
function playerFromWinName(processName: string): PlayerId | null {
  const lower = processName.toLowerCase()
  for (const def of PLAYER_MATCHES) {
    if (def.win?.some((name) => name.toLowerCase() === lower)) {
      return def.player
    }
  }
  return null
}

async function scanWindows(): Promise<ProcessSnapshot> {
  // One PowerShell call covers every known player name. Cold start of PS is ~300-700ms,
  // so doing a separate call per name (4-7 of them) is too slow for the polling loop.
  const allNames = PLAYER_MATCHES.flatMap((def) => def.win ?? [])
  if (allNames.length === 0) {
    return { processes: [] }
  }

  const namesLiteral = allNames.map((n) => `'${n}'`).join(',')
  // Force UTF-8 stdout — non-ASCII paths (cyrillic, japanese, ...) come back
  // garbled otherwise: Windows PowerShell 5.1 writes through the console code
  // page (1251/1252/...) by default, which corrupts anything outside it.
  // MainWindowTitle isn't on Win32_Process — we pull it from Get-Process keyed
  // by pid. ErrorAction SilentlyContinue + try block: pid can disappear between
  // the WMI query and Get-Process; that's fine, just no title for that row.
  const psScript =
    `$OutputEncoding = New-Object System.Text.UTF8Encoding $false; ` +
    `try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}; ` +
    `$names = @(${namesLiteral}); ` +
    `Get-CimInstance -ClassName Win32_Process | ` +
    `Where-Object { $names -contains $_.Name } | ` +
    `ForEach-Object { ` +
    `  $t = ''; $v = ''; ` +
    `  try { $p = Get-Process -Id $_.ProcessId -ErrorAction Stop; $t = $p.MainWindowTitle } catch {} ` +
    `  try { $fi = (Get-Item $_.ExecutablePath -ErrorAction Stop).VersionInfo; $v = if ($fi.FileVersion) { $fi.FileVersion } else { $fi.ProductVersion } } catch {} ` +
    `  [PSCustomObject]@{ Name = $_.Name; ProcessId = $_.ProcessId; CommandLine = $_.CommandLine; CreationDate = $_.CreationDate; WindowTitle = $t; Version = $v } ` +
    `} | ConvertTo-Json -Compress`

  const cmd = `powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`

  let stdout: string
  try {
    const result = await execAsync(cmd, { timeout: 6000, windowsHide: true })
    stdout = result.stdout
  } catch (err) {
    return { processes: [], warning: `WMI failed: ${(err as Error).message}` }
  }

  const trimmed = stdout.trim()
  if (!trimmed || trimmed === 'null') {
    return { processes: [] }
  }

  let parsed: WmiRow | WmiRow[]
  try {
    parsed = JSON.parse(trimmed) as WmiRow | WmiRow[]
  } catch (err) {
    return {
      processes: [],
      warning: `WMI JSON parse failed: ${(err as Error).message}`,
    }
  }

  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const matches: ProcessInfo[] = []
  for (const row of rows) {
    const commandLine = row.CommandLine
    if (!commandLine) {
      continue
    }
    const player = playerFromWinName(row.Name ?? '')
    if (!player) {
      continue
    }
    matches.push({
      pid: Number(row.ProcessId),
      commandLine,
      startedAt: parseWmiDate(row.CreationDate ?? ''),
      player,
      windowTitle: row.WindowTitle || undefined,
      version: normalizeExeVersion(row.Version),
    })
  }
  return { processes: matches }
}

/**
 * Best-effort extract of the currently-open filename from a player's window
 * title. Every supported player writes the filename verbatim at the start of
 * the title and tacks "- <player branding>" on the end. We strip the known
 * tails per player. This is the *only* path that works for MPC-BE opened via
 * the Open File dialog: no argv, no SMTC publish, no `lsof` on Windows.
 *
 * Returns null when:
 *   - title is empty
 *   - we don't know how to parse this player's title format
 *   - after stripping the suffix nothing useful remains
 *
 * The returned string is NOT a real path — it's a bare filename. Downstream
 * `parseFilename` (guessit) handles bare filenames fine; ffprobe will fail
 * gracefully and the adapter falls back to uptime-based viewOffset.
 */
export function filenameFromWindowTitle(player: PlayerId, title: string): string | null {
  if (!title) {
    return null
  }
  // Suffix patterns are anchored to end-of-string. Versions vary per release
  // (MPC-BE has "x64 1.8.9"; MPC-HC drops the architecture; mpv plain).
  // Build progress / "Paused" / "Stopped" prefixes that some players prepend
  // are stripped separately below.
  const SUFFIX_BY_PLAYER: Partial<Record<PlayerId, RegExp>> = {
    // VLC localizes its branding ("Медиапроигрыватель VLC" on Russian UIs).
    vlc: /\s*-\s*(?:VLC media player|Медиапроигрыватель VLC)\s*$/i,
    mpv: /\s*-\s*mpv\s*$/i,
    mpc: /\s*-\s*MPC-(?:HC|BE)(?:\s+x64)?(?:\s+v?\d+(?:\.\d+)*)?\s*$/i,
    // PotPlayer's title is "<filename> - PotPlayer" plus an optional short
    // edition tail: "PotPlayer Mini", localized builds like "PotPlayer Rus".
    // Allow up to two trailing words so those builds aren't invisible.
    potplayer: /\s*-\s*PotPlayer(?:\s+[\p{L}\d.]+){0,2}\s*$/iu,
    wmp: /\s*-\s*(?:Windows Media Player|Movies\s*&\s*TV|Media Player|Кино и ТВ)\s*$/i,
    iina: /\s*-\s*IINA\s*$/i,
  }
  const suffix = SUFFIX_BY_PLAYER[player]
  if (!suffix) {
    return null
  }
  const stripped = title.replace(suffix, '').trim()
  // If the suffix didn't actually match anything, the title doesn't follow the
  // "<file> - <player>" pattern at all. Most likely a "nothing loaded" state
  // where the title is just the player branding (e.g. "MPC-BE x64 1.8.9",
  // "VLC media player"). Nothing useful to scrobble.
  if (stripped === title.trim()) {
    return null
  }
  // Some MPC builds prefix paused/stopped state: "[Paused] file.mkv - MPC-BE".
  const final = stripped.replace(/^\[(?:Paused|Stopped|Playing)\]\s*/i, '').trim()
  // mpv with nothing loaded titles its window "No file - mpv" — the suffix
  // matches, but what's left is an idle placeholder, not a filename. Without
  // this guard it scrobbles as a movie literally titled "No file".
  if (final.toLowerCase() === 'no file') {
    return null
  }
  return final || null
}

/**
 * Clean up a PE VersionInfo string for reporting: comma form ("3,0,23,0") →
 * dots, and all-zero versions → undefined. Repacks often zero the version
 * block entirely (PotPlayer Rus ships "0, 0, 0, 0") — sending that to
 * MyShows is worse than sending nothing.
 */
export function normalizeExeVersion(raw?: string): string | undefined {
  const version = raw?.trim().replace(/,\s*/g, '.')
  if (!version || !/[1-9]/.test(version)) {
    return undefined
  }
  return version
}

interface WmiRow {
  Name?: string
  ProcessId: number
  CommandLine?: string
  CreationDate?: string
  WindowTitle?: string
  Version?: string
}

/** WMI datetime → JS Date. Formats: `/Date(ms)/` (ConvertTo-Json shape) or `YYYYMMDDhhmmss.sss+TZ`. */
export function parseWmiDate(raw: string): Date {
  const epoch = /\/Date\((\d+)\)\//.exec(raw)
  if (epoch) {
    return new Date(parseInt(epoch[1], 10))
  }
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(raw)
  if (m) {
    return new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6]),
    )
  }
  return new Date()
}
