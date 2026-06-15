import { describe, it, expect } from 'vite-plus/test'
import {
  extractPlexOnlineToken,
  extractPlexOnlineTokenFromPlist,
  plexConfigCandidates,
  plexPreferencesPathCandidates,
} from '../../src/utils/plex-token-discovery.js'

/**
 * Parser-level tests. The end-to-end disk read is tested at integration
 * level — here we cover the pure XML extractor and the platform path map.
 */

describe('extractPlexOnlineToken', () => {
  it('finds the token in a single-line Preferences.xml', () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<Preferences MachineIdentifier="abc123" PlexOnlineToken="abcDEF1234567890xyz0" ' +
      'PlexOnlineUsername="alice" LanguageInCloud="en" />'
    expect(extractPlexOnlineToken(xml)).toBe('abcDEF1234567890xyz0')
  })

  it('handles the attribute appearing at the start of the element', () => {
    const xml = '<Preferences PlexOnlineToken="firstAttr1234" MachineIdentifier="x" />'
    expect(extractPlexOnlineToken(xml)).toBe('firstAttr1234')
  })

  it('returns null when the attribute is absent (server not signed in)', () => {
    const xml = '<Preferences MachineIdentifier="x" LanguageInCloud="en" />'
    expect(extractPlexOnlineToken(xml)).toBeNull()
  })

  it("doesn't match a substring like SomethingPlexOnlineToken", () => {
    // The `\b` word-boundary guards against e.g. a custom config key that
    // contains "PlexOnlineToken" as a suffix.
    const xml = '<Preferences SomethingPlexOnlineToken="ignore-me" />'
    expect(extractPlexOnlineToken(xml)).toBeNull()
  })

  it('returns null on empty or non-XML input', () => {
    expect(extractPlexOnlineToken('')).toBeNull()
    expect(extractPlexOnlineToken('not xml at all')).toBeNull()
  })
})

describe('extractPlexOnlineTokenFromPlist', () => {
  it('finds the token in a plutil-converted plist body', () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<plist version="1.0">\n<dict>\n' +
      '\t<key>MachineIdentifier</key>\n\t<string>abc-123</string>\n' +
      '\t<key>PlexOnlineToken</key>\n\t<string>sVF84z7YgPixHfUzKnXW</string>\n' +
      '\t<key>PlexOnlineUsername</key>\n\t<string>alice</string>\n' +
      '</dict>\n</plist>'
    expect(extractPlexOnlineTokenFromPlist(xml)).toBe('sVF84z7YgPixHfUzKnXW')
  })

  it('tolerates the key and string on the same line', () => {
    const xml = '<dict><key>PlexOnlineToken</key><string>firstAttr1234</string></dict>'
    expect(extractPlexOnlineTokenFromPlist(xml)).toBe('firstAttr1234')
  })

  it('returns null when the key is absent (server not signed in)', () => {
    const xml = '<dict><key>MachineIdentifier</key><string>x</string></dict>'
    expect(extractPlexOnlineTokenFromPlist(xml)).toBeNull()
  })

  it('returns null on empty or non-plist input', () => {
    expect(extractPlexOnlineTokenFromPlist('')).toBeNull()
    expect(extractPlexOnlineTokenFromPlist('not a plist')).toBeNull()
  })
})

describe('plexConfigCandidates', () => {
  it('on macOS probes the NSUserDefaults plist before Preferences.xml', () => {
    if (process.platform !== 'darwin') {
      return
    }
    const candidates = plexConfigCandidates()
    // Native macOS PMS keeps the token in the binary plist, not Preferences.xml,
    // so the plist must be the first thing we probe.
    expect(candidates[0].format).toBe('plist')
    expect(candidates[0].path.endsWith('com.plexapp.plexmediaserver.plist')).toBe(true)
    expect(candidates.some((c) => c.format === 'xml')).toBe(true)
  })

  it('tags every Preferences.xml candidate as xml format', () => {
    for (const c of plexConfigCandidates()) {
      if (c.path.endsWith('Preferences.xml')) {
        expect(c.format).toBe('xml')
      }
    }
  })

  it('off macOS yields only xml candidates', () => {
    if (process.platform === 'darwin') {
      return
    }
    expect(plexConfigCandidates().every((c) => c.format === 'xml')).toBe(true)
  })
})

describe('plexPreferencesPathCandidates', () => {
  it('returns at least one platform-appropriate path', () => {
    const paths = plexPreferencesPathCandidates()
    expect(paths.length).toBeGreaterThan(0)
    for (const p of paths) {
      expect(p.endsWith('Preferences.xml')).toBe(true)
    }
  })

  it('points at a "Plex Media Server" directory on every platform', () => {
    for (const p of plexPreferencesPathCandidates()) {
      expect(p).toContain('Plex Media Server')
    }
  })

  it('on Windows probes the current installer layout (%LOCALAPPDATA%\\Plex\\Plex Media Server)', () => {
    if (process.platform !== 'win32') {
      return
    }
    const paths = plexPreferencesPathCandidates()
    // Plex 1.40+ Windows installs to %LOCALAPPDATA%\Plex\Plex Media Server.
    // The path with the intermediate `Plex\` directory must be probed before
    // the legacy layout — and it must actually be present.
    expect(paths.some((p) => p.endsWith('\\Plex\\Plex Media Server\\Preferences.xml'))).toBe(true)
  })

  it('on Linux probes both ~/.config and /var/lib paths', () => {
    if (process.platform !== 'linux') {
      return
    }
    const paths = plexPreferencesPathCandidates()
    expect(paths.some((p) => p.startsWith('/var/lib/plexmediaserver/'))).toBe(true)
    expect(paths.some((p) => p.includes('.config'))).toBe(true)
  })

  it('on Linux includes common Docker bind-mount and NAS appliance paths', () => {
    if (process.platform !== 'linux') {
      return
    }
    const paths = plexPreferencesPathCandidates()
    // LinuxServer.io-style and homedir bind-mount conventions.
    expect(paths.some((p) => p.startsWith('/opt/plex/config/'))).toBe(true)
    // unRAID community app default.
    expect(paths.some((p) => p.startsWith('/mnt/user/appdata/plex/'))).toBe(true)
    // Synology DSM Plex package default.
    expect(paths.some((p) => p.startsWith('/volume1/Plex/'))).toBe(true)
  })

  it('Docker / NAS candidates keep the canonical Library/Application Support suffix', () => {
    // PMS's in-container path is always `<root>/Library/Application Support/
    // Plex Media Server/Preferences.xml`; Docker bind-mounts only swap the
    // <root> half. Windows native and Linux XDG installs are the exception
    // (short path) — assert the suffix for everyone else by spotting the
    // marker substrings.
    const canonical = /Library[/\\]Application Support[/\\]Plex Media Server[/\\]Preferences\.xml$/
    const candidates = plexPreferencesPathCandidates()
    const bindMounts = candidates.filter((p) => canonical.test(p))
    expect(bindMounts.length).toBeGreaterThan(0)
    if (process.platform !== 'linux') {
      // On Linux there are short XDG-style paths legitimately. Elsewhere
      // every candidate but the Windows native one matches.
      const shortOnly = candidates.filter((p) => !canonical.test(p))
      expect(shortOnly.every((p) => p.endsWith('Preferences.xml'))).toBe(true)
    }
  })
})
