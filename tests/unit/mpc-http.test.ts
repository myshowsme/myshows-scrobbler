import { describe, it, expect } from 'vite-plus/test'
import {
  parseMpcVariables,
  snapshotFromVariables,
  buildEvent,
  resolveEndpoint,
  isActivelyPlaying,
} from '../../src/adapters/mpc-http.js'

/**
 * Tests cover the pure data path of the MPC HTTP adapter: HTML parser →
 * snapshot projection → NormalizedEvent construction. The HTTP polling
 * loop and session state machine are intentionally not unit-tested here —
 * they're tested at integration level when a real MPC is available.
 */

const SAMPLE_HTML = `<html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>
<body>
<p id="file">Inception.mkv</p>
<p id="filepath">C:\\Movies\\Inception.mkv</p>
<p id="state">2</p>
<p id="statestring">Playing</p>
<p id="position">3600000</p>
<p id="duration">8880000</p>
<p id="volumelevel">100</p>
<p id="muted">0</p>
</body></html>`

const EPISODE_HTML = `<html><body>
<p id="file">Breaking.Bad.S01E02.Cat's.in.the.Bag.mkv</p>
<p id="filepath">D:\\TV\\Breaking.Bad.S01E02.Cat's.in.the.Bag.mkv</p>
<p id="state">1</p>
<p id="position">120000</p>
<p id="duration">2820000</p>
</body></html>`

describe('parseMpcVariables', () => {
  it('extracts every <p id="…"> entry into a flat map', () => {
    const vars = parseMpcVariables(SAMPLE_HTML)
    expect(vars.file).toBe('Inception.mkv')
    expect(vars.filepath).toBe('C:\\Movies\\Inception.mkv')
    expect(vars.state).toBe('2')
    expect(vars.position).toBe('3600000')
    expect(vars.duration).toBe('8880000')
    expect(vars.statestring).toBe('Playing')
  })

  it('returns an empty object when the page has no <p id> entries', () => {
    expect(parseMpcVariables('<html><body>Nothing here</body></html>')).toEqual({})
  })

  it('tolerates extra whitespace, attributes and unknown variables', () => {
    const html = `<p id="file">x.mkv</p>
                  <p id="rate">1.00</p>
                  <p id="reloadtime">0</p>`
    const vars = parseMpcVariables(html)
    expect(vars.file).toBe('x.mkv')
    expect(vars.rate).toBe('1.00')
    expect(vars.reloadtime).toBe('0')
  })

  it('keeps empty values when MPC reports them', () => {
    // Pre-load MPC emits <p id="file"></p> — must not skip the key.
    const vars = parseMpcVariables('<p id="file"></p><p id="state">0</p>')
    expect(vars.file).toBe('')
    expect(vars.state).toBe('0')
  })
})

describe('snapshotFromVariables', () => {
  it('parses numbers and propagates strings', () => {
    const vars = parseMpcVariables(SAMPLE_HTML)
    const snapshot = snapshotFromVariables(vars)
    expect(snapshot.state).toBe(2)
    expect(snapshot.positionMs).toBe(3_600_000)
    expect(snapshot.durationMs).toBe(8_880_000)
    expect(snapshot.file).toBe('Inception.mkv')
    expect(snapshot.filepath).toBe('C:\\Movies\\Inception.mkv')
  })

  it('falls back to 0 / "" when fields are missing or unparseable', () => {
    const snapshot = snapshotFromVariables({ state: 'oops' })
    expect(snapshot.state).toBe(0)
    expect(snapshot.positionMs).toBe(0)
    expect(snapshot.durationMs).toBe(0)
    expect(snapshot.file).toBe('')
    expect(snapshot.filepath).toBe('')
  })
})

describe('buildEvent', () => {
  it('maps the container probe into media and dub team when provided', () => {
    const snapshot = snapshotFromVariables(parseMpcVariables(SAMPLE_HTML))
    const event = buildEvent(snapshot, 'progress', {
      audio: {
        language: 'rus',
        title: 'Dub, Велес',
        codec: 'ac3',
        channels: 6,
      },
      video: { width: 3840, height: 2160, transfer: 'smpte2084', dovi: false },
    })
    expect(event?.media?.audioLanguage).toBe('ru')
    expect(event?.media?.audioCodec).toBe('ac3')
    expect(event?.media?.audioChannels).toBe(6)
    expect(event?.media?.resolution).toBe('2160')
    expect(event?.media?.hdr).toBe('hdr10')
    expect(event?.dubTeam).toBe('Велес')
  })

  it('returns null when the probe shows audio but no video stream (music)', () => {
    const snapshot = snapshotFromVariables(parseMpcVariables(SAMPLE_HTML))
    const event = buildEvent(snapshot, 'progress', {
      audio: { language: null, title: null, codec: 'flac', channels: 2 },
      video: null,
    })
    expect(event).toBeNull()
  })

  it('reports dolby_vision when the probe carries a DV configuration record', () => {
    const snapshot = snapshotFromVariables(parseMpcVariables(SAMPLE_HTML))
    const event = buildEvent(snapshot, 'progress', {
      audio: null,
      video: { width: 3840, height: 2160, transfer: 'smpte2084', dovi: true },
    })
    expect(event?.media?.hdr).toBe('dolby_vision')
  })

  it('exposes the player version from variables.html as appVersion', () => {
    const vars = parseMpcVariables(SAMPLE_HTML)
    vars.version = '1.8.9.0'
    const event = buildEvent(snapshotFromVariables(vars), 'progress')
    expect(event?.appVersion).toBe('1.8.9.0')
  })

  it('keeps audio fields null without a track probe', () => {
    const snapshot = snapshotFromVariables(parseMpcVariables(SAMPLE_HTML))
    const event = buildEvent(snapshot, 'progress')
    expect(event?.media?.audioLanguage).toBeNull()
    expect(event?.media?.audioCodec).toBeNull()
    expect(event?.media?.audioChannels).toBeNull()
  })

  it('builds a movie event from a movie filename', () => {
    const snapshot = snapshotFromVariables(parseMpcVariables(SAMPLE_HTML))
    const event = buildEvent(snapshot, 'progress')
    expect(event).not.toBeNull()
    expect(event?.type).toBe('movie')
    expect(event?.source).toBe('mpc')
    expect(event?.action).toBe('progress')
    expect(event?.state).toBe('playing')
    expect(event?.duration).toBe(8_880_000)
    expect(event?.viewOffset).toBe(3_600_000)
    expect(event?.sessionId).toBe('mpc:C:\\Movies\\Inception.mkv')
    expect(event?.title?.toLowerCase()).toContain('inception')
    expect(event?.media?.container).toBe('mkv')
  })

  it('builds an episode event with season and episode numbers parsed', () => {
    const snapshot = snapshotFromVariables(parseMpcVariables(EPISODE_HTML))
    const event = buildEvent(snapshot, 'progress')
    expect(event).not.toBeNull()
    expect(event?.type).toBe('episode')
    expect(event?.season).toBe(1)
    expect(event?.episode).toBe(2)
    expect(event?.state).toBe('paused')
    expect(event?.title?.toLowerCase()).toContain('breaking')
  })

  it('returns null when neither file nor filepath is set', () => {
    const event = buildEvent(
      { state: 0, positionMs: 0, durationMs: 0, file: '', filepath: '' },
      'progress',
    )
    expect(event).toBeNull()
  })

  it('uses bare filename when filepath is unavailable', () => {
    const event = buildEvent(
      { state: 2, positionMs: 100, durationMs: 1000, file: 'movie.mp4', filepath: '' },
      'progress',
    )
    expect(event?.sessionId).toBe('mpc:movie.mp4')
  })
})

describe('isActivelyPlaying', () => {
  const snap = (state: number, durationMs: number) => ({
    state,
    durationMs,
    positionMs: 0,
    file: 'x.mkv',
    filepath: 'C:\\x.mkv',
  })

  it('is true for playing/paused with a real duration', () => {
    expect(isActivelyPlaying(snap(2, 3600000))).toBe(true)
    expect(isActivelyPlaying(snap(1, 3600000))).toBe(true)
  })

  it('is false for MPC-BE state=-1 (loaded, not started)', () => {
    expect(isActivelyPlaying(snap(-1, 0))).toBe(false)
  })

  it('is false for stopped (state=0)', () => {
    expect(isActivelyPlaying(snap(0, 3600000))).toBe(false)
  })

  it('is false when duration is 0 even if state says playing', () => {
    expect(isActivelyPlaying(snap(2, 0))).toBe(false)
  })
})

describe('resolveEndpoint', () => {
  it('returns the default localhost:13579 endpoint when no URL is configured', () => {
    expect(resolveEndpoint('')).toBe('http://127.0.0.1:13579/variables.html')
  })

  it('honours an explicit port from a full URL', () => {
    expect(resolveEndpoint('http://127.0.0.1:13580')).toBe('http://127.0.0.1:13580/variables.html')
  })

  it('accepts a bare host:port string', () => {
    expect(resolveEndpoint('localhost:13581')).toBe('http://localhost:13581/variables.html')
  })

  it('falls back to defaults on malformed input', () => {
    expect(resolveEndpoint('not a url at all')).toBe('http://127.0.0.1:13579/variables.html')
  })
})
