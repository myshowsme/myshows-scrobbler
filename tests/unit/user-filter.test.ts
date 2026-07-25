import { describe, it, expect } from 'vite-plus/test'
import { applyUserFilter, matchesUserFilter } from '../../src/adapters/user-filter.js'

describe('matchesUserFilter', () => {
  it('counts every viewer when the filter is empty', () => {
    expect(matchesUserFilter({ id: '1', name: 'JuFrolov' }, [])).toBe(true)
    expect(matchesUserFilter(undefined, [])).toBe(true)
  })

  it('treats whitespace-only entries as an empty filter', () => {
    expect(matchesUserFilter({ id: '2', name: 'Guest' }, ['  ', ''])).toBe(true)
  })

  it('matches by user id', () => {
    expect(matchesUserFilter({ id: '1', name: 'JuFrolov' }, ['1'])).toBe(true)
    expect(matchesUserFilter({ id: '2', name: 'Guest' }, ['1'])).toBe(false)
  })

  it('matches by user name', () => {
    expect(matchesUserFilter({ id: '1', name: 'JuFrolov' }, ['JuFrolov'])).toBe(true)
    expect(matchesUserFilter({ id: '1', name: 'JuFrolov' }, ['SomeoneElse'])).toBe(false)
  })

  it('matches case-insensitively and trims', () => {
    expect(matchesUserFilter({ id: '1', name: 'JuFrolov' }, ['  jufrolov '])).toBe(true)
  })

  it('drops sessions without a User object when a filter is set', () => {
    expect(matchesUserFilter(undefined, ['1'])).toBe(false)
  })

  it('matches if any of several entries fits', () => {
    expect(matchesUserFilter({ id: '5', name: 'Гость' }, ['JuFrolov', 'Гость'])).toBe(true)
    expect(matchesUserFilter({ id: '5', name: 'Other' }, ['JuFrolov', 'Гость'])).toBe(false)
  })

  it('does not match a partial id or name', () => {
    expect(matchesUserFilter({ id: '12', name: 'JuFrolovich' }, ['1'])).toBe(false)
    expect(matchesUserFilter({ id: '12', name: 'JuFrolovich' }, ['JuFrolov'])).toBe(false)
  })

  it('drops a viewer whose id and name are both absent when a filter is set', () => {
    expect(matchesUserFilter({}, ['1'])).toBe(false)
  })
})

describe('applyUserFilter', () => {
  const sessions = [
    { key: 'a', user: { id: 'u1', name: 'Alice' } },
    { key: 'b', user: { id: 'u2', name: 'Bob' } },
    { key: 'c', user: {} },
  ]
  const userOf = (s: (typeof sessions)[number]): { id?: string; name?: string } => s.user

  it('keeps everything and stays quiet without a filter', () => {
    const { admitted, droppedMessage } = applyUserFilter(sessions, userOf, [])

    expect(admitted).toHaveLength(3)
    expect(droppedMessage).toBeNull()
  })

  it('names the viewers it turned away so a typo is visible in the logs', () => {
    const { admitted, droppedMessage } = applyUserFilter(sessions, userOf, ['Alice'])

    expect(admitted.map((s) => s.key)).toEqual(['a'])
    expect(droppedMessage).toBe('user_filter dropped 2 session(s): Bob (u2), unknown')
  })

  it('labels a viewer known only by id', () => {
    const { droppedMessage } = applyUserFilter([{ user: { id: 'u9' } }], (s) => s.user, ['Alice'])

    expect(droppedMessage).toBe('user_filter dropped 1 session(s): u9')
  })
})
