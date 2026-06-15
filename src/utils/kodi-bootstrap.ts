import type { Logger } from '../logger.js'
import { bootstrapLocalSource } from './bootstrap-local-source.js'
import { discoverKodiCredentialsOnce } from './kodi-credentials-discovery.js'

/**
 * Kodi counterpart of bootstrapPlexFromLocal. Kodi credentials are HTTP
 * Basic for one specific install, so we require a loopback URL instead of
 * pairing local creds with a remote server. An empty token is still a valid
 * discovery (Kodi running without auth).
 */
export function bootstrapKodiFromLocal(logger: Logger): Promise<void> {
  return bootstrapLocalSource(
    {
      type: 'kodi',
      discover: discoverKodiCredentialsOnce,
      defaultUrl: (result) => `http://127.0.0.1:${result.port ?? 8080}`,
      requireLoopback: true,
      label: 'Kodi',
    },
    logger,
  )
}
