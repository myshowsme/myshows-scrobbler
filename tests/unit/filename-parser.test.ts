import { describe, it, expect } from 'vite-plus/test'
import { parseFilename } from '../../src/utils/filename-parser.js'

describe('parseFilename', () => {
  it('parses TV episode filenames', () => {
    const result = parseFilename('Breaking.Bad.S01E02.1080p.WEB-DL.mkv')
    expect(result.type).toBe('episode')
    expect(result.season).toBe(1)
    expect(result.episode).toBe(2)
    expect(result.title).toBe('Breaking Bad')
  })

  it('parses movie filenames with a year', () => {
    const result = parseFilename('/movies/Inception.2010.1080p.BluRay.mkv')
    expect(result.type).toBe('movie')
    expect(result.year).toBe(2010)
    expect(result.title).toBe('Inception')
  })

  it('decodes file:// URLs', () => {
    const result = parseFilename('file:///Users/me/Inception%202010.mkv')
    expect(result.title?.toLowerCase()).toContain('inception')
  })

  it('falls back to a cleaned filename when nothing matches', () => {
    const result = parseFilename('something.weird.txt')
    expect(result.title).toBeTruthy()
  })

  it('recovers the episode from "Show - NN [tags with year]" anime names', () => {
    const result = parseFilename('Dungeon Meshi - 03 [WEB-DL 1080p 2024].mkv')
    expect(result.type).toBe('episode')
    expect(result.title).toBe('Dungeon Meshi')
    expect(result.episode).toBe(3)
    expect(result.season).toBeNull()
    expect(result.year).toBe(2024)
  })

  it('keeps 4-digit trailing numbers as movie years, not episodes', () => {
    const result = parseFilename('Some Movie - 1984 [1080p].mkv')
    expect(result.type).toBe('movie')
    expect(result.episode).toBeNull()
  })

  it('does not mirror the year into season for EPnn.YYYY anime releases', () => {
    const result = parseFilename(
      'Tongari.Boushi.no.Atelier.EP01.2026.1080p.WEB-DL.AAC2.0.x264-tG1R0.mkv',
    )
    expect(result.type).toBe('episode')
    expect(result.title).toBe('Tongari Boushi no Atelier')
    expect(result.episode).toBe(1)
    expect(result.year).toBe(2026)
    expect(result.season).toBeNull()
  })
})
