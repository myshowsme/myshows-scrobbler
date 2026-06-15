#!/usr/bin/env node
// Standalone smoke test for the precise-playback backends.
//
// Run on the platform you want to verify:
//   - macOS:   node scripts/smoke-precise-probes.mjs
//   - Linux:   node scripts/smoke-precise-probes.mjs   # tests MPRIS via gdbus
//   - Windows: node scripts/smoke-precise-probes.mjs   # tests SMTC via PowerShell
//
// Output: prints the JSON each platform-specific backend returns, plus a
// human-readable summary. Use it as a quick check before/after deploying to
// confirm the helper scripts execute correctly and produce parsable data.
//
// Expects to be run from the project root after `pnpm install`.

import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

// tsx is required to import the TS sources directly. Without it, this script
// only works against the built dist/.
process.chdir(root)

let probes
try {
  const macos = await import(path.join(root, 'src/utils/macos-osa.ts'))
  const linux = await import(path.join(root, 'src/utils/linux-mpris.ts'))
  const windows = await import(path.join(root, 'src/utils/windows-smtc.ts'))
  probes = { macos, linux, windows }
} catch (err) {
  console.error('Failed to import probes — run via `vp exec tsx scripts/smoke-precise-probes.mjs`')
  console.error(err)
  process.exit(1)
}

console.log(`Platform: ${process.platform}`)
console.log('───────────────────────────────────────────────────────────────')

if (process.platform === 'darwin') {
  console.log('Testing macOS AppleScript probe...')
  const r = await probes.macos.probeMacosPlayers()
  console.log(`Found ${r.length} session(s):`)
  console.log(JSON.stringify(r, null, 2))
} else if (process.platform === 'linux') {
  console.log('Testing Linux MPRIS probe (requires gdbus + session DBus)...')
  const r = await probes.linux.probeLinuxMpris()
  console.log(`Found ${r.length} MPRIS session(s):`)
  console.log(JSON.stringify(r, null, 2))
  if (r.length === 0) {
    console.log('\nTroubleshooting:')
    console.log('  - Is a media player running? Try `vlc somefile.mkv &`')
    console.log(
      '  - Does `gdbus call --session --dest=org.freedesktop.DBus ' +
        '--object-path=/org/freedesktop/DBus --method=org.freedesktop.DBus.ListNames`',
    )
    console.log('    list `org.mpris.MediaPlayer2.*` entries?')
    console.log('  - Are you in a desktop session (DBUS_SESSION_BUS_ADDRESS set)?')
  }
} else if (process.platform === 'win32') {
  console.log('Testing Windows SMTC probe (requires Windows 10 1809+ + PowerShell)...')
  const r = await probes.windows.probeWindowsSmtc()
  console.log(`Found ${r.length} SMTC session(s):`)
  console.log(JSON.stringify(r, null, 2))
  if (r.length === 0) {
    console.log('\nTroubleshooting:')
    console.log('  - Is a media player playing right now? (must be Playing or Paused, not Stopped)')
    console.log('  - Try running the helper manually:')
    console.log(
      '      powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-smtc-probe.ps1',
    )
    console.log(
      '  - On Windows 10 < 1809 / Windows Server the Windows.Media.Control API is unavailable.',
    )
  }
} else {
  console.log(`No precise backend available on ${process.platform}.`)
}
