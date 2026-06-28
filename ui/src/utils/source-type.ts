import { LOCAL_SOURCE_TYPES, TOKEN_ONLY_SOURCE_TYPES, type SourceType } from '../types'

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

/**
 * Remote sources that need only a token and a fixed endpoint (e.g. Stremio →
 * api.strem.io), so the UI hides the URL field. Mirrors `isTokenOnlySource` in
 * src/types.ts.
 */
export function isTokenOnlySource(type: SourceType): boolean {
  return (TOKEN_ONLY_SOURCE_TYPES as readonly SourceType[]).includes(type)
}

/**
 * Whether a source needs a user-entered URL. Mirrors `sourceNeedsUrl` in
 * src/types.ts (duplicated so UI components don't import server modules).
 */
export function sourceNeedsUrl(type: SourceType): boolean {
  return !isLocalSource(type) && !isTokenOnlySource(type)
}

/**
 * True when a source has the credentials needed to run a connectivity probe:
 * local sources need nothing, token-only sources (Stremio) need just the token,
 * everything else needs both a URL and a token.
 */
export function hasProbeCredentials(type: SourceType, url: string, token: string): boolean {
  if (isLocalSource(type)) {
    return true
  }
  if (!sourceNeedsUrl(type)) {
    return Boolean(token)
  }
  return Boolean(url && token)
}
