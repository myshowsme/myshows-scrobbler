import type { SourceType } from '../types.js'
import { MpvIpcAdapter } from './mpv-ipc.js'

/**
 * IINA source via the mpv JSON IPC.
 *
 * IINA (macOS) embeds mpv, so once the user points IINA's mpv `input-ipc-server`
 * option at a socket, the exact same IPC protocol works. This adapter is just
 * `MpvIpcAdapter` with a different default socket and a `source: 'iina'`
 * attribution (so the scrobble feed and MyShows `source_app` distinguish IINA
 * from a standalone mpv).
 *
 * Configuring IINA's mpv option is automated by the `iina-ipc` setup action
 * (src/setup/actions/iina.ts), which writes `input-ipc-server=<socket>` into
 * IINA's prefs. The user runs that setup, restarts IINA, then enables the
 * `iina` source (url left empty uses this default socket).
 */

export const IINA_DEFAULT_SOCKET = '/tmp/iina-myshows.sock'

export class IinaIpcAdapter extends MpvIpcAdapter {
  constructor(...args: ConstructorParameters<typeof MpvIpcAdapter>) {
    super(...args)
    // MpvIpcAdapter's constructor defaulted socketPath to the mpv socket when
    // config.url was empty; repoint to IINA's default in that case.
    if (!this.config.url.trim()) {
      this.socketPath = IINA_DEFAULT_SOCKET
    }
  }

  override get name(): SourceType {
    return 'iina'
  }
}
