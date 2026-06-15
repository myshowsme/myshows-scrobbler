import { buildMediaBrowserAuthHeader } from './mediabrowser-auth.js'
import { normalizeBaseUrl } from './url.js'

/**
 * Username/password sign-in against Emby's `POST /Users/AuthenticateByName`.
 * The password is forwarded once and forgotten; only the returned
 * AccessToken is persisted. Used as the inline-form alternative for Emby
 * because community installs don't ship Quick Connect.
 */

export type EmbySignInReason = 'unreachable' | 'invalid-credentials' | 'unknown'

export class EmbySignInError extends Error {
  constructor(
    readonly reason: EmbySignInReason,
    readonly detail?: string,
  ) {
    super(reason)
    this.name = 'EmbySignInError'
  }
}

export interface EmbySignInResult {
  accessToken: string
  userId: string
  userName: string
}

export async function signInToEmby(
  baseUrl: string,
  username: string,
  password: string,
): Promise<EmbySignInResult> {
  const root = normalizeBaseUrl(baseUrl)
  if (!root) {
    throw new EmbySignInError('unreachable', 'empty URL')
  }

  let res: Response
  try {
    res = await fetch(`${root}/Users/AuthenticateByName`, {
      method: 'POST',
      headers: {
        'Authorization': buildMediaBrowserAuthHeader(),
        'Content-Type': 'application/json',
      },
      // Emby/Jellyfin expect `Pw`, not `Password`.
      body: JSON.stringify({ Username: username, Pw: password }),
    })
  } catch (err) {
    throw new EmbySignInError('unreachable', (err as Error).message)
  }

  if (res.status === 401) {
    throw new EmbySignInError('invalid-credentials')
  }
  if (!res.ok) {
    throw new EmbySignInError('unknown', `HTTP ${res.status}`)
  }

  const body = (await res.json()) as {
    AccessToken?: string
    User?: { Id?: string; Name?: string }
  }
  if (!body.AccessToken || !body.User?.Id) {
    throw new EmbySignInError('unknown', 'response missing AccessToken/User')
  }
  return {
    accessToken: body.AccessToken,
    userId: body.User.Id,
    userName: body.User.Name ?? '',
  }
}
