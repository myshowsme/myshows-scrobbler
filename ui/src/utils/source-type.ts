import { LOCAL_SOURCE_TYPES, type SourceType } from '../types'

/**
 * Source types that don't take a URL or token — they auto-detect the playback
 * on the host OS (e.g. the process-scanning `player` adapter). UI uses this to
 * hide credentials fields, skip the url/token check before connectivity probes,
 * and consider such sources "configured" purely on `enabled = true`.
 *
 * Mirrors the same predicate in src/types.ts; kept here as a UI-side helper so
 * components don't import server-only modules.
 */
export function isLocalSource(type: SourceType): boolean {
  return (LOCAL_SOURCE_TYPES as readonly SourceType[]).includes(type)
}
