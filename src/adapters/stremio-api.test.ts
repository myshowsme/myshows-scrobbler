import { describe, it, expect, vi, afterEach } from 'vite-plus/test'
import { datastoreMeta, datastoreGet } from './stremio-api.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  )
}

describe('datastoreMeta', () => {
  it('returns the result array of [id, mtime] pairs', async () => {
    stubFetch(200, {
      result: [
        ['tt1', 1000],
        ['tt2', 2000],
      ],
    })
    const meta = await datastoreMeta('KEY')
    expect(meta).toEqual([
      ['tt1', 1000],
      ['tt2', 2000],
    ])
  })

  it('throws with status on a non-ok HTTP response', async () => {
    stubFetch(500, {})
    await expect(datastoreMeta('KEY')).rejects.toMatchObject({ status: 500 })
  })

  it('throws when the API returns an error body', async () => {
    stubFetch(200, { error: { code: 1, message: 'Session does not exist' } })
    await expect(datastoreMeta('BAD')).rejects.toMatchObject({
      message: 'Session does not exist',
    })
  })
})

describe('datastoreGet', () => {
  it('returns the result library items', async () => {
    stubFetch(200, { result: [{ _id: 'tt1', name: 'X', type: 'movie', _mtime: 1, state: {} }] })
    const items = await datastoreGet('KEY', ['tt1'])
    expect(items[0]._id).toBe('tt1')
  })
})
