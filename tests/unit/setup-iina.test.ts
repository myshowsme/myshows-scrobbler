import { describe, it, expect } from 'vite-plus/test'
import {
  parseUserOptions,
  getOption,
  upsertOption,
  removeOption,
} from '../../src/setup/helpers/iina-prefs.js'

describe('iina-prefs helpers', () => {
  it('parseUserOptions keeps valid [key, value] pairs and drops junk', () => {
    expect(
      parseUserOptions([
        ['a', '1'],
        ['b', '2'],
      ]),
    ).toEqual([
      ['a', '1'],
      ['b', '2'],
    ])
    // longer entries truncate to the first two; malformed entries are dropped
    expect(parseUserOptions([['a', '1', 'x'], ['only'], 'str', 5])).toEqual([['a', '1']])
    expect(parseUserOptions(undefined)).toEqual([])
    expect(parseUserOptions(null)).toEqual([])
    expect(parseUserOptions({})).toEqual([])
  })

  it('getOption returns the value or null', () => {
    expect(getOption([['input-ipc-server', '/tmp/x.sock']], 'input-ipc-server')).toBe('/tmp/x.sock')
    expect(getOption([['a', '1']], 'missing')).toBeNull()
    expect(getOption([], 'a')).toBeNull()
  })

  it('upsertOption replaces an existing key and appends a new one', () => {
    expect(upsertOption([['a', '1']], 'a', '2')).toEqual([['a', '2']])
    expect(upsertOption([['a', '1']], 'b', '2')).toEqual([
      ['a', '1'],
      ['b', '2'],
    ])
    // upsert preserves order of untouched entries, moves the updated key to end
    expect(
      upsertOption(
        [
          ['a', '1'],
          ['b', '2'],
        ],
        'a',
        '9',
      ),
    ).toEqual([
      ['b', '2'],
      ['a', '9'],
    ])
  })

  it('removeOption drops only the matching key', () => {
    expect(
      removeOption(
        [
          ['a', '1'],
          ['b', '2'],
        ],
        'a',
      ),
    ).toEqual([['b', '2']])
    expect(removeOption([['a', '1']], 'missing')).toEqual([['a', '1']])
  })
})
