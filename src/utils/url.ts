/**
 * Normalise a base URL the user typed in the UI: drop trailing slashes and
 * prepend `http://` when no scheme is present. `fetch` rejects scheme-less
 * URLs, so most callers want this rescue. Empty input is returned as-is so
 * callers can treat "" as "unset".
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) {
    return ''
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed
  }
  return `http://${trimmed}`
}

/** True when the URL is non-empty but missing an http(s) scheme. */
export function needsHttpScheme(raw: string): boolean {
  const trimmed = raw.trim()
  return trimmed.length > 0 && !/^https?:\/\//i.test(trimmed)
}

/**
 * Bootstrap-style URL rescue: empty → fallback, scheme-less → prepend
 * `http://`, otherwise pass through unchanged. Callers compare the result
 * to the input to detect a no-op.
 */
export function resolveBootstrapUrl(current: string, fallback: string): string {
  const trimmed = current.trim()
  if (!trimmed) {
    return fallback
  }
  return needsHttpScheme(trimmed) ? `http://${trimmed}` : trimmed
}

/**
 * True when the URL's host is a loopback address (127.x, ::1, localhost).
 * Anything unparseable returns false.
 */
export function isLoopbackUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    // Node's URL keeps the square brackets on IPv6 hostnames, hence '[::1]'
    const host = url.hostname.toLowerCase()
    return host === 'localhost' || host === '[::1]' || host === '::1' || host.startsWith('127.')
  } catch {
    return false
  }
}
