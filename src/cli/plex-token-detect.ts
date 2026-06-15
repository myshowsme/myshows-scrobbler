import type { AppConfig } from '../types.js'
import { discoverPlexTokenOnce } from '../utils/plex-token-discovery.js'
import type { CliArgs } from './args.js'

/**
 * CLI counterpart of the server bootstrap: when Plex is enabled but has no
 * token, read one from the local PMS config and inject it into
 * args.sourceOverrides. In-memory only, like the rest of the CLI overrides;
 * nothing is persisted. Prints a hint when discovery fails.
 */
export async function maybeAutoDetectPlexToken(
  mergedConfig: AppConfig,
  args: CliArgs,
): Promise<void> {
  const plex = mergedConfig.sources.find((s) => s.type === 'plex')
  if (!plex || !plex.enabled || plex.token.trim().length > 0) {
    return
  }

  const result = await discoverPlexTokenOnce()
  if (result.token) {
    const overrides = args.sourceOverrides.plex ?? {}
    args.sourceOverrides.plex = { ...overrides, token: result.token }
    console.log(`plex: auto-detected token from local Plex Media Server (${result.source})`)
    return
  }

  console.warn(`plex: no token configured and ${describePlexReason(result.reason)}`)
  console.warn('plex: set the token via the UI (toggle Plex on) or by editing data/config.json')
}

function describePlexReason(reason: string | undefined): string {
  switch (reason) {
    case 'pms-not-installed':
      return 'no Plex Media Server config found locally (native, Docker bind-mount or NAS)'
    case 'permission-denied':
      return "Plex Media Server's Preferences.xml is unreadable (Linux pkg install? try sudo)"
    case 'not-signed-in':
      return "the local Plex Media Server hasn't signed in to plex.tv yet"
    case 'parse-error':
      return "the local Plex Media Server's Preferences.xml could not be parsed"
    default:
      return 'auto-detection from a local Plex Media Server failed'
  }
}
