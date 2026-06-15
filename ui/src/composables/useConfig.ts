import { ref } from 'vue'
import {
  fetchConfig,
  fetchPollingLogs,
  patchConfig as patchConfigApi,
  patchSource as patchSourceApi,
} from '../api'
import type { AppConfig, PollingLog, SourceConfig, SourceType } from '../types'

const PATCH_DEBOUNCE_MS = 600
const DEFAULT_SOURCE_POLL_INTERVAL = 15000
/** Pre-filled when the user enables Plex on a source with an empty URL. */
const DEFAULT_PLEX_URL = 'http://127.0.0.1:32400'

/**
 * Owns reactive AppConfig state and persists local edits to the backend
 * (debounced for free-text fields, immediate for toggles). The Find token /
 * Quick Connect / Emby sign-in flows live in sibling composables that take
 * `sources` and `patchSource` from here.
 */
export function useConfig() {
  const sources = ref<SourceConfig[]>([])
  const interceptOnly = ref(false)
  const interceptOnlyLocked = ref(false)
  const myshowsToken = ref('')

  const initialLogs = ref<PollingLog[]>([])

  const loading = ref(false)
  const error = ref<string | null>(null)

  // Per-source debounce timers and pending patches (to merge consecutive edits)
  const sourcePatchTimers: Partial<Record<SourceType, ReturnType<typeof setTimeout>>> = {}
  const pendingSourcePatches: Partial<
    Record<SourceType, Partial<Pick<SourceConfig, 'enabled' | 'url' | 'token'>>>
  > = {}
  let configPatchTimer: ReturnType<typeof setTimeout> | null = null
  let pendingConfigPatch: Partial<
    Pick<AppConfig, 'interceptOnly' | 'scrobblePercent' | 'logLevel' | 'myshowsToken'>
  > = {}

  async function load() {
    loading.value = true
    error.value = null
    try {
      const cfg = await fetchConfig()
      sources.value = cfg.sources ?? []
      interceptOnly.value = cfg.interceptOnly ?? false
      myshowsToken.value = cfg.myshowsToken ?? ''
      interceptOnlyLocked.value = cfg.cliInterceptOnlyLocked ?? false

      try {
        const r = await fetchPollingLogs()
        initialLogs.value = (r.logs as unknown as PollingLog[]) ?? []
      } catch {
        // Polling logs are optional; ignore failure
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }

  function applySourceLocal(
    type: SourceType,
    patch: Partial<Pick<SourceConfig, 'enabled' | 'url' | 'token'>>,
  ) {
    const index = sources.value.findIndex((s) => s.type === type)
    if (index >= 0) {
      sources.value = sources.value.map((s) => (s.type === type ? { ...s, ...patch } : s))
      return
    }

    sources.value = [
      ...sources.value,
      {
        type,
        enabled: false,
        url: '',
        token: '',
        pollInterval: DEFAULT_SOURCE_POLL_INTERVAL,
        userFilter: [],
        ...patch,
      },
    ]
  }

  /**
   * Patch a source.
   *  - `debounce: true` merges with pending patches and writes 600ms after last change.
   *  - `debounce: false` flushes any pending and writes immediately.
   */
  function patchSource(
    type: SourceType,
    patch: Partial<Pick<SourceConfig, 'enabled' | 'url' | 'token'>>,
    debounce = false,
  ) {
    // Enabling Plex with an empty URL: pre-fill the local PMS default so the
    // field isn't blank. Fold it into this same patch (before applySourceLocal)
    // so URL and `enabled` are written together. Never clobbers a URL the user
    // already typed.
    if (type === 'plex' && patch.enabled === true) {
      const current = sources.value.find((s) => s.type === 'plex')
      if (current && !(current.url ?? '').trim()) {
        patch = { ...patch, url: DEFAULT_PLEX_URL }
      }
    }

    applySourceLocal(type, patch)
    pendingSourcePatches[type] = { ...pendingSourcePatches[type], ...patch }
    // Token auto-discovery on enable is driven by AppShell's `onSourceUpdate`
    // (it reuses the same `findPlexToken` path as the "Find token" button, then
    // probes the source) so the status dot flips to green in one click.

    const flush = async () => {
      const timer = sourcePatchTimers[type]
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      sourcePatchTimers[type] = undefined

      const toSend = pendingSourcePatches[type]
      pendingSourcePatches[type] = undefined
      if (!toSend || Object.keys(toSend).length === 0) {
        return
      }

      try {
        await patchSourceApi(type, toSend)
      } catch (e) {
        error.value = e instanceof Error ? e.message : String(e)
      }
    }

    if (debounce) {
      const existing = sourcePatchTimers[type]
      if (existing !== undefined) {
        clearTimeout(existing)
      }
      sourcePatchTimers[type] = setTimeout(() => void flush(), PATCH_DEBOUNCE_MS)
    } else {
      void flush()
    }
  }

  /**
   * Patch global config (interceptOnly, scrobblePercent, ...).
   * Same debounce semantics as patchSource.
   */
  function patchConfig(
    patch: Partial<
      Pick<AppConfig, 'interceptOnly' | 'scrobblePercent' | 'logLevel' | 'myshowsToken'>
    >,
    debounce = false,
  ) {
    if (patch.interceptOnly !== undefined) {
      interceptOnly.value = !!patch.interceptOnly
    }
    if (patch.myshowsToken !== undefined) {
      myshowsToken.value = patch.myshowsToken
    }
    pendingConfigPatch = { ...pendingConfigPatch, ...patch }

    const flush = async () => {
      if (configPatchTimer) {
        clearTimeout(configPatchTimer)
      }
      configPatchTimer = null

      const toSend = pendingConfigPatch
      pendingConfigPatch = {}
      if (Object.keys(toSend).length === 0) {
        return
      }

      try {
        const res = await patchConfigApi(toSend)
        if (res.status !== 'success') {
          error.value = res.reason ?? 'Failed to update config'
        }
      } catch (e) {
        error.value = e instanceof Error ? e.message : String(e)
      }
    }

    if (debounce) {
      if (configPatchTimer) {
        clearTimeout(configPatchTimer)
      }
      configPatchTimer = setTimeout(() => void flush(), PATCH_DEBOUNCE_MS)
    } else {
      void flush()
    }
  }

  return {
    sources,
    interceptOnly,
    interceptOnlyLocked,
    myshowsToken,
    initialLogs,
    loading,
    error,
    load,
    patchSource,
    patchConfig,
  }
}
