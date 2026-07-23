import { describe, it, expect } from 'vite-plus/test'
import { VlcHttpAdapter } from '../../src/adapters/vlc-http.js'
import type { NormalizedEvent } from '../../src/types.js'

/**
 * Session-lifecycle tests for the VLC adapter's polling loop.
 *
 * VLC's status.json has two properties that make this tricky, both verified
 * against a live VLC 3.x:
 *   1. On a playlist auto-advance it jumps straight from `playing` file A to
 *      `playing` file B — there is no `stopped` tick in between.
 *   2. When playback ends (manual stop or end of playlist) it reports
 *      `state: stopped` and DROPS `information.category.meta` entirely, so the
 *      filename is gone.
 *
 * The adapter must still emit exactly one `stopped` per watched file.
 */

const LEN = 1363
function file(ep: number): string {
  return `Монстры за работой.S01E${String(ep).padStart(2, '0')}.WEB-DL.2160p.HDR.mkv`
}
function playing(ep: number, pct: number): Record<string, unknown> {
  return {
    state: 'playing',
    time: Math.round(LEN * pct),
    length: LEN,
    version: '3.0.20 Vetinari',
    information: { category: { meta: { filename: file(ep) } } },
  }
}
/** Live VLC behaviour on stop / end-of-playlist: state cleared, meta gone. */
const STOP_CLEARS_META = { state: 'stopped', time: 0, length: 0, version: '3.0.20 Vetinari' }
/** VLC open with nothing loaded. */
const IDLE = STOP_CLEARS_META

async function drive(timeline: Array<Record<string, unknown>>): Promise<NormalizedEvent[]> {
  let idx = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => timeline[Math.min(idx, timeline.length - 1)],
    }) as Response) as typeof fetch

  const emitted: NormalizedEvent[] = []
  const adapter = new VlcHttpAdapter(
    { type: 'vlc', enabled: true, url: '', token: 'x', pollInterval: 15000, userFilter: [] },
    { onScrobble: async (e) => void emitted.push(e), onLog: () => {} },
  )
  ;(adapter as unknown as { running: boolean }).running = true
  try {
    for (; idx < timeline.length; idx++) {
      await (adapter as unknown as { poll: () => Promise<void> }).poll()
    }
  } finally {
    globalThis.fetch = realFetch
  }
  return emitted
}

const stoppedEpisodes = (events: NormalizedEvent[]): (number | null)[] =>
  events.filter((e) => e.action === 'stopped').map((e) => e.episode)

describe('VlcHttpAdapter session lifecycle', () => {
  it('emits one stopped per episode across a playlist auto-advance (6→10)', async () => {
    const events = await drive([
      playing(6, 0.5),
      playing(6, 0.93),
      playing(7, 0.07), // auto-advanced; no stopped tick from VLC
      playing(7, 0.93),
      playing(8, 0.5),
      playing(8, 0.93),
      playing(9, 0.5),
      playing(9, 0.93),
      playing(10, 0.5),
      playing(10, 0.93),
      STOP_CLEARS_META, // end of playlist — meta cleared
    ])

    expect(stoppedEpisodes(events)).toEqual([6, 7, 8, 9, 10])
    // Every watched episode also produced progress.
    for (const ep of [6, 7, 8, 9, 10]) {
      expect(events.some((e) => e.action === 'progress' && e.episode === ep)).toBe(true)
    }
  })

  it('finalises a single file when VLC stops and clears meta', async () => {
    const events = await drive([playing(6, 0.4), playing(6, 0.9), STOP_CLEARS_META])
    expect(stoppedEpisodes(events)).toEqual([6])
  })

  it('carries the last known offset into the stopped event', async () => {
    const events = await drive([playing(6, 0.4), playing(6, 0.9), STOP_CLEARS_META])
    const stop = events.find((e) => e.action === 'stopped')
    expect(stop?.viewOffset).toBe(Math.round(LEN * 0.9) * 1000)
    expect(stop?.duration).toBe(LEN * 1000)
  })

  it('does not emit a stopped when nothing was ever played', async () => {
    const events = await drive([IDLE, IDLE])
    expect(events).toEqual([])
  })

  it('does not double-emit stopped if VLC lingers in stopped state', async () => {
    const events = await drive([playing(6, 0.9), STOP_CLEARS_META, STOP_CLEARS_META, IDLE])
    expect(stoppedEpisodes(events)).toEqual([6])
  })
})
