import { describe, it, expect } from 'vite-plus/test'
import {
  extractFilePath,
  filenameFromWindowTitle,
  normalizeExeVersion,
  parseEtimeSeconds,
  parseWmiDate,
} from '../../src/utils/process-monitor.js'

describe('extractFilePath', () => {
  it('pulls quoted Windows paths', () => {
    expect(extractFilePath('"C:\\Movies\\Inception.2010.mkv" --fullscreen')).toBe(
      'C:\\Movies\\Inception.2010.mkv',
    )
  })

  it('pulls POSIX paths', () => {
    expect(
      extractFilePath('/Applications/VLC.app/Contents/MacOS/VLC /Users/me/Show.S01E02.mp4'),
    ).toBe('/Users/me/Show.S01E02.mp4')
  })

  it('returns null when no media extension matches', () => {
    expect(extractFilePath('mpv --no-config /tmp/audio.mp3')).toBeNull()
  })
})

describe('parseEtimeSeconds', () => {
  it('parses MM:SS', () => {
    expect(parseEtimeSeconds('01:23')).toBe(83)
  })

  it('parses HH:MM:SS', () => {
    expect(parseEtimeSeconds('02:03:04')).toBe(2 * 3600 + 3 * 60 + 4)
  })

  it('parses D-HH:MM:SS', () => {
    expect(parseEtimeSeconds('1-02:03:04')).toBe(86400 + 2 * 3600 + 3 * 60 + 4)
  })
})

describe('filenameFromWindowTitle', () => {
  it('strips MPC-BE x64 version suffix (the case that triggered this fallback)', () => {
    expect(
      filenameFromWindowTitle('mpc', 'From.S04E02.2160p.AMZN.WEB-DL.H.265.mkv - MPC-BE x64 1.8.9'),
    ).toBe('From.S04E02.2160p.AMZN.WEB-DL.H.265.mkv')
  })

  it('strips MPC-HC suffix without version', () => {
    expect(filenameFromWindowTitle('mpc', 'Inception.2010.mkv - MPC-HC')).toBe('Inception.2010.mkv')
  })

  it('strips VLC suffix', () => {
    expect(filenameFromWindowTitle('vlc', 'Tenet.2020.mkv - VLC media player')).toBe(
      'Tenet.2020.mkv',
    )
  })

  it('strips mpv suffix', () => {
    expect(filenameFromWindowTitle('mpv', 'Show.S01E02.mkv - mpv')).toBe('Show.S01E02.mkv')
  })

  it('strips PotPlayer suffix (regular, Mini and localized builds)', () => {
    expect(filenameFromWindowTitle('potplayer', 'Inception.2010.mkv - PotPlayer')).toBe(
      'Inception.2010.mkv',
    )
    expect(filenameFromWindowTitle('potplayer', 'Tenet.2020.mkv - PotPlayer Mini')).toBe(
      'Tenet.2020.mkv',
    )
    expect(
      filenameFromWindowTitle('potplayer', 'Беглец.2023.WEB-DL.2160p.mkv - PotPlayer Rus'),
    ).toBe('Беглец.2023.WEB-DL.2160p.mkv')
  })

  it('strips localized VLC branding', () => {
    expect(filenameFromWindowTitle('vlc', 'Беглец.2023.mkv - Медиапроигрыватель VLC')).toBe(
      'Беглец.2023.mkv',
    )
  })

  it('returns null when PotPlayer title is just the branding (no file loaded)', () => {
    expect(filenameFromWindowTitle('potplayer', 'PotPlayer')).toBeNull()
  })

  it('strips Windows Media Player / Movies & TV / RU localization', () => {
    expect(filenameFromWindowTitle('wmp', 'Foo.mkv - Movies & TV')).toBe('Foo.mkv')
    expect(filenameFromWindowTitle('wmp', 'Foo.mkv - Кино и ТВ')).toBe('Foo.mkv')
  })

  it('strips MPC paused/stopped state prefix', () => {
    expect(filenameFromWindowTitle('mpc', '[Paused] Inception.2010.mkv - MPC-HC')).toBe(
      'Inception.2010.mkv',
    )
  })

  it('returns null when title is just the player branding (no file open)', () => {
    expect(filenameFromWindowTitle('mpc', 'MPC-BE x64 1.8.9')).toBeNull()
    expect(filenameFromWindowTitle('vlc', 'VLC media player')).toBeNull()
  })

  it('returns null for mpv idle title "No file - mpv" (nothing loaded)', () => {
    expect(filenameFromWindowTitle('mpv', 'No file - mpv')).toBeNull()
    expect(filenameFromWindowTitle('mpv', 'no file - mpv')).toBeNull()
  })

  it('returns null for empty title', () => {
    expect(filenameFromWindowTitle('mpc', '')).toBeNull()
  })

  it('returns null for players without a known title format', () => {
    expect(filenameFromWindowTitle('browser', 'Some Tab Title')).toBeNull()
    expect(filenameFromWindowTitle('spotify', 'Song')).toBeNull()
  })
})

describe('normalizeExeVersion', () => {
  it('normalizes comma-separated PE versions to dots', () => {
    expect(normalizeExeVersion('3,0,23,0')).toBe('3.0.23.0')
    expect(normalizeExeVersion('0, 0, 1, 0')).toBe('0.0.1.0')
  })

  it('keeps already-clean versions as-is', () => {
    expect(normalizeExeVersion('1.7.13 (e37826845)')).toBe('1.7.13 (e37826845)')
    expect(normalizeExeVersion('v0.41.0')).toBe('v0.41.0')
  })

  it('drops zeroed-out versions (repacks strip the version block)', () => {
    expect(normalizeExeVersion('0, 0, 0, 0')).toBeUndefined()
    expect(normalizeExeVersion('0.0.0.0')).toBeUndefined()
    expect(normalizeExeVersion('')).toBeUndefined()
    expect(normalizeExeVersion(undefined)).toBeUndefined()
  })
})

describe('parseWmiDate', () => {
  it('parses /Date(ms)/ epoch format', () => {
    const d = parseWmiDate('/Date(1700000000000)/')
    expect(d.getTime()).toBe(1700000000000)
  })

  it('parses YYYYMMDDhhmmss format', () => {
    const d = parseWmiDate('20260406123045.123456+000')
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(3) // April → 3
    expect(d.getDate()).toBe(6)
  })
})
