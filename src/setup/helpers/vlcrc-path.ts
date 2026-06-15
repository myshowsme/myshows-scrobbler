import os from 'node:os'
import path from 'node:path'

/**
 * Per-user vlcrc location, by OS. Shared by the VLC setup-action (writes it)
 * and the VLC HTTP adapter (reads the password back). Lives here — not in the
 * setup-action module — so the adapter doesn't have to import from a higher
 * layer (`adapters/` shouldn't depend on `setup/actions/`).
 */
export function resolveVlcrcPath(): string {
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
      'vlc',
      'vlcrc',
    )
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Preferences', 'org.videolan.vlc', 'vlcrc')
  }
  return path.join(os.homedir(), '.config', 'vlc', 'vlcrc')
}

/** vlcrc section names VLC actually uses (verified against VLC 3.x output). */
export const VLCRC_SECTION_CORE = 'core'
export const VLCRC_SECTION_LUA = 'lua'

/** vlcrc keys we write / read. The HTTP password lives in the `[lua]` section. */
export const VLCRC_KEY_EXTRAINTF = 'extraintf'
export const VLCRC_KEY_HOST = 'http-host'
export const VLCRC_KEY_PORT = 'http-port'
export const VLCRC_KEY_PASSWORD = 'http-password'

/** Defaults that match VLC's own GUI behaviour when "Web" is enabled. */
export const VLCRC_DEFAULT_HOST = '127.0.0.1'
export const VLCRC_DEFAULT_PORT = '8080'

/**
 * Build the `Authorization: Basic …` header value VLC's HTTP interface accepts.
 * VLC's basic auth uses an empty username with the password. Shared by the
 * adapter (per-poll) and the setup-action verify (one-shot probe).
 */
export function buildVlcAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`:${password}`).toString('base64')}`
}
