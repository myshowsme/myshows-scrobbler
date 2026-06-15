import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { memoizeAsync } from './memoize-async.js'

/**
 * Reads the Plex token (`PlexOnlineToken`) from a local Plex Media Server
 * config: Preferences.xml on Windows/Linux/Docker, or the NSUserDefaults
 * binary plist on native macOS (decoded with plutil).
 *
 * Note: HKCU also has a PlexOnlineToken on Windows, but PMS rotates the
 * token in Preferences.xml without updating the registry mirror, so the
 * registry copy can be stale. Only the file is trustworthy.
 */

/** Why discovery returned no token. Shown verbatim in UI and CLI. */
export type PlexTokenReason =
  | 'pms-not-installed'
  | 'permission-denied'
  | 'not-signed-in'
  | 'parse-error'

export interface PlexTokenDiscovery {
  token: string | null
  reason?: PlexTokenReason
  /** Path of the config file we found (or last tried). */
  source?: string
}

/**
 * Candidate paths to Preferences.xml, probed in order: native install for
 * the current OS first, then common Docker bind-mounts and NAS defaults.
 * Deliberately a short list - probing more slows startup and risks false
 * positives.
 */
export function plexPreferencesPathCandidates(): string[] {
  const PREFS_TAIL = path.join(
    'Library',
    'Application Support',
    'Plex Media Server',
    'Preferences.xml',
  )
  const home = os.homedir()
  // Host-side paths for /config bind-mounts (LinuxServer.io, pms-docker,
  // NAS community apps).
  const dockerBindMountHostPath = (root: string): string =>
    path.join(root, 'Library', 'Application Support', 'Plex Media Server', 'Preferences.xml')

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
    return [
      // Current installer layout (verified on 1.40+ builds)
      path.join(localAppData, 'Plex', 'Plex Media Server', 'Preferences.xml'),
      // Legacy layout without the intermediate Plex\ directory
      path.join(localAppData, 'Plex Media Server', 'Preferences.xml'),
      // Docker on a Windows host
      dockerBindMountHostPath(path.join(home, 'plex', 'config')),
    ]
  }

  if (process.platform === 'darwin') {
    return [
      path.join(home, PREFS_TAIL),
      // Docker Desktop bind-mount
      dockerBindMountHostPath(path.join(home, 'plex', 'config')),
    ]
  }

  return [
    // Tarball install respecting XDG_CONFIG_HOME
    path.join(home, '.config', 'Plex Media Server', 'Preferences.xml'),
    // Debian/Red Hat package install; usually readable only by plex:plex,
    // in which case discovery returns permission-denied
    path.join('/var/lib/plexmediaserver', PREFS_TAIL),
    // Docker bind-mount conventions, roughly by popularity
    dockerBindMountHostPath('/opt/plex/config'),
    dockerBindMountHostPath(path.join(home, 'plex', 'config')),
    dockerBindMountHostPath('/srv/plex/config'),
    // unRAID community app default
    dockerBindMountHostPath('/mnt/user/appdata/plex'),
    // Synology DSM Plex package
    dockerBindMountHostPath('/volume1/Plex'),
  ]
}

export interface PlexConfigCandidate {
  path: string
  /** Preferences.xml attribute form vs macOS binary plist. */
  format: 'xml' | 'plist'
}

/**
 * All config candidates with their on-disk format. On macOS the
 * NSUserDefaults plist goes first: that's where a native PMS keeps the
 * token, and Preferences.xml usually doesn't exist there at all.
 */
export function plexConfigCandidates(): PlexConfigCandidate[] {
  const xml: PlexConfigCandidate[] = plexPreferencesPathCandidates().map((p) => ({
    path: p,
    format: 'xml',
  }))

  if (process.platform === 'darwin') {
    return [
      {
        path: path.join(
          os.homedir(),
          'Library',
          'Preferences',
          'com.plexapp.plexmediaserver.plist',
        ),
        format: 'plist',
      },
      ...xml,
    ]
  }

  return xml
}

/**
 * Pull the PlexOnlineToken attribute out of a Preferences.xml body. Tokens
 * are plain alphanumeric, so a regex beats dragging in an XML parser for
 * one attribute. Exported for tests.
 */
export function extractPlexOnlineToken(xml: string): string | null {
  const match = /\bPlexOnlineToken="([^"]+)"/.exec(xml)
  return match ? match[1] : null
}

/**
 * Same for the XML-converted plist, where the token is a
 * `<key>PlexOnlineToken</key><string>...</string>` pair.
 */
export function extractPlexOnlineTokenFromPlist(xml: string): string | null {
  const match = /<key>PlexOnlineToken<\/key>\s*<string>([^<]+)<\/string>/.exec(xml)
  return match ? match[1] : null
}

/**
 * Decode a (binary or XML) plist to XML via plutil. Bytes are fed on stdin
 * so the caller's fs.readFile stays the only file access and ENOENT/EACCES
 * handling matches the XML path.
 */
function convertPlistToXml(buf: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'plutil',
      ['-convert', 'xml1', '-o', '-', '-'],
      { maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err)
        } else {
          resolve(stdout)
        }
      },
    )
    // plutil can exit before consuming stdin (malformed plist), which shows
    // up as EPIPE here; the execFile callback reports the real error.
    child.stdin?.on('error', () => {})
    child.stdin?.end(buf)
  })
}

/**
 * Probe the candidate configs for a token. Doesn't throw: failures come
 * back as a reason code so the UI and CLI can tell the user why.
 */
export async function discoverPlexToken(): Promise<PlexTokenDiscovery> {
  const candidates = plexConfigCandidates()
  let lastReason: PlexTokenReason = 'pms-not-installed'
  let lastSource: string | undefined

  for (const candidate of candidates) {
    let buf: Buffer
    try {
      buf = await fs.readFile(candidate.path)
      lastSource = candidate.path
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        continue
      }
      if (code === 'EACCES' || code === 'EPERM') {
        // Found but unreadable (typically a Linux pkg install) - stop probing.
        return { token: null, reason: 'permission-denied', source: candidate.path }
      }
      lastReason = 'parse-error'
      lastSource = candidate.path
      continue
    }

    let token: string | null
    if (candidate.format === 'plist') {
      try {
        token = extractPlexOnlineTokenFromPlist(await convertPlistToXml(buf))
      } catch {
        // plutil missing or malformed plist - try the remaining candidates
        lastReason = 'parse-error'
        lastSource = candidate.path
        continue
      }
    } else {
      token = extractPlexOnlineToken(buf.toString('utf8'))
    }

    if (token) {
      return { token, source: candidate.path }
    }
    // File exists but holds no token: the server isn't signed in. Stop here.
    return { token: null, reason: 'not-signed-in', source: candidate.path }
  }

  return { token: null, reason: lastReason, source: lastSource }
}

/**
 * Memoized variant shared by the CLI auto-detect step and the server
 * bootstrap, so the file is read once per process. Tests import
 * discoverPlexToken directly to avoid cache pollution.
 */
export const discoverPlexTokenOnce = memoizeAsync(discoverPlexToken)
