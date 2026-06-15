import { describe, it, expect } from 'vite-plus/test'
import { isLoopbackUrl, normalizeBaseUrl } from '../../src/utils/url.js'

describe('normalizeBaseUrl', () => {
  it('prepends http:// when no scheme is given', () => {
    expect(normalizeBaseUrl('192.168.1.50:8096')).toBe('http://192.168.1.50:8096')
  })

  it('keeps existing http:// / https:// schemes intact', () => {
    expect(normalizeBaseUrl('http://localhost:8096')).toBe('http://localhost:8096')
    expect(normalizeBaseUrl('https://jellyfin.example.com')).toBe('https://jellyfin.example.com')
  })

  it('strips trailing slashes', () => {
    expect(normalizeBaseUrl('http://localhost:8096/')).toBe('http://localhost:8096')
    expect(normalizeBaseUrl('http://localhost:8096///')).toBe('http://localhost:8096')
  })

  it('returns empty string for empty input', () => {
    expect(normalizeBaseUrl('')).toBe('')
    expect(normalizeBaseUrl('   ')).toBe('')
  })
})

describe('isLoopbackUrl', () => {
  it('recognises 127.x, localhost and ::1', () => {
    expect(isLoopbackUrl('http://127.0.0.1:8080')).toBe(true)
    expect(isLoopbackUrl('http://127.1.2.3:1234')).toBe(true)
    expect(isLoopbackUrl('http://localhost:8080')).toBe(true)
    expect(isLoopbackUrl('http://[::1]:8080')).toBe(true)
  })

  it('returns false for non-loopback hosts', () => {
    expect(isLoopbackUrl('http://192.168.1.100:8080')).toBe(false)
    expect(isLoopbackUrl('https://kodi.example.com')).toBe(false)
  })

  it('returns false for unparseable input', () => {
    expect(isLoopbackUrl('')).toBe(false)
    expect(isLoopbackUrl('not a url')).toBe(false)
  })
})
