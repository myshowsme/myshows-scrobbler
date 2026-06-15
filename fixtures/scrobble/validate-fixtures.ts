/**
 * Validation script — typecheck all fixture payloads against scrobble-dto.ts.
 * Run: npx tsx fixtures/scrobble/validate-fixtures.ts
 *
 * This file is NOT part of the build — it's a one-off dev tool.
 */

import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

const ROOT = import.meta.dirname

// ── Collect all JSON files recursively ─────────────────────────────────────

function collectJson(dir: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      results.push(...collectJson(full))
    } else if (entry.endsWith('.json')) {
      results.push(full)
    }
  }
  return results
}

// ── Type guards (runtime structural validation) ────────────────────────────

function hasIds(obj: unknown): obj is { ids: Record<string, unknown> } {
  return (
    typeof obj === 'object' && obj !== null && 'ids' in obj && typeof (obj as any).ids === 'object'
  )
}

function validateMovieRequest(p: unknown): string[] {
  const errors: string[] = []
  const o = p as any
  if (!o.movie) errors.push('missing "movie"')
  else if (!hasIds(o.movie)) errors.push('movie.ids missing or not object')
  if (typeof o.progress !== 'number' && o.progress !== undefined)
    errors.push(`progress should be number, got ${typeof o.progress}`)
  if (o.show) errors.push('movie request should not have "show"')
  // validate metadata enums if present
  if (o.movie?.metadata) {
    validateMetadata(o.movie.metadata, 'movie.metadata', errors)
  }
  return errors
}

function validateEpisodeRequest(p: unknown): string[] {
  const errors: string[] = []
  const o = p as any
  if (!o.episode) errors.push('missing "episode"')
  if (o.movie) errors.push('episode request should not have "movie"')
  // show is optional (Trakt allows episode-only with ids)
  if (o.show && !hasIds(o.show)) errors.push('show.ids missing or not object')
  if (o.episode?.metadata) {
    validateMetadata(o.episode.metadata, 'episode.metadata', errors)
  }
  return errors
}

function validateMovieResponse(p: unknown): string[] {
  const errors: string[] = []
  const o = p as any
  if (typeof o.id !== 'number') errors.push(`id should be number, got ${typeof o.id}`)
  if (!['start', 'pause', 'scrobble', 'checkin'].includes(o.action))
    errors.push(`invalid action: ${o.action}`)
  if (!o.movie) errors.push('missing "movie"')
  if (o.show) errors.push('movie response should not have "show"')
  return errors
}

function validateEpisodeResponse(p: unknown): string[] {
  const errors: string[] = []
  const o = p as any
  if (typeof o.id !== 'number') errors.push(`id should be number, got ${typeof o.id}`)
  if (!['start', 'pause', 'scrobble', 'checkin'].includes(o.action))
    errors.push(`invalid action: ${o.action}`)
  if (!o.episode) errors.push('missing "episode"')
  if (o.movie) errors.push('episode response should not have "movie"')
  return errors
}

function validateSyncHistoryRequest(p: unknown): string[] {
  const errors: string[] = []
  const o = p as any
  if (!o.movies && !o.shows && !o.episodes)
    errors.push('must have at least one of: movies, shows, episodes')
  if (o.movies && !Array.isArray(o.movies)) errors.push('movies must be array')
  if (o.shows && !Array.isArray(o.shows)) errors.push('shows must be array')
  return errors
}

function validateSyncHistoryResponse(p: unknown): string[] {
  const errors: string[] = []
  const o = p as any
  if (!o.added) errors.push('missing "added"')
  if (!o.not_found) errors.push('missing "not_found"')
  return errors
}

const VALID_MEDIA_TYPES = new Set([
  'digital',
  'bluray',
  'hddvd',
  'dvd',
  'vcd',
  'vhs',
  'betamax',
  'laserdisc',
])
const VALID_RESOLUTIONS = new Set([
  'uhd_4k',
  'hd_1080p',
  'hd_1080i',
  'hd_720p',
  'sd_480p',
  'sd_480i',
  'sd_576p',
  'sd_576i',
])
const VALID_HDR = new Set(['dolby_vision', 'hdr10', 'hdr10_plus', 'hlg'])
const VALID_AUDIO = new Set([
  'lpcm',
  'mp3',
  'mp2',
  'aac',
  'ogg',
  'ogg_opus',
  'wma',
  'flac',
  'dts',
  'dts_ma',
  'dts_hr',
  'dts_x',
  'auro_3d',
  'dolby_digital',
  'dolby_digital_plus',
  'dolby_digital_plus_atmos',
  'dolby_atmos',
  'dolby_truehd',
  'dolby_prologic',
])
const VALID_CHANNELS = new Set([
  '1.0',
  '2.0',
  '2.1',
  '3.0',
  '3.1',
  '4.0',
  '4.1',
  '5.0',
  '5.1',
  '5.1.2',
  '5.1.4',
  '6.1',
  '7.1',
  '7.1.2',
  '7.1.4',
  '9.1',
  '10.1',
])

function validateMetadata(m: any, prefix: string, errors: string[]) {
  if (m.media_type && !VALID_MEDIA_TYPES.has(m.media_type))
    errors.push(`${prefix}.media_type invalid: ${m.media_type}`)
  if (m.resolution && !VALID_RESOLUTIONS.has(m.resolution))
    errors.push(`${prefix}.resolution invalid: ${m.resolution}`)
  if (m.hdr && !VALID_HDR.has(m.hdr)) errors.push(`${prefix}.hdr invalid: ${m.hdr}`)
  if (m.audio && !VALID_AUDIO.has(m.audio)) errors.push(`${prefix}.audio invalid: ${m.audio}`)
  if (m.audio_channels && !VALID_CHANNELS.has(m.audio_channels))
    errors.push(`${prefix}.audio_channels invalid: ${m.audio_channels}`)
  if (m['3d'] !== undefined && typeof m['3d'] !== 'boolean')
    errors.push(`${prefix}.3d should be boolean`)
}

// ── Main ───────────────────────────────────────────────────────────────────

const files = collectJson(ROOT).filter((f) => !f.includes('validate'))
let passed = 0
let failed = 0

for (const file of files) {
  const rel = relative(ROOT, file)
  const raw = JSON.parse(readFileSync(file, 'utf-8'))
  const payload = raw.payload
  const name = raw._meta?.name ?? rel

  if (!payload) {
    console.error(`FAIL  ${rel} — no "payload" field`)
    failed++
    continue
  }

  let errors: string[] = []

  // Determine type from filename (not path)
  const filename = rel.split(/[\\/]/).pop()!
  if (rel.includes('sync-history')) {
    if (filename.startsWith('req')) errors = validateSyncHistoryRequest(payload)
    else errors = validateSyncHistoryResponse(payload)
  } else if (filename.startsWith('req') || rel.includes('requests')) {
    if (payload.movie) errors = validateMovieRequest(payload)
    else errors = validateEpisodeRequest(payload)
  } else {
    if (payload.movie && !payload.show) errors = validateMovieResponse(payload)
    else errors = validateEpisodeResponse(payload)
  }

  if (errors.length > 0) {
    console.error(`FAIL  ${rel} — ${name}`)
    errors.forEach((e) => console.error(`      ↳ ${e}`))
    failed++
  } else {
    console.log(`  OK  ${rel}`)
    passed++
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${files.length} total`)
process.exit(failed > 0 ? 1 : 0)
