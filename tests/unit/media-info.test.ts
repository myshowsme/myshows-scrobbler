import { describe, it, expect } from 'vitest'
import { hdrFromFilename, resolutionFromFilename } from '../../src/adapters/media-info.js'

describe('resolutionFromFilename', () => {
  it('extracts 2160p / 4K aliases', () => {
    expect(resolutionFromFilename('Беглец.2023.WEB-DL.2160p.mkv')).toBe('2160')
    expect(resolutionFromFilename('Movie.2024.4K.HDR.mkv')).toBe('2160')
    expect(resolutionFromFilename('Movie.2024.UHD.BluRay.mkv')).toBe('2160')
    expect(resolutionFromFilename('Movie.2160.mkv')).toBe('2160')
  })

  it('extracts the common p-suffixed tiers', () => {
    expect(resolutionFromFilename('Show.S01E02.1080p.WEB-DL.mkv')).toBe('1080')
    expect(resolutionFromFilename('Show.S01E02.1080i.HDTV.ts')).toBe('1080')
    expect(resolutionFromFilename('Movie.720p.BluRay.mkv')).toBe('720')
    expect(resolutionFromFilename('Old.Show.576p.DVDRip.avi')).toBe('576')
    expect(resolutionFromFilename('Old.Movie.480p.avi')).toBe('480')
  })

  it('ignores bare sub-4K numbers (too collision-prone)', () => {
    expect(resolutionFromFilename('Movie.1080.mkv')).toBeNull()
    expect(resolutionFromFilename('Movie.720.mkv')).toBeNull()
  })

  it('only looks at the filename, not directories', () => {
    expect(resolutionFromFilename('D:\\1080p\\Movie.2024.mkv')).toBeNull()
    expect(resolutionFromFilename('/mnt/4k/Movie.2024.mkv')).toBeNull()
  })

  it('returns null when nothing matches', () => {
    expect(resolutionFromFilename('Беглец.2023.mkv')).toBeNull()
    expect(resolutionFromFilename(undefined)).toBeNull()
    expect(resolutionFromFilename('')).toBeNull()
  })
})

describe('hdrFromFilename', () => {
  it('detects Dolby Vision tokens, winning over a trailing HDR fallback tag', () => {
    expect(
      hdrFromFilename('Monarch.Legacy.of.Monsters.S01E05.2160p.ATVP.WEB-DL.DV.HDR.H.265.mkv'),
    ).toBe('dolby_vision')
    expect(hdrFromFilename('Movie.2024.DoVi.2160p.mkv')).toBe('dolby_vision')
    expect(hdrFromFilename('Movie.2024.Dolby.Vision.mkv')).toBe('dolby_vision')
  })

  it('detects HDR10+ before plain HDR10', () => {
    expect(hdrFromFilename('Movie.2024.2160p.HDR10+.mkv')).toBe('hdr10_plus')
    expect(hdrFromFilename('Movie.2024.2160p.HDR10Plus.mkv')).toBe('hdr10_plus')
    expect(hdrFromFilename('Movie.2024.2160p.HDR10.mkv')).toBe('hdr10')
    expect(hdrFromFilename('Movie.2024.2160p.HDR.mkv')).toBe('hdr10')
  })

  it('detects HLG', () => {
    expect(hdrFromFilename('Broadcast.2160p.HLG.ts')).toBe('hlg')
  })

  it('does not false-positive on DVDRip or plain SDR names', () => {
    expect(hdrFromFilename('Old.Movie.DVDRip.avi')).toBeNull()
    expect(hdrFromFilename('Беглец.2023.WEB-DL.2160p.mkv')).toBeNull()
    expect(hdrFromFilename(undefined)).toBeNull()
  })
})
