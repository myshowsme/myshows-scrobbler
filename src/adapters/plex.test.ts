import { describe, it, expect } from 'vite-plus/test'
import { matchesUserFilter } from './plex.js'

describe('matchesUserFilter', () => {
  it('counts every viewer when the filter is empty', () => {
    expect(matchesUserFilter({ id: '1', title: 'JuFrolov' }, [])).toBe(true)
    expect(matchesUserFilter(undefined, [])).toBe(true)
  })

  it('treats whitespace-only entries as an empty filter', () => {
    expect(matchesUserFilter({ id: '2', title: 'Guest' }, ['  ', ''])).toBe(true)
  })

  it('matches by user id', () => {
    expect(matchesUserFilter({ id: '1', title: 'JuFrolov' }, ['1'])).toBe(true)
    expect(matchesUserFilter({ id: '2', title: 'Guest' }, ['1'])).toBe(false)
  })

  it('matches by user title', () => {
    expect(matchesUserFilter({ id: '1', title: 'JuFrolov' }, ['JuFrolov'])).toBe(true)
    expect(matchesUserFilter({ id: '1', title: 'JuFrolov' }, ['SomeoneElse'])).toBe(false)
  })

  it('matches case-insensitively and trims', () => {
    expect(matchesUserFilter({ id: '1', title: 'JuFrolov' }, ['  jufrolov '])).toBe(true)
  })

  it('drops sessions without a User object when a filter is set', () => {
    expect(matchesUserFilter(undefined, ['1'])).toBe(false)
  })

  it('matches if any of several entries fits', () => {
    expect(matchesUserFilter({ id: '5', title: 'Гость' }, ['JuFrolov', 'Гость'])).toBe(true)
    expect(matchesUserFilter({ id: '5', title: 'Other' }, ['JuFrolov', 'Гость'])).toBe(false)
  })

  it('does not match a partial id or title', () => {
    expect(matchesUserFilter({ id: '12', title: 'JuFrolovich' }, ['1'])).toBe(false)
    expect(matchesUserFilter({ id: '12', title: 'JuFrolovich' }, ['JuFrolov'])).toBe(false)
  })
})
