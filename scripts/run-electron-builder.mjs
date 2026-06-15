import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// electron-builder's app-builder-lib spawns `pnpm.CMD` via a temp .bat wrapper
// (resolveWindowsCommand in nodeModulesCollector). The wrapper is written as
// UTF-8 with no BOM, but cmd.exe reads it in the OEM codepage (e.g. 866 on
// ru-RU). Any non-ASCII characters in the resolved pnpm path (or any other
// PATH entry which.sync picks) get mangled and cmd reports
// "The system cannot find the path specified." -> exit 1.
//
// Windows keeps an 8.3 short alias for non-ASCII directories when 8dot3name
// creation is enabled (the default). We rewrite PATH entries that contain
// non-ASCII characters to their short aliases via Win32 GetShortPathNameW so
// which.sync returns an ASCII-only path, the bat wrapper becomes pure ASCII,
// and the codepage mismatch becomes irrelevant.

const isWindows = process.platform === 'win32'
const isAscii = (s) => [...s].every((ch) => ch.charCodeAt(0) <= 0x7f)

const SEP = '::PATHSEP::'

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode, SetLastError=true)]
public static extern uint GetShortPathName(string lpszLongPath, System.Text.StringBuilder lpszShortPath, uint cchBuffer);
'@ -Name Win32 -Namespace ShortPathBatch -PassThru | Out-Null
$paths = $env:PATH_LIST -split [regex]::Escape('${SEP}')
foreach ($p in $paths) {
  if (-not $p) { Write-Output ''; continue }
  $sb = New-Object System.Text.StringBuilder 1024
  $ret = [ShortPathBatch.Win32]::GetShortPathName($p, $sb, 1024)
  if ($ret -gt 0 -and $ret -lt 1024) {
    Write-Output $sb.ToString()
  } else {
    Write-Output $p
  }
}
`

function batchToShortPaths(longPaths) {
  if (longPaths.length === 0) return new Map()
  const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64')
  let raw
  try {
    raw = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      {
        env: { ...process.env, PATH_LIST: longPaths.join(SEP) },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
  } catch (err) {
    console.error('[run-electron-builder] short-path resolver failed:', err.message)
    return new Map()
  }
  const lines = raw.replace(/\r/g, '').split('\n')
  const map = new Map()
  longPaths.forEach((p, i) => {
    const short = (lines[i] ?? '').trim()
    if (short && short !== p && isAscii(short) && existsSync(short)) {
      map.set(p, short)
    }
  })
  return map
}

// process.env on Windows is usually stored as `Path` (mixed case). Spreading
// into a plain object loses Node's case-insensitive proxy, so we must find
// the actual key to avoid leaving two entries (`Path` + `PATH`) that confuse
// the child process.
function findKeyCaseInsensitive(env, name) {
  const lower = name.toLowerCase()
  return Object.keys(env).find((k) => k.toLowerCase() === lower)
}

function sanitizeWindowsPath(rawPath) {
  const entries = rawPath.split(';')
  const nonAsciiExisting = entries.filter((e) => e && !isAscii(e) && existsSync(e))
  const shortMap = batchToShortPaths([...new Set(nonAsciiExisting)])
  const replacements = []
  const sanitized = entries.map((entry) => {
    const short = shortMap.get(entry)
    if (!short) return entry
    replacements.push({ from: entry, to: short })
    return short
  })
  return { path: sanitized.join(';'), replacements }
}

const env = { ...process.env }

if (isWindows) {
  const pathKey = findKeyCaseInsensitive(env, 'PATH') ?? 'PATH'
  const { path: sanitized, replacements } = sanitizeWindowsPath(env[pathKey] ?? '')
  env[pathKey] = sanitized
  if (replacements.length > 0) {
    console.log(
      `[run-electron-builder] rewrote ${replacements.length} non-ASCII PATH entr${replacements.length === 1 ? 'y' : 'ies'} to 8.3 short names`,
    )
  } else if ((env[pathKey] ?? '').split(';').some((e) => e && !isAscii(e))) {
    console.warn(
      '[run-electron-builder] PATH still contains non-ASCII entries (no 8.3 alias available); electron-builder may fail on Cyrillic paths.',
    )
  }
}

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBuilderBin = join(
  projectRoot,
  'node_modules',
  '.bin',
  isWindows ? 'electron-builder.cmd' : 'electron-builder',
)

let resolvedBin = electronBuilderBin
if (isWindows && !isAscii(electronBuilderBin)) {
  const shortMap = batchToShortPaths([electronBuilderBin])
  const short = shortMap.get(electronBuilderBin)
  if (short) resolvedBin = short
}

if (!existsSync(resolvedBin)) {
  console.error(`[run-electron-builder] electron-builder binary not found at ${resolvedBin}`)
  process.exit(1)
}

// shell:true is required on Windows because Node 18.20.2+ refuses to spawn
// .cmd/.bat files directly (CVE-2024-27980 mitigation). resolvedBin is the
// ASCII short path, so cmd's bat-content codepage no longer matters here.
const child = spawn(resolvedBin, process.argv.slice(2), {
  env,
  stdio: 'inherit',
  shell: isWindows,
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})

child.on('error', (err) => {
  console.error('[run-electron-builder] failed to spawn electron-builder:', err)
  process.exit(1)
})
