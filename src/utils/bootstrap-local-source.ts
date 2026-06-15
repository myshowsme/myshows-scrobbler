import { readConfig, writeConfig, DEFAULT_SOURCE_POLL_INTERVAL } from '../config.js'
import type { Logger } from '../logger.js'
import type { SourceType } from '../types.js'
import { isLoopbackUrl, resolveBootstrapUrl } from './url.js'

/** What a per-source discovery (Plex, Kodi) returns: a token or a failure. */
export interface DiscoveryResult {
  /** null = failure; '' = success with no auth needed (Kodi without password). */
  token: string | null
  /** Where the credentials were found, for log lines. */
  source?: string
}

export interface BootstrapPolicy<R extends DiscoveryResult> {
  type: SourceType
  /** Reads the local player config off disk. Must not throw. */
  discover: () => Promise<R>
  /** URL a newly created source row points at. */
  defaultUrl: (result: R) => string
  /**
   * Set when the token only works against one local install (Kodi's HTTP
   * Basic). Bootstrap then bails if the user's URL points somewhere else.
   * Plex tokens are account-wide and pair with any URL.
   */
  requireLoopback: boolean
  /** Name used in log lines. */
  label: string
}

/**
 * Startup hook that fills a source config from a local player's on-disk
 * config. Adds a new enabled row when none exists, fills an empty token on
 * an enabled row, and otherwise leaves the user's config alone (disabled
 * row, token already set, or a remote URL with requireLoopback). Discovery
 * failures are ignored; bootstrap is best-effort.
 */
export async function bootstrapLocalSource<R extends DiscoveryResult>(
  policy: BootstrapPolicy<R>,
  logger: Logger,
): Promise<void> {
  const result = await policy.discover()
  if (result.token === null) {
    return
  }

  const config = readConfig()
  const existing = config.sources.find((s) => s.type === policy.type)
  const defaultUrl = policy.defaultUrl(result)

  if (existing) {
    if (!existing.enabled) {
      return
    }
    const tokenMissing = existing.token.trim().length === 0
    const normalizedUrl = resolveBootstrapUrl(existing.url, defaultUrl)
    if (!tokenMissing && normalizedUrl === existing.url) {
      return
    }
    if (
      tokenMissing &&
      policy.requireLoopback &&
      existing.url.trim().length > 0 &&
      !isLoopbackUrl(normalizedUrl)
    ) {
      return
    }
    const updated = config.sources.map((s) =>
      s.type === policy.type
        ? {
            ...s,
            token: tokenMissing ? (result.token as string) : s.token,
            url: normalizedUrl,
          }
        : s,
    )
    writeConfig({ ...config, sources: updated })
    logger.info(`${policy.label}: auto-filled credentials (${result.source})`)
    return
  }

  writeConfig({
    ...config,
    sources: [
      ...config.sources,
      {
        type: policy.type,
        enabled: true,
        url: defaultUrl,
        token: result.token,
        pollInterval: DEFAULT_SOURCE_POLL_INTERVAL,
        userFilter: [],
      },
    ],
  })
  logger.info(`${policy.label}: added source (${result.source})`)
}
