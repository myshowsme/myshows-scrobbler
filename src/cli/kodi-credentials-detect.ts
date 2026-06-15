import type { AppConfig } from '../types.js'
import { discoverKodiCredentialsOnce } from '../utils/kodi-credentials-discovery.js'
import type { CliArgs } from './args.js'

/**
 * Kodi counterpart of maybeAutoDetectPlexToken: when Kodi is enabled but
 * has no token, read credentials from the local guisettings.xml and inject
 * them (plus the discovered port, when the user typed no URL) into
 * args.sourceOverrides. In-memory only, nothing is persisted.
 */
export async function maybeAutoDetectKodiCredentials(
  mergedConfig: AppConfig,
  args: CliArgs,
): Promise<void> {
  const kodi = mergedConfig.sources.find((s) => s.type === 'kodi')
  if (!kodi || !kodi.enabled || kodi.token.trim().length > 0) {
    return
  }

  const result = await discoverKodiCredentialsOnce()
  if (result.token !== null) {
    const overrides = args.sourceOverrides.kodi ?? {}
    args.sourceOverrides.kodi = {
      ...overrides,
      token: result.token,
      // Fill the URL only when the user hasn't set one
      ...(kodi.url.trim().length === 0 && result.port
        ? { url: `http://127.0.0.1:${result.port}` }
        : {}),
    }
    console.log(`kodi: auto-detected credentials from local guisettings.xml (${result.source})`)
    return
  }

  console.warn(`kodi: no credentials configured and ${describeKodiReason(result.reason)}`)
  console.warn(
    'kodi: enable the web interface (Settings → Services → Control) or set the token via the UI',
  )
}

function describeKodiReason(reason: string | undefined): string {
  switch (reason) {
    case 'kodi-not-installed':
      return 'no Kodi guisettings.xml found locally'
    case 'permission-denied':
      return "Kodi's guisettings.xml is unreadable"
    case 'webserver-disabled':
      return "Kodi's web interface is turned off"
    case 'parse-error':
      return "Kodi's guisettings.xml could not be parsed"
    default:
      return 'auto-detection from local Kodi failed'
  }
}
