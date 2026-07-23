import type {
  AppConfig,
  AppConfigSnapshot,
  PollingLog,
  SourceConfig,
  SourceErrorCode,
  SourceType,
} from './types'

const BASE = ''

async function parseJsonOrThrow<T>(res: Response): Promise<T> {
  const text = await res.text()
  let data: unknown = null

  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      if (!res.ok) {
        const message = res.statusText
          ? `Request failed: ${res.status} ${res.statusText}`
          : `Request failed: ${res.status}`
        throw new Error(message)
      }
      throw new Error('API returned invalid JSON')
    }
  }

  const payload = data as {
    reason?: unknown
    error?: unknown
    code?: unknown
    port?: unknown
  } | null

  if (!res.ok) {
    // Dev proxy / server marks "backend down" with a machine-readable code so
    // the UI can localize the message (see configErrorText in AppShell).
    if (payload?.code === 'backend_unavailable') {
      throw new Error(`backend_unavailable:${typeof payload.port === 'number' ? payload.port : ''}`)
    }
    const message =
      typeof payload?.reason === 'string'
        ? payload.reason
        : typeof payload?.error === 'string'
          ? payload.error
          : res.statusText
            ? `Request failed: ${res.status} ${res.statusText}`
            : `Request failed: ${res.status}`
    throw new Error(message)
  }

  if (data === null) {
    throw new Error('Empty response from API')
  }

  return data as T
}

// ── Config + sources ────────────────────────────────────────────────────

export async function fetchConfig(): Promise<AppConfigSnapshot> {
  const res = await fetch(`${BASE}/api/config`)
  return parseJsonOrThrow<AppConfigSnapshot>(res)
}

export async function fetchPollingLogs(): Promise<{ logs: PollingLog[] }> {
  const res = await fetch(`${BASE}/api/polling-logs`)
  return parseJsonOrThrow<{ logs: PollingLog[] }>(res)
}

export async function patchConfig(
  patch: Partial<
    Pick<
      AppConfig,
      'interceptOnly' | 'scrobblePercent' | 'logLevel' | 'myshowsToken' | 'myshowsUrl'
    >
  >,
): Promise<{ status: string; reason?: string }> {
  const res = await fetch(`${BASE}/api/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  return parseJsonOrThrow<{ status: string; reason?: string }>(res)
}

/** Full config replace (POST). Used by the raw config editor. */
export async function saveConfig(config: AppConfig): Promise<{ status: string; reason?: string }> {
  const res = await fetch(`${BASE}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
  return parseJsonOrThrow<{ status: string; reason?: string }>(res)
}

// ── App auto-update ─────────────────────────────────────────────────────

export interface UpdateStatus {
  available: boolean
  version: string | null
  downloading: boolean
  /** Download progress 0–100, or null before the first progress event. */
  percent: number | null
  transferred: number | null
  total: number | null
  bytesPerSecond: number | null
  /** Download finished: the installer is starting and the app is about to quit. */
  installing: boolean
  error: string | null
}

/** Nothing in flight — also what headless mode reports. */
export const IDLE_UPDATE_STATUS: UpdateStatus = {
  available: false,
  version: null,
  downloading: false,
  percent: null,
  transferred: null,
  total: null,
  bytesPerSecond: null,
  installing: false,
  error: null,
}

export async function fetchUpdateStatus(): Promise<UpdateStatus> {
  const res = await fetch(`${BASE}/api/update`)
  return parseJsonOrThrow<UpdateStatus>(res)
}

export async function installUpdate(): Promise<{ status: string }> {
  const res = await fetch(`${BASE}/api/update/install`, { method: 'POST' })
  return parseJsonOrThrow<{ status: string }>(res)
}

export async function skipUpdate(): Promise<{ status: string }> {
  const res = await fetch(`${BASE}/api/update/skip`, { method: 'POST' })
  return parseJsonOrThrow<{ status: string }>(res)
}

export async function patchSource(
  type: SourceType,
  patch: Partial<Pick<SourceConfig, 'enabled' | 'url' | 'token'>>,
): Promise<{ status: string; source?: SourceConfig; reason?: string }> {
  const res = await fetch(`${BASE}/api/sources/${type}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  return parseJsonOrThrow<{ status: string; source?: SourceConfig; reason?: string }>(res)
}

// ── Connectivity checks ─────────────────────────────────────────────────

export interface SourceCheckResult {
  ok: boolean
  error?: string
  code?: SourceErrorCode
}

export async function checkSource(
  type: SourceType,
  url: string,
  token: string,
): Promise<SourceCheckResult> {
  const res = await fetch(`${BASE}/api/sources/${type}/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, token }),
  })
  return parseJsonOrThrow<SourceCheckResult>(res)
}

export async function checkMyShows(token?: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${BASE}/api/myshows/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(token !== undefined ? { token } : {}),
  })
  return parseJsonOrThrow<{ ok: boolean; error?: string }>(res)
}

// ── One-click setup actions ─────────────────────────────────────────────

export interface SetupActionInfo {
  id: string
  name: string
  description: string
  player: SourceType
  supported: boolean
  applied: boolean
  activeSnapshotId?: string
}

export interface SetupChange {
  kind: string
  target: string
  property: string
  current: string | number | null
  next: string | number | null
}

export async function fetchSetupActions(): Promise<{ actions: SetupActionInfo[] }> {
  const res = await fetch(`${BASE}/api/setup/actions`)
  return parseJsonOrThrow<{ actions: SetupActionInfo[] }>(res)
}

export async function fetchSetupDiff(id: string): Promise<{ changes: SetupChange[] }> {
  const res = await fetch(`${BASE}/api/setup/actions/${id}/diff`)
  return parseJsonOrThrow<{ changes: SetupChange[] }>(res)
}

export interface SetupApplyResult {
  status: string
  snapshotId?: string
  verified?: boolean
  changes?: SetupChange[]
  reason?: string
  /** Stable code for a blocked apply (e.g. `player-running`); UI localizes it. */
  reasonCode?: string
}

export async function applySetupAction(id: string): Promise<SetupApplyResult> {
  const res = await fetch(`${BASE}/api/setup/actions/${id}/apply`, { method: 'POST' })
  return parseJsonOrThrow<SetupApplyResult>(res)
}

export async function restoreSetupAction(
  id: string,
  snapshotId?: string,
): Promise<{ status: string; reason?: string; mode?: 'force' }> {
  const res = await fetch(`${BASE}/api/setup/actions/${id}/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(snapshotId ? { snapshotId } : {}),
  })
  return parseJsonOrThrow<{ status: string; reason?: string; mode?: 'force' }>(res)
}

// ── Plex token auto-discovery ──────────────────────────────────────────

export interface PlexTokenAutoDiscovery {
  token: string | null
  reason?: 'pms-not-installed' | 'permission-denied' | 'not-signed-in' | 'parse-error'
  source?: string
}

export async function fetchPlexAutoToken(): Promise<PlexTokenAutoDiscovery> {
  const res = await fetch(`${BASE}/api/plex/auto-token`)
  return parseJsonOrThrow<PlexTokenAutoDiscovery>(res)
}

// ── Kodi credentials auto-discovery ────────────────────────────────────

export interface KodiCredentialsAutoDiscovery {
  /** `username:password` string. Empty when Kodi is configured for
   *  unauthenticated access. Null on failure. */
  token: string | null
  /** Web interface port from guisettings.xml. Present on success. */
  port?: number
  reason?: 'kodi-not-installed' | 'permission-denied' | 'webserver-disabled' | 'parse-error'
  source?: string
}

export async function fetchKodiAutoCredentials(): Promise<KodiCredentialsAutoDiscovery> {
  const res = await fetch(`${BASE}/api/kodi/auto-token`)
  return parseJsonOrThrow<KodiCredentialsAutoDiscovery>(res)
}

// ── Quick Connect (Jellyfin / Emby) ────────────────────────────────────

export type QuickConnectErrorReason = 'unreachable' | 'disabled' | 'expired' | 'unknown'

export interface QuickConnectInitiation {
  secret: string
  code: string
  deviceId: string
}

export interface QuickConnectPollResult {
  authenticated: boolean
  accessToken?: string
}

export async function initiateQuickConnect(url: string): Promise<QuickConnectInitiation> {
  const res = await fetch(`${BASE}/api/quick-connect/initiate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  return parseJsonOrThrow<QuickConnectInitiation>(res)
}

export async function pollQuickConnect(
  url: string,
  secret: string,
  deviceId: string,
): Promise<QuickConnectPollResult> {
  const qs = new URLSearchParams({ url, secret, deviceId })
  const res = await fetch(`${BASE}/api/quick-connect/poll?${qs.toString()}`)
  return parseJsonOrThrow<QuickConnectPollResult>(res)
}

// ── Emby sign-in (username / password → token) ─────────────────────────

export type EmbySignInErrorReason = 'unreachable' | 'invalid-credentials' | 'unknown'

export interface EmbySignInResult {
  accessToken: string
  userId: string
  userName: string
}

export async function signInToEmby(
  url: string,
  username: string,
  password: string,
): Promise<EmbySignInResult> {
  const res = await fetch(`${BASE}/api/emby/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, username, password }),
  })
  return parseJsonOrThrow<EmbySignInResult>(res)
}

// ── Scrobble Tester (dev only) ──────────────────────────────────────────

export interface FixtureEntry {
  path: string
  name: string
  description: string
  category: string
  action: string
  level?: string
  endpoint?: string
  payload: unknown
}

export interface ScrobbleTestResult {
  status: number
  ok: boolean
  body: unknown
  error?: string
}

export async function fetchFixtures(): Promise<{ fixtures: FixtureEntry[] }> {
  const res = await fetch(`${BASE}/api/fixtures`)
  return parseJsonOrThrow<{ fixtures: FixtureEntry[] }>(res)
}

export async function sendScrobbleTest(
  endpoint: string,
  payload: unknown,
): Promise<ScrobbleTestResult> {
  const res = await fetch(`${BASE}/api/scrobble/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint, payload }),
  })
  return parseJsonOrThrow<ScrobbleTestResult>(res)
}
