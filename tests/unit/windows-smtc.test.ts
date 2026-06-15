import { describe, it, expect } from 'vite-plus/test'
import { classifyAumid, isSmtcPlayback } from '../../src/utils/windows-smtc.js'
import { SMTC_SKIP_PLAYERS } from '../../src/adapters/player.js'

describe('classifyAumid', () => {
  it('maps VLC (UWP + classic) to "vlc"', () => {
    expect(classifyAumid('VideoLAN.VLC_pcvm4z2zphcb6!App')).toBe('vlc')
    expect(classifyAumid('VLC.exe')).toBe('vlc')
  })

  it('maps MPC-HC variants to "mpc"', () => {
    expect(classifyAumid('mpc-hc.exe')).toBe('mpc')
    expect(classifyAumid('Some.MPCHC.AUMID')).toBe('mpc')
  })

  it('maps PotPlayer (exe-name AUMID) to "potplayer"', () => {
    expect(classifyAumid('PotPlayerMini64.exe')).toBe('potplayer')
    expect(classifyAumid('PotPlayer64.exe')).toBe('potplayer')
    expect(classifyAumid('PotPlayer.exe')).toBe('potplayer')
  })

  it('maps modern Windows Media Player AUMIDs to "wmp"', () => {
    expect(classifyAumid('Microsoft.Media.Player_8wekyb3d8bbwe!App')).toBe('wmp')
    expect(classifyAumid('Microsoft.ZuneVideo_8wekyb3d8bbwe!Microsoft.ZuneVideo')).toBe('wmp')
    expect(classifyAumid('wmplayer.exe')).toBe('wmp')
  })

  it('maps browsers to "browser"', () => {
    expect(classifyAumid('Chrome')).toBe('browser')
    expect(classifyAumid('MSEdge')).toBe('browser')
    expect(classifyAumid('Firefox.exe')).toBe('browser')
  })

  it('maps Spotify to "spotify" so the adapter can skip it', () => {
    expect(classifyAumid('Spotify.Spotify')).toBe('spotify')
  })

  it('returns "unknown" for unrecognised AUMIDs', () => {
    expect(classifyAumid('SomeRandom.UnknownApp')).toBe('unknown')
  })
})

describe('isSmtcPlayback', () => {
  const validPayload = {
    appUserModelId: 'Microsoft.Media.Player_8wekyb3d8bbwe!App',
    title: 'Episode 1',
    artist: '',
    albumTitle: 'Show Title',
    isPlaying: true,
    positionSeconds: 12.5,
    durationSeconds: 2700,
  }

  it('accepts a payload with the new albumTitle field', () => {
    expect(isSmtcPlayback(validPayload)).toBe(true)
    // Empty albumTitle is still valid — the probe sets it to '' when absent.
    expect(isSmtcPlayback({ ...validPayload, albumTitle: '' })).toBe(true)
  })

  it('rejects a payload missing albumTitle (or wrong type)', () => {
    const { albumTitle: _omit, ...withoutAlbum } = validPayload
    expect(isSmtcPlayback(withoutAlbum)).toBe(false)
    expect(isSmtcPlayback({ ...validPayload, albumTitle: 42 })).toBe(false)
    expect(isSmtcPlayback({ ...validPayload, albumTitle: null })).toBe(false)
  })
})

describe('SMTC_SKIP_PLAYERS', () => {
  it('includes "spotify" — pure music source, not what MyShows tracks', () => {
    expect(SMTC_SKIP_PLAYERS).toContain('spotify')
  })

  it('includes "browser" — SMTC for browsers only exposes the page <title>, too weak to scrobble safely', () => {
    expect(SMTC_SKIP_PLAYERS).toContain('browser')
  })

  it('does NOT skip native video players like VLC / WMP', () => {
    expect(SMTC_SKIP_PLAYERS).not.toContain('vlc')
    expect(SMTC_SKIP_PLAYERS).not.toContain('mpc')
    expect(SMTC_SKIP_PLAYERS).not.toContain('wmp')
    expect(SMTC_SKIP_PLAYERS).not.toContain('mpv')
  })
})
