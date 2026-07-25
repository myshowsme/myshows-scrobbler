import type { SourceType } from '../types.js'
import { JellyfinAdapter } from './jellyfin.js'

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

  /** Emby keeps stale sessions in the list, so ask only for recently-active ones. */
  protected override sessionsUrl(): string {
    return `${this.config.url}/Sessions?ActiveWithinSeconds=60`
  }
}
