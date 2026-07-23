import { describe, expect, it } from 'vite-plus/test'
import {
  hasWindowsLaunchItem,
  isWindowsAutostartActive,
  shouldRepairWindowsAutostart,
  type LoginItemSnapshot,
} from '../../src/utils/autostart.js'

const EXE = 'C:\\Users\\u\\AppData\\Local\\Programs\\myshows-scrobbler\\MyShows Scrobbler.exe'

function snapshot(overrides: Partial<LoginItemSnapshot> = {}): LoginItemSnapshot {
  return {
    openAtLogin: false,
    executableWillLaunchAtLogin: false,
    launchItems: [],
    ...overrides,
  }
}

describe('isWindowsAutostartActive', () => {
  it('accepts an exact path+args match', () => {
    expect(isWindowsAutostartActive(snapshot({ openAtLogin: true }))).toBe(true)
  })

  it('accepts an entry registered with different args', () => {
    // The whole point: an older build wrote the Run value without --hidden, so
    // openAtLogin compares false while the app still starts at login.
    expect(isWindowsAutostartActive(snapshot({ executableWillLaunchAtLogin: true }))).toBe(true)
  })

  it('reports off when nothing is registered', () => {
    expect(isWindowsAutostartActive(snapshot())).toBe(false)
  })
})

describe('hasWindowsLaunchItem', () => {
  it('matches the executable case-insensitively', () => {
    const state = snapshot({ launchItems: [{ path: EXE.toLowerCase(), enabled: true }] })
    expect(hasWindowsLaunchItem(state, EXE)).toBe(true)
  })

  it('finds an entry the user disabled in Task Manager', () => {
    const state = snapshot({ launchItems: [{ path: EXE, enabled: false }] })
    expect(hasWindowsLaunchItem(state, EXE)).toBe(true)
  })

  it('ignores other apps', () => {
    const state = snapshot({ launchItems: [{ path: 'C:\\Other\\App.exe', enabled: true }] })
    expect(hasWindowsLaunchItem(state, EXE)).toBe(false)
  })

  it('tolerates a missing launchItems array', () => {
    expect(
      hasWindowsLaunchItem({ openAtLogin: false, executableWillLaunchAtLogin: false }, EXE),
    ).toBe(false)
  })
})

describe('shouldRepairWindowsAutostart', () => {
  it('restores a preference the registry lost', () => {
    expect(shouldRepairWindowsAutostart(true, snapshot(), EXE)).toBe(true)
  })

  it('restores when the entry points at a stale install path', () => {
    const state = snapshot({ launchItems: [{ path: 'C:\\Old\\MyShows Scrobbler.exe' }] })
    expect(shouldRepairWindowsAutostart(true, state, EXE)).toBe(true)
  })

  it('leaves a working entry alone', () => {
    const state = snapshot({
      openAtLogin: true,
      executableWillLaunchAtLogin: true,
      launchItems: [{ path: EXE, enabled: true }],
    })
    expect(shouldRepairWindowsAutostart(true, state, EXE)).toBe(false)
  })

  it('leaves an entry the user disabled in Task Manager alone', () => {
    const state = snapshot({ launchItems: [{ path: EXE, enabled: false }] })
    expect(shouldRepairWindowsAutostart(true, state, EXE)).toBe(false)
  })

  it('never enables autostart on its own', () => {
    expect(shouldRepairWindowsAutostart(false, snapshot(), EXE)).toBe(false)
    expect(shouldRepairWindowsAutostart(null, snapshot(), EXE)).toBe(false)
  })
})
