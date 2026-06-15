import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  mpvIpcSetupAction,
  resolveMpvConfPath,
  clearMpvConfPathCache,
} from '../../src/setup/actions/mpv.js'
import type { SetupChange } from '../../src/setup/types.js'

/**
 * mpv setup action tests. apply/restore hit a real (temp) mpv.conf via the INI
 * helpers, so this doubles as an integration test of the file round-trip:
 * append the IPC line, then restore back to the exact prior state.
 */

let tmpDir: string
let confPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scrobbler-mpvconf-'))
  confPath = path.join(tmpDir, 'mpv', 'mpv.conf')
  // resolveMpvConfPath caches per-process; clear between tests so env-driven
  // assertions (MPV_HOME, etc.) see fresh resolution each time.
  clearMpvConfPathCache()
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

/** Build a change list pointed at the temp conf instead of the real mpv.conf. */
function changesForTempConf(current: string | null): SetupChange[] {
  return [
    {
      kind: 'ini-file',
      target: confPath,
      property: 'input-ipc-server',
      current,
      next: '/tmp/mpv-myshows.sock',
    },
  ]
}

describe('mpvIpcSetupAction metadata', () => {
  it('is supported on every platform and targets the mpv player', async () => {
    expect(await mpvIpcSetupAction.isSupported()).toBe(true)
    expect(mpvIpcSetupAction.player).toBe('mpv')
    expect(mpvIpcSetupAction.id).toBe('mpv-ipc')
  })
})

describe('resolveMpvConfPath', () => {
  it('points at an mpv.conf path appropriate for the platform', async () => {
    const p = await resolveMpvConfPath()
    // Always ends with mpv.conf — the parent dir varies by platform / install
    // type (Windows: %APPDATA%\mpv\, scoop portable_config\, %MPV_HOME%; Unix:
    // ~/.config/mpv\). What matters here is the filename.
    expect(p.endsWith('mpv.conf')).toBe(true)
    if (process.platform !== 'win32') {
      expect(p).toContain(path.join('.config', 'mpv'))
    }
  })

  it('on Windows honours MPV_HOME when set', async () => {
    if (process.platform !== 'win32') {
      return
    }
    const prev = process.env.MPV_HOME
    process.env.MPV_HOME = 'C:\\custom-mpv-home'
    try {
      const p = await resolveMpvConfPath()
      expect(p).toBe(path.join('C:\\custom-mpv-home', 'mpv.conf'))
    } finally {
      if (prev === undefined) {
        delete process.env.MPV_HOME
      } else {
        process.env.MPV_HOME = prev
      }
    }
  })
})

describe('apply / restore round-trip on a temp conf', () => {
  it('creates the file (and dir) and appends the IPC line when conf is absent', async () => {
    await mpvIpcSetupAction.apply(changesForTempConf(null))
    const written = await fs.readFile(confPath, 'utf8')
    expect(written).toContain('input-ipc-server=/tmp/mpv-myshows.sock')
  })

  it('restore removes our line when the key was absent before', async () => {
    await mpvIpcSetupAction.apply(changesForTempConf(null))
    // previousChanges shape: next carries the original value (null → delete).
    await mpvIpcSetupAction.restore([
      {
        kind: 'ini-file',
        target: confPath,
        property: 'input-ipc-server',
        current: '/tmp/mpv-myshows.sock',
        next: null,
      },
    ])
    const after = await fs.readFile(confPath, 'utf8')
    expect(after).not.toContain('input-ipc-server')
  })

  it('restore puts back a pre-existing value verbatim', async () => {
    await fs.mkdir(path.dirname(confPath), { recursive: true })
    await fs.writeFile(confPath, 'input-ipc-server=/tmp/old.sock\nvolume=70\n', 'utf8')
    await mpvIpcSetupAction.apply(changesForTempConf('/tmp/old.sock'))
    expect(await fs.readFile(confPath, 'utf8')).toContain('input-ipc-server=/tmp/mpv-myshows.sock')

    await mpvIpcSetupAction.restore([
      {
        kind: 'ini-file',
        target: confPath,
        property: 'input-ipc-server',
        current: '/tmp/mpv-myshows.sock',
        next: '/tmp/old.sock',
      },
    ])
    const after = await fs.readFile(confPath, 'utf8')
    expect(after).toContain('input-ipc-server=/tmp/old.sock')
    // Unrelated keys survive the round-trip.
    expect(after).toContain('volume=70')
  })
})
