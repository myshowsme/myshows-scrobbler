import type { Logger } from '../logger.js'
import { bootstrapLocalSource } from './bootstrap-local-source.js'
import { discoverPlexTokenOnce } from './plex-token-discovery.js'

const PLEX_DEFAULT_URL = 'http://127.0.0.1:32400'

/**
 * On startup, fill in a Plex source from a local PMS install. The discovered
 * PlexOnlineToken is the user's plex.tv account token and works against any
 * of their servers, so the existing URL doesn't have to be loopback.
 * No opt-out flag for now; add one if anyone who deliberately removed Plex
 * complains about it coming back.
 */
export function bootstrapPlexFromLocal(logger: Logger): Promise<void> {
  return bootstrapLocalSource(
    {
      type: 'plex',
      discover: discoverPlexTokenOnce,
      defaultUrl: () => PLEX_DEFAULT_URL,
      requireLoopback: false,
      label: 'Plex',
    },
    logger,
  )
}
