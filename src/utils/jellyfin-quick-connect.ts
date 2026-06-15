import { randomUUID } from 'node:crypto'

import { buildMediaBrowserAuthHeader } from './mediabrowser-auth.js'
import { normalizeBaseUrl } from './url.js'

/**
 * Jellyfin Quick Connect handshake. The user enters a 6-character code in
 * their server's web UI; we trade the matching secret for an AccessToken.
 *
 * The DeviceId is fixed for one handshake — that's how the server pins the
 * approval to "this client" across the Initiate / Connect / Authenticate
 * round-trips.
 */

export type QuickConnectReason = 'unreachable' | 'disabled' | 'expired' | 'unknown'

export class QuickConnectError extends Error {
  constructor(
    readonly reason: QuickConnectReason,
    readonly detail?: string,
  ) {
    super(reason)
    this.name = 'QuickConnectError'
  }
}

export interface QuickConnectInitiation {
  secret: string
  code: string
  deviceId: string
}

export interface QuickConnectPollResult {
  authenticated: boolean
  accessToken?: string
}

async function jsonOrThrow(
  res: Response,
  reasonByStatus: Partial<Record<number, QuickConnectReason>>,
) {
  if (res.ok) {
    return res.json()
  }
  const mapped = reasonByStatus[res.status]
  if (mapped) {
    throw new QuickConnectError(mapped, `HTTP ${res.status}`)
  }
  throw new QuickConnectError('unknown', `HTTP ${res.status}`)
}

/**
 * Start a Quick Connect handshake. The returned `secret`/`deviceId` pair must
 * be passed back to `pollQuickConnect` until it returns `authenticated: true`
 * (with an `accessToken`) or the caller gives up.
 */
export async function initiateQuickConnect(baseUrl: string): Promise<QuickConnectInitiation> {
  const root = normalizeBaseUrl(baseUrl)
  if (!root) {
    throw new QuickConnectError('unreachable', 'empty URL')
  }
  const deviceId = randomUUID()

  let res: Response
  try {
    res = await fetch(`${root}/QuickConnect/Initiate`, {
      method: 'POST',
      headers: { Authorization: buildMediaBrowserAuthHeader(deviceId) },
    })
  } catch (err) {
    throw new QuickConnectError('unreachable', (err as Error).message)
  }

  const body = (await jsonOrThrow(res, { 401: 'disabled', 403: 'disabled', 404: 'disabled' })) as {
    Secret?: string
    Code?: string
  }
  if (!body.Secret || !body.Code) {
    throw new QuickConnectError('unknown', 'Initiate response missing Secret/Code')
  }
  return { secret: body.Secret, code: body.Code, deviceId }
}

/**
 * Single poll cycle. Returns `{ authenticated: false }` while the user
 * hasn't approved the code yet; returns `{ authenticated: true, accessToken }`
 * once they do. Throws `QuickConnectError('expired')` when the server has
 * dropped the secret.
 */
export async function pollQuickConnect(
  baseUrl: string,
  secret: string,
  deviceId: string,
): Promise<QuickConnectPollResult> {
  const root = normalizeBaseUrl(baseUrl)
  if (!root) {
    throw new QuickConnectError('unreachable', 'empty URL')
  }

  let res: Response
  try {
    res = await fetch(`${root}/QuickConnect/Connect?Secret=${encodeURIComponent(secret)}`, {
      headers: { Authorization: buildMediaBrowserAuthHeader(deviceId) },
    })
  } catch (err) {
    throw new QuickConnectError('unreachable', (err as Error).message)
  }

  const body = (await jsonOrThrow(res, { 404: 'expired' })) as { Authenticated?: boolean }
  if (!body.Authenticated) {
    return { authenticated: false }
  }

  // User just approved — trade the secret for a real access token.
  let authRes: Response
  try {
    authRes = await fetch(`${root}/Users/AuthenticateWithQuickConnect`, {
      method: 'POST',
      headers: {
        'Authorization': buildMediaBrowserAuthHeader(deviceId),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ Secret: secret }),
    })
  } catch (err) {
    throw new QuickConnectError('unreachable', (err as Error).message)
  }

  const auth = (await jsonOrThrow(authRes, { 401: 'expired' })) as { AccessToken?: string }
  if (!auth.AccessToken) {
    throw new QuickConnectError(
      'unknown',
      'AuthenticateWithQuickConnect response missing AccessToken',
    )
  }
  return { authenticated: true, accessToken: auth.AccessToken }
}
