import fs from 'node:fs'
import path from 'node:path'
import { getConfigPath } from '../config.js'
import type { ExternalIds } from '../types.js'

/**
 * Opt-in capture of what a Plex server actually sends, written next to `config.json`.
 *
 * Exists because libraries built on retired metadata agents differ from server to server
 * in ways the API docs do not describe, and the people who have such libraries are not
 * the people who can run a debugger. Enabling `"diagnostics": true` on the Plex source
 * produces one block per title that answers, in a single paste-able file, which GUID
 * fields arrived, how they parsed, and whether the numbers we send can be trusted.
 */

/** GUIDs from one Plex endpoint, exactly as they arrived — before any normalisation. */
export interface GuidSnapshot {
  /** Which request these came from, e.g. `session` or `/library/metadata/60291`. */
  source: string
  Guid: string[]
  guid?: string
  parentGuid?: string
  grandparentGuid?: string
}

export interface PlexDiagnosticReport {
  /** Dedup key — one block per title per run, so a 40-minute episode logs once. */
  key: string
  type: 'movie' | 'episode'
  title: string
  showTitle: string | null
  season: number | null
  episode: number | null
  year: number | null
  /** Basename only: the directory reveals the person's disk layout and adds nothing. */
  file: string | null
  snapshots: GuidSnapshot[]
  ids: ExternalIds
  episodeIds: ExternalIds
}

const HAMA_MODE = /com\.plexapp\.agents\.hama:\/\/([a-z]+)(\d*)-/i

/**
 * HAMA encodes its *numbering mode* in the digit suffix, and only some modes leave the
 * season/episode numbers Plex reports aligned with the id we send alongside them.
 * Descriptions from the Absolute Series Scanner docs
 * (https://github.com/ZeroQI/Absolute-Series-Scanner).
 */
const HAMA_MODE_NOTES: Record<string, string> = {
  tvdb: 'TVDB season/episode numbering — aligned with the tvdb id',
  tvdb2: 'absolute numbering displayed as TVDB seasons — aligned',
  tvdb3: 'absolute numbering displayed as TVDB seasons — aligned',
  tvdb4: 'SEASONS ARE STORY ARCS — season/episode probably NOT aligned with TVDB',
  tvdb5: 'SEASONS REMOVED, absolute order — season/episode probably NOT aligned with TVDB',
  anidb: 'AniDB numbering — aligned with the anidb id',
  anidb2: 'AniDB id but TVDB season/episode numbering — id and numbers disagree',
  anidb3: 'AniDB id but TVDB season/episode numbering — id and numbers disagree',
  anidb4: 'AniDB id but TVDB season/episode numbering — id and numbers disagree',
}

/** Human-readable HAMA mode, or null when the GUID is not a HAMA one. */
export function describeHamaMode(guid: string | undefined): string | null {
  if (!guid) {
    return null
  }
  const match = HAMA_MODE.exec(guid)
  if (!match) {
    return null
  }
  const mode = `${match[1]?.toLowerCase() ?? ''}${match[2] ?? ''}`
  return `${mode} — ${HAMA_MODE_NOTES[mode] ?? 'UNKNOWN MODE, please report this line'}`
}

/**
 * The Absolute Series Scanner naming convention leaves the id in the folder name, so the
 * show title arrives as `Mushoku Tensei: Jobless Reincarnation [tvdb-371310]`. We forward
 * the title verbatim, so the suffix reaches MyShows and hurts any title-based matching.
 */
const TITLE_ID_SUFFIX = /\s*\[(?:tvdb|anidb|tmdb|imdb)\d*-[^\]]+\]\s*$/i

export function titleIdSuffix(title: string | null | undefined): string | null {
  const match = title ? TITLE_ID_SUFFIX.exec(title) : null
  return match ? match[0].trim() : null
}

function formatSnapshot(snapshot: GuidSnapshot): string[] {
  const lines = [`  [${snapshot.source}]`]
  lines.push(
    `    Guid[]          : ${snapshot.Guid.length ? snapshot.Guid.join(', ') : '(absent)'}`,
  )
  for (const field of ['guid', 'parentGuid', 'grandparentGuid'] as const) {
    lines.push(`    ${field.padEnd(16)}: ${snapshot[field] ?? '(absent)'}`)
  }
  for (const value of [snapshot.guid, snapshot.grandparentGuid]) {
    const mode = describeHamaMode(value)
    if (mode) {
      lines.push(`    HAMA mode       : ${mode}`)
    }
  }
  return lines
}

export function formatReport(report: PlexDiagnosticReport, now = new Date()): string {
  const lines: string[] = []
  lines.push(`=== ${now.toISOString()} — ${report.type} — ${report.key} ===`)
  lines.push(`  title           : ${report.title}`)
  if (report.type === 'episode') {
    lines.push(`  show            : ${report.showTitle ?? '(absent)'}`)
    lines.push(`  season/episode  : S${report.season ?? '?'}E${report.episode ?? '?'}`)
  } else {
    lines.push(`  year            : ${report.year ?? '(absent)'}`)
  }
  lines.push(`  file            : ${report.file ?? '(absent)'}`)

  const suffix = titleIdSuffix(report.showTitle ?? report.title)
  if (suffix) {
    lines.push(`  title suffix    : ${suffix} — scanner id leaking into the title`)
  }

  for (const snapshot of report.snapshots) {
    lines.push(...formatSnapshot(snapshot))
  }

  lines.push(`  parsed show ids : ${JSON.stringify(report.ids)}`)
  lines.push(`  parsed ep ids   : ${JSON.stringify(report.episodeIds)}`)
  if (Object.keys(report.ids).length === 0) {
    lines.push('  RESULT          : no external id — this title will match by name only')
  }
  return lines.join('\n')
}

/** Sits next to `config.json`, so "send me the file" needs no path hunting. */
export function defaultDiagnosticsPath(): string {
  return path.join(path.dirname(getConfigPath()), 'plex-diagnostics.log')
}

export class PlexDiagnostics {
  private readonly seen = new Set<string>()
  private failed = false

  constructor(
    private readonly filePath: string,
    private readonly log: (message: string) => void,
  ) {}

  /** Writes one block per key. Never throws: diagnostics must not break scrobbling. */
  record(report: PlexDiagnosticReport): void {
    if (this.seen.has(report.key) || this.failed) {
      return
    }
    this.seen.add(report.key)

    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.appendFileSync(this.filePath, `${formatReport(report)}\n\n`, 'utf8')
    } catch (err) {
      // Report once, then stay quiet rather than logging on every title.
      this.failed = true
      this.log(`Could not write diagnostics to ${this.filePath}: ${(err as Error).message}`)
    }
  }
}
