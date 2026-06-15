import { describe, it, expect } from 'vite-plus/test'
import { parseIni, getIniValue, setIniValue } from '../../src/setup/helpers/ini-file.js'

describe('parseIni', () => {
  it('parses sectionless key=value pairs', () => {
    const r = parseIni('foo=bar\nbaz=qux\n')
    expect(getIniValue(r, null, 'foo')).toBe('bar')
    expect(getIniValue(r, null, 'baz')).toBe('qux')
  })

  it('parses sectioned entries', () => {
    const r = parseIni('[main]\nfoo=bar\n[other]\nbaz=qux\n')
    expect(getIniValue(r, 'main', 'foo')).toBe('bar')
    expect(getIniValue(r, 'other', 'baz')).toBe('qux')
  })

  it('ignores # and ; comments and blank lines', () => {
    const r = parseIni('# top\n; also top\n\nfoo=bar\n# trailing\n')
    expect(getIniValue(r, null, 'foo')).toBe('bar')
  })

  it('returns null for unknown keys / sections', () => {
    const r = parseIni('foo=bar\n')
    expect(getIniValue(r, null, 'missing')).toBeNull()
    expect(getIniValue(r, 'no-such-section', 'foo')).toBeNull()
  })
})

describe('setIniValue', () => {
  it('replaces an existing key in place (preserves surrounding comments)', () => {
    const raw = '# top comment\nfoo=old\n# trailing comment\n'
    const out = setIniValue(raw, null, 'foo', 'new')
    expect(out).toBe('# top comment\nfoo=new\n# trailing comment\n')
  })

  it('inserts a new key at the end of its section', () => {
    const raw = '[main]\nfoo=1\n[other]\nbaz=2\n'
    const out = setIniValue(raw, 'main', 'new', '99')
    expect(out).toBe('[main]\nfoo=1\nnew=99\n[other]\nbaz=2\n')
  })

  it('appends a missing section at EOF with a blank-line separator', () => {
    const raw = 'foo=bar\n'
    const out = setIniValue(raw, 'newsec', 'k', 'v')
    expect(out).toBe('foo=bar\n\n[newsec]\nk=v')
  })

  it('replaces a key in a non-default section, leaving sectionless entries alone', () => {
    const raw = 'global=1\n[sec]\nx=old\n'
    const out = setIniValue(raw, 'sec', 'x', 'new')
    expect(out).toBe('global=1\n[sec]\nx=new\n')
  })

  it('inserts a sectionless key when section is null and key is new', () => {
    const raw = 'existing=1\n[other]\nfoo=bar\n'
    const out = setIniValue(raw, null, 'fresh', '2')
    // The sectionless region ends just before [other].
    expect(out).toBe('existing=1\nfresh=2\n[other]\nfoo=bar\n')
  })
})
