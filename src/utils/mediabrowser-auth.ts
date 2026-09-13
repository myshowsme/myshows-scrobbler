import { randomUUID } from 'node:crypto'

const APP_NAME = 'MyShows Scrobbler'
const APP_VERSION = '1.0'
const DEVICE_NAME = 'ScrobblerForMyShows'

/**
 * `Authorization` header Emby and Jellyfin expect from clients. The Quick
 * Connect handshake needs a stable DeviceId across two requests; pass one
 * in. Stateless calls (Emby AuthenticateByName) can let the default fresh
 * UUID run — the resulting token outlives the device id.
 *
 * Pass `token` for authenticated API calls: Jellyfin 12 defaults
 * `EnableLegacyAuthorization` to false and rejects `X-MediaBrowser-Token` /
 * `X-Emby-Token` / `api_key` with 401, while `Token="…"` here works on 10.8+.
 */
export function buildMediaBrowserAuthHeader(
  deviceId: string = randomUUID(),
  token?: string,
): string {
  const parts = [
    `MediaBrowser Client="${APP_NAME}"`,
    `Device="${DEVICE_NAME}"`,
    `DeviceId="${deviceId}"`,
    `Version="${APP_VERSION}"`,
  ]
  if (token) {
    parts.push(`Token="${token}"`)
  }
  return parts.join(', ')
}
