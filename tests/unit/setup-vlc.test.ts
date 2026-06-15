import { describe, it, expect } from 'vite-plus/test'
import {
  vlcHttpInterfaceAction,
  resolveVlcrcPath,
  ensureHttpInExtraIntf,
} from '../../src/setup/actions/vlc.js'

/**
 * Unit tests for the VLC setup action. The destructive bits (apply/restore
 * against a real vlcrc) are covered at integration level when a real VLC is
 * available; here we exercise the structure of `diff()`, the comma-list
 * merge helper, and the path resolver.
 *
 * `diff()` reads vlcrc via fs — on a host with no vlcrc present, every
 * `current` is null and `next` is fully derived. We can assert against that
 * known-empty starting state.
 */

describe('vlcHttpInterfaceAction metadata', () => {
  it('exposes a stable id, player, and is cross-platform', async () => {
    expect(vlcHttpInterfaceAction.id).toBe('vlc-http-interface')
    expect(vlcHttpInterfaceAction.player).toBe('vlc')
    expect(await vlcHttpInterfaceAction.isSupported()).toBe(true)
  })
})

describe('resolveVlcrcPath', () => {
  it('points at a vlcrc path under the per-user config dir', () => {
    const p = resolveVlcrcPath()
    expect(p.endsWith('vlcrc')).toBe(true)
    expect(p).toContain('vlc')
  })
})

describe('ensureHttpInExtraIntf', () => {
  it('returns "http" when starting from nothing', () => {
    expect(ensureHttpInExtraIntf(null)).toBe('http')
    expect(ensureHttpInExtraIntf('')).toBe('http')
  })

  it("appends http while preserving the user's existing interfaces", () => {
    // Order matters here: the user's existing list comes first, http goes
    // last. Reordering could surprise users who script against extraintf.
    expect(ensureHttpInExtraIntf('qt')).toBe('qt,http')
    expect(ensureHttpInExtraIntf('qt,oldrc')).toBe('qt,oldrc,http')
  })

  it('is idempotent when http is already present', () => {
    expect(ensureHttpInExtraIntf('http')).toBe('http')
    expect(ensureHttpInExtraIntf('qt,http')).toBe('qt,http')
  })

  it('strips surrounding whitespace and empty tokens', () => {
    // VLC tolerates `qt, oldrc` from manual edits; we normalise so subsequent
    // diff calls see a stable shape.
    expect(ensureHttpInExtraIntf(' qt , oldrc , ')).toBe('qt,oldrc,http')
  })
})

describe('vlcHttpInterfaceAction.diff', () => {
  it('returns four ini-file changes (core extraintf/host/port + lua password)', async () => {
    // VLC stores main settings under `[core]` (not `[main]`!), verified against
    // what VLC's own GUI writes when "Web" interface is enabled.
    //
    // `http-host` and `http-port` are written explicitly: leaving them unset
    // and relying on VLC's documented defaults (127.0.0.1:8080) silently fails
    // to bind. Verified live — port 8080 wouldn't accept connections until
    // they were set explicitly in vlcrc.
    const changes = await vlcHttpInterfaceAction.diff()
    expect(changes).toHaveLength(4)

    for (const change of changes) {
      expect(change.kind).toBe('ini-file')
      expect(change.target).toBe(resolveVlcrcPath())
    }

    const props = changes.map((c) => c.property).sort()
    expect(props).toEqual([
      '[core] extraintf',
      '[core] http-host',
      '[core] http-port',
      '[lua] http-password',
    ])
  })

  it('writes http-host and http-port with localhost defaults', async () => {
    const changes = await vlcHttpInterfaceAction.diff()
    const host = changes.find((c) => c.property === '[core] http-host')
    const port = changes.find((c) => c.property === '[core] http-port')
    expect(host?.next).toBe('127.0.0.1')
    expect(port?.next).toBe('8080')
  })

  it('always proposes a non-empty password', async () => {
    // On a fresh system (no vlcrc) we generate a 24-char base64url password.
    // On an existing system we deliberately reuse what's already in [lua]
    // rather than rotate it — otherwise isApplied (derived from
    // current===next) would never settle to true. So the only assertion we
    // can hold across both is "next is a non-empty string".
    const changes = await vlcHttpInterfaceAction.diff()
    const pwd = changes.find((c) => c.property === '[lua] http-password')
    expect(pwd).toBeDefined()
    expect(typeof pwd!.next).toBe('string')
    expect((pwd!.next as string).length).toBeGreaterThan(0)
  })

  it('ensures extraintf is set to a value containing http', async () => {
    const changes = await vlcHttpInterfaceAction.diff()
    const intf = changes.find((c) => c.property === '[core] extraintf')
    expect(intf).toBeDefined()
    expect(typeof intf!.next).toBe('string')
    expect((intf!.next as string).split(',')).toContain('http')
  })
})
