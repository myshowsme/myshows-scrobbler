import { describe, it, expect, beforeEach } from 'vite-plus/test'
import { extractDubTeam, clearDubTeamCache } from './dub-team.js'

describe('extractDubTeam', () => {
  beforeEach(() => {
    clearDubTeamCache()
  })

  it('extracts bracketed release group', () => {
    expect(extractDubTeam('[AniDUB] Frieren - S01E01 [1080p].mkv')).toBe('AniDUB')
  })

  it('extracts trailing release group after encoder', () => {
    expect(extractDubTeam('Blade.Runner.2049.2017.2160p.UHD.BluRay.x265.TEPES.mkv')).toBe('TEPES')
  })

  it('returns release group verbatim without normalisation', () => {
    expect(extractDubTeam('[anidub] Frieren.mkv')).toBe('anidub')
    expect(extractDubTeam('[AniDub] Some Show - 01.mkv')).toBe('AniDub')
  })

  it('returns whatever guessit detects as release group', () => {
    expect(extractDubTeam('Some.Show.S01E01.1080p.WEB.x264.UnknownGroup.mkv')).toBe('UnknownGroup')
  })

  it('returns null when guessit finds no release group', () => {
    expect(extractDubTeam('Show.S01E01.KorsarNox.1080p.mkv')).toBe(null)
    expect(extractDubTeam('Show.S01E01.SubsPleaseUnofficial.1080p.mkv')).toBe(null)
    expect(extractDubTeam('Movie.2024.TEPES.1080p.mkv')).toBe(null)
  })

  it('returns null for empty input', () => {
    expect(extractDubTeam(null)).toBe(null)
    expect(extractDubTeam(undefined)).toBe(null)
    expect(extractDubTeam('/path/to/')).toBe(null)
  })

  it('handles Windows paths', () => {
    expect(extractDubTeam('C:\\media\\Frieren\\[AniDUB] Frieren - E01.mkv')).toBe('AniDUB')
  })

  it('handles deep nested paths', () => {
    expect(extractDubTeam('/mnt/tv/Anime/Frieren/Season 1/[AniDUB] Frieren - 01 [1080p].mkv')).toBe(
      'AniDUB',
    )
  })

  it('caches results per file path', () => {
    const path = '[AniDUB] Frieren - S01E01 [1080p].mkv'
    expect(extractDubTeam(path)).toBe('AniDUB')
    expect(extractDubTeam(path)).toBe('AniDUB')
  })

  it('caches null results', () => {
    const path = 'Show.S01E01.KorsarNox.1080p.mkv'
    expect(extractDubTeam(path)).toBe(null)
    expect(extractDubTeam(path)).toBe(null)
  })
})
