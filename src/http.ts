import { SERVICE_REQUEST_TIMEOUT_MS } from './config.js'

export function fetchWithTimeout(
  input: Parameters<typeof fetch>[0],
  init: RequestInit = {},
  timeoutMs = SERVICE_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const signal = init.signal ?? AbortSignal.timeout(timeoutMs)
  return fetch(input, { ...init, signal })
}
