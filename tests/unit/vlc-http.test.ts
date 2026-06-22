import { describe, it, expect } from 'vite-plus/test'
import {
  snapshotFromVlc,
  buildEvent,
  isActivelyPlaying,
  resolveVlcEndpoint,
} from '../../src/adapters/vlc-http.js'

/**
 * Tests cover the pure data path of the VLC HTTP adapter: JSON projection →
 * NormalizedEvent. The HTTP polling loop, basic-auth flow, and session state
 * machine are not unit-tested here — they're exercised at integration level
 * when a real VLC is available (see windows-tandem-verification.md).
 */

const SAMPLE_PLAYING_JSON = {
  fullscreen: false,
  state: 'playing',
  time: 3600, // seconds
  length: 8880, // seconds
  version: '3.0.20 Vetinari',
  information: {
    category: {
      meta: {
        filename: 'Inception.mkv',
        title: 'Inception',
      },
    },
  },
}

const SAMPLE_EPISODE_PAUSED_JSON = {
  state: 'paused',
  time: 120,
  length: 2820,
  version: '3.0.20 Vetinari',
  information: {
    category: {
      meta: {
        filename: "Breaking.Bad.S01E02.Cat's.in.the.Bag.mkv",
      },
    },
  },
}

const SAMPLE_IDLE_JSON = {
  state: 'stopped',
  time: 0,
  length: 0,
  version: '3.0.20 Vetinari',
  // No information.category.meta — pre-load state.
}

describe('snapshotFromVlc', () => {
  it('converts seconds to ms and propagates strings', () => {
    const snapshot = snapshotFromVlc(SAMPLE_PLAYING_JSON)
    expect(snapshot.state).toBe('playing')
    expect(snapshot.positionMs).toBe(3_600_000)
    expect(snapshot.durationMs).toBe(8_880_000)
    expect(snapshot.filename).toBe('Inception.mkv')
    expect(snapshot.version).toBe('3.0.20 Vetinari')
  })

  it('falls back to zeros and empty filename when nothing is loaded', () => {
    const snapshot = snapshotFromVlc(SAMPLE_IDLE_JSON)
    expect(snapshot.state).toBe('stopped')
    expect(snapshot.positionMs).toBe(0)
    expect(snapshot.durationMs).toBe(0)
    expect(snapshot.filename).toBe('')
  })

  it('normalises unknown state strings to "idle"', () => {
    const snapshot = snapshotFromVlc({ ...SAMPLE_PLAYING_JSON, state: 'buffering' })
    expect(snapshot.state).toBe('idle')
  })

  it('tolerates a fully empty body without throwing', () => {
    const snapshot = snapshotFromVlc({})
    expect(snapshot.state).toBe('stopped')
    expect(snapshot.filename).toBe('')
  })
})

describe('isActivelyPlaying', () => {
  it('is true for playing/paused with a real duration', () => {
    expect(
      isActivelyPlaying({
        state: 'playing',
        positionMs: 0,
        durationMs: 1000,
        filename: 'x.mkv',
        version: null,
      }),
    ).toBe(true)
    expect(
      isActivelyPlaying({
        state: 'paused',
        positionMs: 0,
        durationMs: 1000,
        filename: 'x.mkv',
        version: null,
      }),
    ).toBe(true)
  })

  it('is false for stopped (pre-load or end of playback)', () => {
    expect(
      isActivelyPlaying({
        state: 'stopped',
        positionMs: 0,
        durationMs: 1000,
        filename: 'x.mkv',
        version: null,
      }),
    ).toBe(false)
  })

  it('is false when duration is 0 even if state says playing', () => {
    // VLC reports state=playing/length=0 momentarily between files. We don't
    // want to emit a 0%/0-duration event during that flicker.
    expect(
      isActivelyPlaying({
        state: 'playing',
        positionMs: 0,
        durationMs: 0,
        filename: 'x.mkv',
        version: null,
      }),
    ).toBe(false)
  })
})

describe('buildEvent', () => {
  it('builds a movie event from a movie filename', () => {
    const event = buildEvent(snapshotFromVlc(SAMPLE_PLAYING_JSON), 'progress')
    expect(event).not.toBeNull()
    expect(event?.type).toBe('movie')
    expect(event?.source).toBe('vlc')
    expect(event?.action).toBe('progress')
    expect(event?.state).toBe('playing')
    expect(event?.duration).toBe(8_880_000)
    expect(event?.viewOffset).toBe(3_600_000)
    expect(event?.sessionId).toBe('vlc:Inception.mkv')
    expect(event?.appVersion).toBe('3.0.20 Vetinari')
    expect(event?.title?.toLowerCase()).toContain('inception')
    expect(event?.media?.container).toBe('mkv')
  })

  it('builds an episode event with season and episode numbers parsed', () => {
    const event = buildEvent(snapshotFromVlc(SAMPLE_EPISODE_PAUSED_JSON), 'progress')
    expect(event).not.toBeNull()
    expect(event?.type).toBe('episode')
    expect(event?.season).toBe(1)
    expect(event?.episode).toBe(2)
    expect(event?.state).toBe('paused')
    expect(event?.title?.toLowerCase()).toContain('breaking')
  })

  it('returns null for an audio-only file (music)', () => {
    const event = buildEvent(
      {
        state: 'playing',
        positionMs: 60_000,
        durationMs: 200_000,
        filename: 'Pink Floyd - Time.flac',
        version: null,
        audio: { language: null, description: null, codec: 'flac', channels: 2 },
        video: null,
      },
      'progress',
    )
    expect(event).toBeNull()
  })

  it('returns null when filename is empty', () => {
    const event = buildEvent(
      { state: 'stopped', positionMs: 0, durationMs: 0, filename: '', version: null },
      'progress',
    )
    expect(event).toBeNull()
  })
})

describe('resolveVlcEndpoint', () => {
  it('returns the default 127.0.0.1:8080 when no URL is configured', () => {
    expect(resolveVlcEndpoint('')).toEqual({ host: '127.0.0.1', port: 8080 })
  })

  it('honours an explicit host and port from a full URL', () => {
    expect(resolveVlcEndpoint('http://192.168.1.10:8090')).toEqual({
      host: '192.168.1.10',
      port: 8090,
    })
  })

  it('accepts a bare host:port string', () => {
    expect(resolveVlcEndpoint('localhost:8081')).toEqual({ host: 'localhost', port: 8081 })
  })

  it('falls back to defaults on malformed input', () => {
    expect(resolveVlcEndpoint('not a url at all')).toEqual({ host: '127.0.0.1', port: 8080 })
  })
})
