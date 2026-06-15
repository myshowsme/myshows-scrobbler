import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { memoizeAsync } from './memoize-async.js'

/**
 * Reads Kodi's web-interface credentials from guisettings.xml so the source
 * row can be pre-filled. Needs Kodi 17+ (the modern <setting id> file shape)
 * with the web interface enabled in Settings → Services → Control.
 */

export type KodiCredentialsReason =
  | 'kodi-not-installed'
  | 'permission-denied'
  | 'webserver-disabled'
  | 'parse-error'

export interface KodiCredentialsDiscovery {
  /**
   * `username:password` for HTTP Basic (what the Kodi adapter expects in
   * its token field), or '' when the web interface needs no auth.
   */
  token: string | null
  /** Discovered web interface port, present on success. */
  port?: number
  reason?: KodiCredentialsReason
  /** Path of the file we found (or last tried). */
  source?: string
}

/**
 * Candidate paths to guisettings.xml for native installs. No Docker/NAS
 * paths: Kodi is a desktop frontend, nobody runs it in a container.
 */
export function kodiGuiSettingsPathCandidates(): string[] {
  const home = os.homedir()

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
    return [path.join(appData, 'Kodi', 'userdata', 'guisettings.xml')]
  }

  if (process.platform === 'darwin') {
    return [
      path.join(home, 'Library', 'Application Support', 'Kodi', 'userdata', 'guisettings.xml'),
    ]
  }

  // Native install + Flatpak (common on Steam Deck and immutable distros)
  return [
    path.join(home, '.kodi', 'userdata', 'guisettings.xml'),
    path.join(home, '.var', 'app', 'tv.kodi.Kodi', 'data', 'userdata', 'guisettings.xml'),
  ]
}

interface KodiWebSettings {
  enabled: boolean
  port: number
  username: string
  password: string
}

/**
 * Parse the services.webserver* settings out of a guisettings.xml body,
 * defaulting anything missing the way Kodi does (settings at their default
 * value are sometimes omitted from the file). Exported for tests.
 */
export function extractKodiWebCredentials(xml: string): KodiWebSettings | null {
  const enabledRaw = readSetting(xml, 'services.webserver')
  const portRaw = readSetting(xml, 'services.webserverport')
  const usernameRaw = readSetting(xml, 'services.webserverusername')
  const passwordRaw = readSetting(xml, 'services.webserverpassword')

  // None of the four matched: probably not a guisettings file at all.
  if (enabledRaw === null && portRaw === null && usernameRaw === null && passwordRaw === null) {
    return null
  }

  return {
    enabled: (enabledRaw ?? 'false').toLowerCase() === 'true',
    port: Number.parseInt(portRaw ?? '8080', 10) || 8080,
    username: usernameRaw ?? 'kodi',
    password: passwordRaw ?? '',
  }
}

function readSetting(xml: string, id: string): string | null {
  // <setting id="services.webserver" default="true">true</setting>
  // Quotes can be either " or ', the inner value is text-only (no nested tags).
  const pattern = new RegExp(
    `<setting\\s+[^>]*\\bid=["']${id.replace(/\./g, '\\.')}["'][^>]*>([^<]*)</setting>`,
    'i',
  )
  const match = pattern.exec(xml)
  return match ? match[1] : null
}

/**
 * Probe the candidate files for web credentials. Doesn't throw: failures
 * come back as a reason code so the UI and CLI can tell the user why.
 */
export async function discoverKodiCredentials(): Promise<KodiCredentialsDiscovery> {
  const candidates = kodiGuiSettingsPathCandidates()
  let lastReason: KodiCredentialsReason = 'kodi-not-installed'
  let lastSource: string | undefined

  for (const candidate of candidates) {
    let body: string
    try {
      body = await fs.readFile(candidate, 'utf8')
      lastSource = candidate
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        continue
      }
      if (code === 'EACCES' || code === 'EPERM') {
        return { token: null, reason: 'permission-denied', source: candidate }
      }
      lastReason = 'parse-error'
      lastSource = candidate
      continue
    }

    const settings = extractKodiWebCredentials(body)
    if (!settings) {
      return { token: null, reason: 'parse-error', source: candidate }
    }
    if (!settings.enabled) {
      return { token: null, reason: 'webserver-disabled', source: candidate }
    }
    return {
      token: settings.password ? `${settings.username}:${settings.password}` : '',
      port: settings.port,
      source: candidate,
    }
  }

  return { token: null, reason: lastReason, source: lastSource }
}

/** Memoized variant, same rationale as discoverPlexTokenOnce. */
export const discoverKodiCredentialsOnce = memoizeAsync(discoverKodiCredentials)
