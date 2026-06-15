import { describe, expect, it } from 'vite-plus/test'
import { isAsciiToken } from './validation.js'

describe('isAsciiToken', () => {
  it('accepts empty and ASCII-only tokens', () => {
    expect(isAsciiToken('')).toBe(true)
    expect(isAsciiToken('abc.DEF-123_~+/=')).toBe(true)
  })

  it('rejects non-ASCII tokens', () => {
    expect(
      isAsciiToken('token-\u0441-\u043A\u0438\u0440\u0438\u043B\u043B\u0438\u0446\u0435\u0439'),
    ).toBe(false)
    expect(isAsciiToken('token\u2014dash')).toBe(false)
    expect(isAsciiToken('token\u00FF')).toBe(false)
  })
})
