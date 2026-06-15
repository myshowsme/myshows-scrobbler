import { ref, type Ref } from 'vue'
import {
  initiateQuickConnect as fetchQcInitiate,
  pollQuickConnect as fetchQcPoll,
  type QuickConnectErrorReason,
} from '../api'
import type { SourceConfig, SourceType } from '../types'
import { narrowReason } from '../utils/narrow-reason'

/** UI state for the Jellyfin/Emby Quick Connect inline flow. */
export interface QuickConnectState {
  status: 'idle' | 'initiating' | 'pending' | 'failed'
  /** 6-character code to show the user while `status === 'pending'`. */
  code?: string
  /** Failure reason / i18n key tail while `status === 'failed'`. */
  reason?: QuickConnectErrorReason | 'no-url' | 'timeout'
}

const QC_POLL_INTERVAL_MS = 3000
const QC_TIMEOUT_MS = 5 * 60 * 1000
const QC_FAILURE_REASONS = ['unreachable', 'disabled', 'expired'] as const

export interface QuickConnectDeps {
  sources: Ref<SourceConfig[]>
  patchSource: (
    type: SourceType,
    patch: Partial<Pick<SourceConfig, 'enabled' | 'url' | 'token'>>,
    debounce?: boolean,
  ) => void
}

/**
 * Quick Connect flow for Jellyfin (Emby community installs don't ship it):
 * initiate to get a 6-character code, show it to the user, then poll until
 * the server reports authenticated, the user cancels, or the timeout
 * passes. On success the source token is patched and AppShell probes the
 * connection.
 */
export function useQuickConnect({ sources, patchSource }: QuickConnectDeps) {
  const quickConnect = ref<Partial<Record<SourceType, QuickConnectState>>>({})
  /** Per-source cancel handle for an in-flight Quick Connect poll loop. */
  const aborts = new Map<SourceType, () => void>()

  async function startQuickConnect(type: 'jellyfin'): Promise<boolean> {
    cancelQuickConnect(type)
    const current = sources.value.find((s) => s.type === type)
    const url = current?.url.trim() ?? ''
    if (!url) {
      quickConnect.value = { ...quickConnect.value, [type]: { status: 'failed', reason: 'no-url' } }
      return false
    }

    quickConnect.value = { ...quickConnect.value, [type]: { status: 'initiating' } }

    let aborted = false
    aborts.set(type, () => {
      aborted = true
    })

    try {
      const init = await fetchQcInitiate(url)
      if (aborted) {
        return false
      }
      quickConnect.value = {
        ...quickConnect.value,
        [type]: { status: 'pending', code: init.code },
      }

      const deadline = Date.now() + QC_TIMEOUT_MS
      while (!aborted && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, QC_POLL_INTERVAL_MS))
        if (aborted) {
          return false
        }
        const result = await fetchQcPoll(url, init.secret, init.deviceId)
        // Cancel may have arrived while the poll request was in flight
        if (aborted) {
          return false
        }
        if (result.authenticated && result.accessToken) {
          patchSource(type, { token: result.accessToken })
          quickConnect.value = { ...quickConnect.value, [type]: { status: 'idle' } }
          return true
        }
      }
      if (!aborted) {
        quickConnect.value = {
          ...quickConnect.value,
          [type]: { status: 'failed', reason: 'timeout' },
        }
      }
    } catch (e) {
      if (!aborted) {
        const reason = narrowReason(e instanceof Error ? e.message : '', QC_FAILURE_REASONS)
        quickConnect.value = { ...quickConnect.value, [type]: { status: 'failed', reason } }
      }
    } finally {
      aborts.delete(type)
    }
    return false
  }

  function cancelQuickConnect(type: SourceType): void {
    const abort = aborts.get(type)
    if (abort) {
      abort()
      aborts.delete(type)
    }
    quickConnect.value = { ...quickConnect.value, [type]: { status: 'idle' } }
  }

  return {
    quickConnect,
    startQuickConnect,
    cancelQuickConnect,
  }
}
