import { ref, type Ref } from 'vue'
import {
  fetchKodiAutoCredentials,
  fetchPlexAutoToken,
  type KodiCredentialsAutoDiscovery,
  type PlexTokenAutoDiscovery,
} from '../api'
import type { SourceConfig, SourceType } from '../types'

/** UI feedback state for the manual "Find token" button per source row. */
export interface TokenLookupState {
  status: 'idle' | 'looking' | 'found' | 'failed'
  /** Discovery reason when status === 'failed'. */
  reason?: PlexTokenAutoDiscovery['reason'] | KodiCredentialsAutoDiscovery['reason']
}

/** Pre-filled when the user enables Plex or runs "Find token" with no URL. */
const DEFAULT_PLEX_URL = 'http://127.0.0.1:32400'

export interface TokenLookupDeps {
  sources: Ref<SourceConfig[]>
  patchSource: (
    type: SourceType,
    patch: Partial<Pick<SourceConfig, 'enabled' | 'url' | 'token'>>,
    debounce?: boolean,
  ) => void
}

/**
 * "Find token" flow for sources whose credentials can be read from local
 * player config (Plex Preferences.xml, Kodi guisettings.xml). Tracks a
 * per-source TokenLookupState for the UI; the find-* methods return true
 * when something was patched so AppShell can probe the connection.
 */
export function useTokenLookup({ sources, patchSource }: TokenLookupDeps) {
  const tokenLookup = ref<Partial<Record<SourceType, TokenLookupState>>>({})

  /**
   * Fill a missing or scheme-less URL with the discovery default. Never
   * overwrites a URL the user actually typed.
   */
  function fillMissingUrl(
    type: SourceType,
    defaultUrl: string,
    patch: Partial<Pick<SourceConfig, 'token' | 'url'>>,
  ): void {
    const current = sources.value.find((s) => s.type === type)
    const url = (current?.url ?? '').trim()
    if (!url) {
      patch.url = defaultUrl
      return
    }
    if (!/^https?:\/\//i.test(url)) {
      patch.url = `http://${url}`
    }
  }

  async function findPlexToken(): Promise<boolean> {
    tokenLookup.value = { ...tokenLookup.value, plex: { status: 'looking' } }
    // Pre-fill the local PMS URL even when token discovery fails: the user
    // asked to set Plex up, so let them finish by hand from the default URL.
    const patch: Partial<Pick<SourceConfig, 'token' | 'url'>> = {}
    fillMissingUrl('plex', DEFAULT_PLEX_URL, patch)
    try {
      const result = await fetchPlexAutoToken()
      if (result.token) {
        patch.token = result.token
        patchSource('plex', patch)
        tokenLookup.value = { ...tokenLookup.value, plex: { status: 'found' } }
        return true
      }
      if (patch.url) {
        patchSource('plex', patch)
      }
      tokenLookup.value = {
        ...tokenLookup.value,
        plex: { status: 'failed', reason: result.reason },
      }
    } catch {
      if (patch.url) {
        patchSource('plex', patch)
      }
      tokenLookup.value = { ...tokenLookup.value, plex: { status: 'failed' } }
    }
    return false
  }

  async function findKodiCredentials(): Promise<boolean> {
    tokenLookup.value = { ...tokenLookup.value, kodi: { status: 'looking' } }
    try {
      const result = await fetchKodiAutoCredentials()
      if (result.token !== null) {
        const patch: Partial<Pick<SourceConfig, 'token' | 'url'>> = { token: result.token }
        fillMissingUrl('kodi', `http://127.0.0.1:${result.port ?? 8080}`, patch)
        patchSource('kodi', patch)
        tokenLookup.value = { ...tokenLookup.value, kodi: { status: 'found' } }
        return true
      }
      tokenLookup.value = {
        ...tokenLookup.value,
        kodi: { status: 'failed', reason: result.reason },
      }
    } catch {
      tokenLookup.value = { ...tokenLookup.value, kodi: { status: 'failed' } }
    }
    return false
  }

  return {
    tokenLookup,
    findPlexToken,
    findKodiCredentials,
  }
}
