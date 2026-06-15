import type { SourceType } from '../types.js'
import { JellyfinAdapter, type JellyfinItem, type JellyfinSession } from './jellyfin.js'
import { fetchWithTimeout } from '../http.js'

export class EmbyAdapter extends JellyfinAdapter {
  override get name(): SourceType {
    return 'emby'
  }

  protected override getHeaders(): Record<string, string> {
    return {
      'X-Emby-Token': this.config.token,
      'Accept': 'application/json',
    }
  }

  protected override async fetchSessions(): Promise<JellyfinSession[]> {
    const url = `${this.config.url}/Sessions?ActiveWithinSeconds=60`
    const response = await fetchWithTimeout(url, { headers: this.getHeaders() })

    if (!response.ok) {
      throw new Error(`Emby API error: ${response.status}`)
    }

    const sessions = (await response.json()) as Array<
      JellyfinSession & { NowPlayingItem?: JellyfinItem }
    >
    return sessions.filter((s) => s.NowPlayingItem)
  }
}
