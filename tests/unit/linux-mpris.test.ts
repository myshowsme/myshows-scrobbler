import { describe, it, expect } from 'vite-plus/test'
import { parseGetAllReply } from '../../src/utils/linux-mpris.js'

// Real gdbus output samples (text format from `gdbus call`).
// Captured against VLC and mpv on Ubuntu 24.04 for reference.

describe('parseGetAllReply (VLC)', () => {
  const reply = `({'PlaybackStatus': <'Playing'>, 'LoopStatus': <'None'>, 'Rate': <1.0>, 'Shuffle': <false>, 'Metadata': <{'mpris:trackid': <objectpath '/org/videolan/vlc/playlist/3'>, 'xesam:url': <'file:///home/user/Inception.2010.mkv'>, 'xesam:title': <'Inception.2010.mkv'>, 'mpris:length': <int64 8880000000>}>, 'Volume': <0.5>, 'Position': <int64 4500000000>, 'MinimumRate': <0.32>, 'MaximumRate': <3.0>, 'CanGoNext': <true>, 'CanGoPrevious': <true>, 'CanPlay': <true>, 'CanPause': <true>, 'CanSeek': <true>, 'CanControl': <true>},)`

  it('extracts position and duration in seconds', () => {
    const p = parseGetAllReply('org.mpris.MediaPlayer2.vlc', reply)
    expect(p).not.toBeNull()
    // 4_500_000_000 microseconds = 4500 seconds
    expect(p!.positionSeconds).toBe(4500)
    // 8_880_000_000 microseconds = 8880 seconds
    expect(p!.durationSeconds).toBe(8880)
  })

  it('decodes file:// URL to a POSIX path', () => {
    const p = parseGetAllReply('org.mpris.MediaPlayer2.vlc', reply)
    expect(p!.filePath).toBe('/home/user/Inception.2010.mkv')
  })

  it('reports isPlaying=true for Playing status', () => {
    const p = parseGetAllReply('org.mpris.MediaPlayer2.vlc', reply)
    expect(p!.isPlaying).toBe(true)
  })

  it('classifies the player by bus name suffix', () => {
    const p = parseGetAllReply('org.mpris.MediaPlayer2.vlc', reply)
    expect(p!.player).toBe('vlc')
  })
})

describe('parseGetAllReply (paused mpv)', () => {
  const reply = `({'PlaybackStatus': <'Paused'>, 'Metadata': <{'xesam:url': <'file:///tmp/Show.S01E02.mkv'>, 'xesam:title': <'Show S01E02'>, 'mpris:length': <int64 2820000000>}>, 'Position': <int64 12000000>},)`

  it('flags Paused status correctly', () => {
    const p = parseGetAllReply('org.mpris.MediaPlayer2.mpv.instance1234', reply)
    expect(p).not.toBeNull()
    expect(p!.isPlaying).toBe(false)
    expect(p!.player).toBe('mpv')
  })
})

describe('parseGetAllReply (stopped session is filtered out)', () => {
  const reply = `({'PlaybackStatus': <'Stopped'>, 'Metadata': <{}>, 'Position': <int64 0>},)`

  it('returns null when status is Stopped', () => {
    expect(parseGetAllReply('org.mpris.MediaPlayer2.foo', reply)).toBeNull()
  })
})

describe('parseGetAllReply (URL-encoded path)', () => {
  const reply = `({'PlaybackStatus': <'Playing'>, 'Metadata': <{'xesam:url': <'file:///home/user/Some%20Movie%20(2024).mkv'>, 'xesam:title': <'Some Movie'>, 'mpris:length': <int64 5400000000>}>, 'Position': <int64 0>},)`

  it('decodes %20 / parens correctly', () => {
    const p = parseGetAllReply('org.mpris.MediaPlayer2.vlc', reply)
    expect(p!.filePath).toBe('/home/user/Some Movie (2024).mkv')
  })
})

describe('parseGetAllReply (title-only stream, no xesam:url)', () => {
  const reply = `({'PlaybackStatus': <'Playing'>, 'Metadata': <{'xesam:title': <'Live Stream'>, 'mpris:length': <int64 0>}>, 'Position': <int64 60000000>},)`

  it('falls back to title-only entry with null filePath', () => {
    const p = parseGetAllReply('org.mpris.MediaPlayer2.vlc', reply)
    expect(p).not.toBeNull()
    expect(p!.filePath).toBeNull()
    expect(p!.title).toBe('Live Stream')
    expect(p!.positionSeconds).toBe(60)
  })
})

describe('parseGetAllReply (busName → player kind)', () => {
  it('maps celluloid bus name', () => {
    const reply = `({'PlaybackStatus': <'Playing'>, 'Metadata': <{'xesam:title': <'X'>}>, 'Position': <int64 0>},)`
    const p = parseGetAllReply('org.mpris.MediaPlayer2.io.github.celluloid_player.Celluloid', reply)
    expect(p!.player).toBe('celluloid')
  })

  it('returns "unknown" for unrecognised players', () => {
    const reply = `({'PlaybackStatus': <'Playing'>, 'Metadata': <{'xesam:title': <'X'>}>, 'Position': <int64 0>},)`
    const p = parseGetAllReply('org.mpris.MediaPlayer2.SomeCustomPlayer', reply)
    expect(p!.player).toBe('unknown')
  })
})
