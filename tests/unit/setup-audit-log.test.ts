import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setAuditLogPath, appendAudit, readAuditEntries } from '../../src/setup/audit-log.js'

let tmpDir: string
let logFile: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scrobbler-audit-'))
  logFile = path.join(tmpDir, 'setup-audit.log')
  setAuditLogPath(logFile)
})

afterEach(async () => {
  setAuditLogPath(null)
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('audit-log', () => {
  it('returns [] when the log does not exist yet', async () => {
    expect(await readAuditEntries()).toEqual([])
  })

  it('appends entries and reads them newest-first', async () => {
    await appendAudit({
      timestamp: '2026-05-28T08:00:00.000Z',
      actionId: 'a',
      player: 'mpc',
      event: 'apply',
    })
    await appendAudit({
      timestamp: '2026-05-28T09:00:00.000Z',
      actionId: 'a',
      player: 'mpc',
      event: 'verify-ok',
    })
    const entries = await readAuditEntries()
    expect(entries).toHaveLength(2)
    expect(entries[0].event).toBe('verify-ok')
    expect(entries[1].event).toBe('apply')
  })

  it('skips malformed lines without throwing', async () => {
    await fs.writeFile(
      logFile,
      [
        '{"timestamp":"2026-05-28T08:00:00.000Z","actionId":"a","player":"mpc","event":"apply"}',
        'this is not json',
        '{"timestamp":"2026-05-28T09:00:00.000Z","actionId":"a","player":"mpc","event":"restore"}',
      ].join('\n') + '\n',
      'utf8',
    )
    const entries = await readAuditEntries()
    expect(entries.map((e) => e.event)).toEqual(['restore', 'apply'])
  })

  it('honours the limit parameter', async () => {
    for (let i = 0; i < 5; i += 1) {
      await appendAudit({
        timestamp: `2026-05-28T0${i}:00:00.000Z`,
        actionId: 'a',
        player: 'mpc',
        event: 'apply',
      })
    }
    const entries = await readAuditEntries(2)
    expect(entries).toHaveLength(2)
    // Tail of the file → newest-first reverse → 04 then 03.
    expect(entries[0].timestamp).toBe('2026-05-28T04:00:00.000Z')
    expect(entries[1].timestamp).toBe('2026-05-28T03:00:00.000Z')
  })
})
