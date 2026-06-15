import { randomUUID } from 'node:crypto'

const APP_NAME = 'MyShows Scrobbler'
const APP_VERSION = '1.0'
const DEVICE_NAME = 'ScrobblerForMyShows'

/**
 * `Authorization` header Emby and Jellyfin expect from clients. The Quick
 * Connect handshake needs a stable DeviceId across two requests; pass one
 * in. Stateless calls (Emby AuthenticateByName) can let the default fresh
 * UUID run — the resulting token outlives the device id.
 */
export function buildMediaBrowserAuthHeader(deviceId: string = randomUUID()): string {
  return [
    `MediaBrowser Client="${APP_NAME}"`,
    `Device="${DEVICE_NAME}"`,
    `DeviceId="${deviceId}"`,
    `Version="${APP_VERSION}"`,
  ].join(', ')
}
