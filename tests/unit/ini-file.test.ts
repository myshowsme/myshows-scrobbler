import { describe, it, expect } from 'vite-plus/test'
import { parseIni, setIniValue, getIniValue } from '../../src/setup/helpers/ini-file.js'

/**
 * Focused regressions on the INI parser/writer. The full happy-path is
 * exercised through the VLC and mpv setup tests; this file lives for cases
 * that bit us in production once and shouldn't bite us twice.
 */

describe('parseIni — section headers with trailing comments', () => {
  // VLC's vlcrc writes every section header with a `# description` after the
  // closing bracket. Without trailing-comment tolerance, the parser silently
  // skipped these headers and threw all keys under the previous section. In
  // VLC's case that caused `setIniValue` to append a *second* `[lua]` block
  // at EOF, leaving two http-password entries — VLC then read the wrong one
  // and rejected our auth.
  const VLC_STYLE = `[main] # main program
extraintf=qt

[lua] # Lua interpreter
http-password=secret
`

  it('treats `[name] # comment` as a section header', () => {
    const parsed = parseIni(VLC_STYLE)
    expect(getIniValue(parsed, 'lua', 'http-password')).toBe('secret')
    expect(getIniValue(parsed, 'main', 'extraintf')).toBe('qt')
  })

  it('setIniValue updates in place instead of appending a duplicate section', () => {
    const next = setIniValue(VLC_STYLE, 'lua', 'http-password', 'rotated')
    // No second `[lua]` block.
    expect(next.match(/\[lua\]/g)?.length ?? 0).toBe(1)
    expect(next).toContain('http-password=rotated')
    expect(next).not.toContain('http-password=secret')
  })

  it('setIniValue inserts a new key into the existing section', () => {
    const next = setIniValue(VLC_STYLE, 'main', 'http-port', '8080')
    expect(next.match(/\[main\]/g)?.length ?? 0).toBe(1)
    // New key lives inside the [main] block, not appended to EOF.
    const mainBlock = next.split(/\[lua\]/)[0]
    expect(mainBlock).toContain('http-port=8080')
  })
})

describe('parseIni — plain section headers (mpv.conf style)', () => {
  // Make sure the new lenient regex didn't break the old behaviour: section
  // headers without trailing comments must still work.
  it('parses standard `[section]` headers without comments', () => {
    const parsed = parseIni('[main]\nfoo=bar\n')
    expect(getIniValue(parsed, 'main', 'foo')).toBe('bar')
  })

  it('treats top-of-file keys (before any header) as the null section', () => {
    const parsed = parseIni('input-ipc-server=/tmp/x\nother=1\n')
    expect(getIniValue(parsed, null, 'input-ipc-server')).toBe('/tmp/x')
  })
})
