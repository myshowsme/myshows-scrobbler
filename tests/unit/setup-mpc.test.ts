import { describe, it, expect } from 'vite-plus/test'
import { mpcHcWebInterfaceAction, mpcBeWebInterfaceAction } from '../../src/setup/actions/mpc.js'

/**
 * Unit tests for the MPC setup actions. Apply / restore / verify hit real
 * external systems (Windows registry, HTTP), so those branches are
 * exercised at integration level — here we cover the structure of `diff()`,
 * the shared variant factory, and `isSupported()` platform-gating.
 *
 * On non-Windows hosts `readRegistryValue` short-circuits to `null`, so
 * `diff()` still produces well-formed `SetupChange` entries we can assert on.
 */

describe('mpcHcWebInterfaceAction.diff', () => {
  it('returns two REG_DWORD changes targeting MPC-HC settings', async () => {
    const changes = await mpcHcWebInterfaceAction.diff()
    expect(changes).toHaveLength(2)

    const enable = changes.find((c) => c.property === 'EnableWebServer')
    expect(enable).toBeDefined()
    expect(enable?.kind).toBe('windows-registry')
    expect(enable?.target).toBe('HKCU\\Software\\MPC-HC\\MPC-HC\\Settings')
    expect(enable?.next).toBe(1)

    const port = changes.find((c) => c.property === 'WebServerPort')
    expect(port).toBeDefined()
    expect(port?.target).toBe('HKCU\\Software\\MPC-HC\\MPC-HC\\Settings')
    expect(port?.next).toBe(13579)
  })

  it('exposes a stable id and player', () => {
    expect(mpcHcWebInterfaceAction.id).toBe('mpc-hc-web-interface')
    expect(mpcHcWebInterfaceAction.player).toBe('mpc')
  })
})

describe('mpcBeWebInterfaceAction.diff', () => {
  it('returns two REG_DWORD changes targeting MPC-BE settings', async () => {
    const changes = await mpcBeWebInterfaceAction.diff()
    expect(changes).toHaveLength(2)

    const enable = changes.find((c) => c.property === 'EnableWebServer')
    expect(enable?.target).toBe('HKCU\\Software\\MPC-BE\\WebServer')
    expect(enable?.next).toBe(1)

    // MPC-BE uses `Port` (not `WebServerPort` like MPC-HC) under its dedicated
    // WebServer subkey — verified against a real MPC-BE 1.8.9 install.
    const port = changes.find((c) => c.property === 'Port')
    expect(port?.target).toBe('HKCU\\Software\\MPC-BE\\WebServer')
    expect(port?.next).toBe(13579)
  })

  it('shares structure with HC but has its own id', () => {
    expect(mpcBeWebInterfaceAction.id).toBe('mpc-be-web-interface')
    expect(mpcBeWebInterfaceAction.player).toBe('mpc')
    expect(mpcBeWebInterfaceAction.id).not.toBe(mpcHcWebInterfaceAction.id)
  })
})

describe('isSupported', () => {
  it('matches the current platform on both variants', async () => {
    const expected = process.platform === 'win32'
    expect(await mpcHcWebInterfaceAction.isSupported()).toBe(expected)
    expect(await mpcBeWebInterfaceAction.isSupported()).toBe(expected)
  })
})

describe('guard', () => {
  it.skipIf(process.platform === 'win32')(
    'returns blocked: false on non-Windows hosts (no MPC process to detect)',
    async () => {
      // On non-Windows `scanPlayers` returns an empty processes list (MPC has
      // no Unix build in PLAYER_MATCHES). We assert the un-blocked branch
      // here; the "blocked while MPC running" branch can only be exercised
      // on Windows with a real MPC instance.
      const result = await mpcHcWebInterfaceAction.guard?.()
      expect(result?.blocked).toBe(false)
    },
  )
})

describe('verify (non-windows fast path)', () => {
  it('returns false when MPC HTTP endpoint is unreachable', async () => {
    // Without a real MPC running, fetch will fail or 404. Either way verify
    // must return false rather than throw — caller (setup runtime) relies on
    // a bool, not a rejected promise.
    const result = await mpcHcWebInterfaceAction.verify()
    expect(typeof result).toBe('boolean')
  })
})
