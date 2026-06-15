import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { SERVICE_REQUEST_TIMEOUT_MS } from '../../src/config.js'
import { fetchWithTimeout } from '../../src/http.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('fetchWithTimeout', () => {
  it('adds the default timeout signal when no signal is provided', async () => {
    const timeoutSignal = AbortSignal.abort()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal)
    const fetchMock = vi.fn().mockResolvedValue(new Response())
    vi.stubGlobal('fetch', fetchMock)

    await fetchWithTimeout('http://example.test/api', { headers: { Accept: 'application/json' } })

    expect(timeoutSpy).toHaveBeenCalledWith(SERVICE_REQUEST_TIMEOUT_MS)
    expect(fetchMock).toHaveBeenCalledWith('http://example.test/api', {
      headers: { Accept: 'application/json' },
      signal: timeoutSignal,
    })
  })

  it('preserves an explicit caller signal instead of creating a timeout signal', async () => {
    const controller = new AbortController()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    const fetchMock = vi.fn().mockResolvedValue(new Response())
    vi.stubGlobal('fetch', fetchMock)

    await fetchWithTimeout('http://example.test/api', { signal: controller.signal }, 1234)

    expect(timeoutSpy).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledWith('http://example.test/api', {
      signal: controller.signal,
    })
  })
})
