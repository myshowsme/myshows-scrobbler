import { reactive } from 'vue'
import { checkSource } from '../api'
import { SOURCE_TYPES, type SourceErrorCode, type SourceType } from '../types'
import { hasProbeCredentials } from '../utils/source-type'

export type SourceStatusState = 'unknown' | 'checking' | 'ok' | 'error'

export interface SourceStatus {
  state: SourceStatusState
  error?: string
  code?: SourceErrorCode
  /** ISO timestamp of last status update */
  lastCheckedAt?: string
}

const DEBOUNCE_MS = 600

/**
 * Sources connectivity status store.
 *
 * UI-only: in headless mode none of this exists. Methods:
 *   - `checkNow(type, url, token)` — immediate `POST /api/sources/:type/check`
 *   - `scheduleCheck(type, url, token)` — same, debounced 600ms
 *   - `reset(type)` — clear status (used on toggle OFF)
 *   - `markOk(type)` — set ok (called from WS event success listener)
 *   - `markError(type, message, code)` — set error (called from WS sourceError listener)
 */
export function useSourceStatuses() {
  // Seed an "unknown" entry for every known source type so the record always
  // satisfies Record<SourceType, SourceStatus> — adding a new source type to
  // SOURCE_TYPES keeps this in sync automatically.
  const statuses = reactive<Record<SourceType, SourceStatus>>(
    Object.fromEntries(
      SOURCE_TYPES.map((type) => [type, { state: 'unknown' } satisfies SourceStatus]),
    ) as Record<SourceType, SourceStatus>,
  )

  const timers: Partial<Record<SourceType, ReturnType<typeof setTimeout>>> = {}
  /** Token to identify the most recent in-flight check per source (race protection). */
  const inFlight: Partial<Record<SourceType, number>> = {}
  let nextToken = 1

  function setStatus(type: SourceType, status: SourceStatus) {
    statuses[type] = status
  }

  function clearTimer(type: SourceType) {
    const t = timers[type]
    if (t !== undefined) {
      clearTimeout(t)
      timers[type] = undefined
    }
  }

  /** Immediate check (used on mount, on toggle ON). */
  async function checkNow(type: SourceType, url: string, token: string) {
    clearTimer(type)
    if (!hasProbeCredentials(type, url, token)) {
      setStatus(type, { state: 'unknown' })
      return
    }

    const myToken = ++nextToken
    inFlight[type] = myToken

    setStatus(type, { state: 'checking' })

    try {
      const res = await checkSource(type, url, token)
      // Drop result if a newer check has been issued since
      if (inFlight[type] !== myToken) {
        return
      }

      setStatus(type, {
        state: res.ok ? 'ok' : 'error',
        error: res.error,
        code: res.code,
        lastCheckedAt: new Date().toISOString(),
      })
    } catch (err) {
      if (inFlight[type] !== myToken) {
        return
      }
      setStatus(type, {
        state: 'error',
        error: err instanceof Error ? err.message : String(err),
        code: 'unreachable',
        lastCheckedAt: new Date().toISOString(),
      })
    }
  }

  /** Debounced check (used on url/token edits). */
  function scheduleCheck(type: SourceType, url: string, token: string) {
    clearTimer(type)
    if (!hasProbeCredentials(type, url, token)) {
      setStatus(type, { state: 'unknown' })
      return
    }
    timers[type] = setTimeout(() => {
      void checkNow(type, url, token)
    }, DEBOUNCE_MS)
  }

  /** Used when toggle goes off — clear status without check. */
  function reset(type: SourceType) {
    clearTimer(type)
    inFlight[type] = undefined
    setStatus(type, { state: 'unknown' })
  }

  /** Called from WS event success listener — promotes status to ok. */
  function markOk(type: SourceType) {
    setStatus(type, { state: 'ok', lastCheckedAt: new Date().toISOString() })
  }

  /** Called from WS sourceError listener — promotes status to error. */
  function markError(type: SourceType, error: string, code: SourceErrorCode = 'unreachable') {
    setStatus(type, { state: 'error', error, code, lastCheckedAt: new Date().toISOString() })
  }

  return { statuses, checkNow, scheduleCheck, reset, markOk, markError }
}
