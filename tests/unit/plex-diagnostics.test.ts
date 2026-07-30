import { describe, expect, it } from 'vite-plus/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PlexDiagnostics,
  describeHamaMode,
  formatReport,
  titleIdSuffix,
  type PlexDiagnosticReport,
} from '../../src/adapters/plex-diagnostics.js'

const hamaEpisode: PlexDiagnosticReport = {
  key: '60293',
  type: 'episode',
  title: 'Episode 1',
  showTitle: 'Mushoku Tensei: Jobless Reincarnation [tvdb-371310]',
  season: 3,
  episode: 1,
  year: null,
  file: '[MiniMTBB] Mushoku Tensei S3 - 01 (WEB 1080p) [6DF5CADB].mkv',
  snapshots: [
    {
      source: 'session (/status/sessions)',
      Guid: [],
      guid: 'local://60293',
      parentGuid: 'local://60292',
      grandparentGuid: 'com.plexapp.agents.hama://tvdb-371310?lang=en',
    },
  ],
  ids: { tvdb: '371310' },
  episodeIds: {},
}

describe('HAMA numbering modes', () => {
  it('separates modes whose numbering matches the id from those that do not', () => {
    for (const safe of ['tvdb', 'tvdb2', 'tvdb3', 'anidb']) {
      expect(describeHamaMode(`com.plexapp.agents.hama://${safe}-315500`)).toContain('aligned')
    }
    // tvdb4 numbers seasons by story arc, tvdb5 drops seasons entirely.
    for (const unsafe of ['tvdb4', 'tvdb5']) {
      expect(describeHamaMode(`com.plexapp.agents.hama://${unsafe}-315500`)).toContain(
        'NOT aligned',
      )
    }
    // anidb2..4 keep an AniDB id but renumber episodes the TVDB way.
    for (const mixed of ['anidb2', 'anidb3', 'anidb4']) {
      expect(describeHamaMode(`com.plexapp.agents.hama://${mixed}-11905`)).toContain('disagree')
    }
  })

  it('asks for a report when it meets a mode it does not know', () => {
    expect(describeHamaMode('com.plexapp.agents.hama://tvdb9-1')).toContain('UNKNOWN MODE')
  })

  it('stays out of the way for non-HAMA GUIDs', () => {
    expect(describeHamaMode('com.plexapp.agents.thetvdb://468006?lang=en')).toBeNull()
    expect(describeHamaMode('tvdb://456')).toBeNull()
    expect(describeHamaMode(undefined)).toBeNull()
  })
})

describe('scanner id leaking into the show title', () => {
  it('spots the Absolute Series Scanner suffix', () => {
    expect(titleIdSuffix('Mushoku Tensei: Jobless Reincarnation [tvdb-371310]')).toBe(
      '[tvdb-371310]',
    )
    expect(titleIdSuffix('Some Anime [anidb2-11905]')).toBe('[anidb2-11905]')
  })

  it('leaves ordinary titles alone', () => {
    expect(titleIdSuffix('Breaking Bad')).toBeNull()
    // Brackets that are part of the name must not be mistaken for the convention.
    expect(titleIdSuffix('Blade Runner [Final Cut]')).toBeNull()
    expect(titleIdSuffix(null)).toBeNull()
  })
})

describe('diagnostic report', () => {
  it('shows the raw fields, the detected mode and the parsed result together', () => {
    const report = formatReport(hamaEpisode, new Date('2026-07-28T12:00:00.000Z'))

    // Raw, so we can see what the server actually sent…
    expect(report).toContain('guid            : local://60293')
    expect(report).toContain('grandparentGuid : com.plexapp.agents.hama://tvdb-371310?lang=en')
    // …the numbering caveat…
    expect(report).toContain('HAMA mode       : tvdb —')
    // …the title problem…
    expect(report).toContain('[tvdb-371310] — scanner id leaking into the title')
    // …and what we made of it.
    expect(report).toContain('parsed show ids : {"tvdb":"371310"}')
    expect(report).toContain('S3E1')
  })

  it('says plainly when nothing could be identified', () => {
    const report = formatReport({ ...hamaEpisode, ids: {} })
    expect(report).toContain('no external id — this title will match by name only')
  })
})

describe('diagnostics writer', () => {
  it('writes one block per title and keeps quiet on repeats', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-diag-'))
    const file = path.join(dir, 'nested', 'plex-diagnostics.log')
    const warnings: string[] = []
    const diagnostics = new PlexDiagnostics(file, (message) => warnings.push(message))

    diagnostics.record(hamaEpisode)
    // Same title again — a 40-minute episode polls hundreds of times.
    diagnostics.record(hamaEpisode)
    diagnostics.record({ ...hamaEpisode, key: '60294', title: 'Episode 2' })

    const written = fs.readFileSync(file, 'utf8')
    expect(written.match(/^=== /gm)).toHaveLength(2)
    expect(written).toContain('Episode 2')
    expect(warnings).toEqual([])

    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reports a write failure once instead of on every title', () => {
    // A path under a file (not a directory) cannot be created.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-diag-'))
    const blocker = path.join(dir, 'blocker')
    fs.writeFileSync(blocker, 'not a directory')
    const warnings: string[] = []
    const diagnostics = new PlexDiagnostics(path.join(blocker, 'out.log'), (message) =>
      warnings.push(message),
    )

    diagnostics.record(hamaEpisode)
    diagnostics.record({ ...hamaEpisode, key: '60294' })

    expect(warnings).toHaveLength(1)

    fs.rmSync(dir, { recursive: true, force: true })
  })
})
