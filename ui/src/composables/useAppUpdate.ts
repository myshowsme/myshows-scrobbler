import { computed, onBeforeUnmount, ref } from 'vue'
import {
  fetchUpdateStatus,
  installUpdate,
  skipUpdate,
  IDLE_UPDATE_STATUS,
  type UpdateStatus,
} from '../api'

/** Idle cadence: the main process only re-checks GitHub every few hours. */
const IDLE_POLL_MS = 60_000
/** Download cadence: fast enough for a progress bar that reads as live. */
const ACTIVE_POLL_MS = 1000

export function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)} GB`
  }
  return `${mb.toFixed(1)} MB`
}

/** "Time left", as a unit + amount the caller renders through i18n. */
export interface UpdateEta {
  unit: 'seconds' | 'minutes'
  value: number
}

/**
 * Time left at the current transfer rate. Coarse on purpose — the rate swings
 * a lot, so a to-the-second countdown would just jitter.
 */
export function computeEta(remainingBytes: number, bytesPerSecond: number): UpdateEta | null {
  if (!(bytesPerSecond > 0) || remainingBytes <= 0) {
    return null
  }
  const seconds = Math.round(remainingBytes / bytesPerSecond)
  if (seconds < 60) {
    return { unit: 'seconds', value: Math.max(1, seconds) }
  }
  return { unit: 'minutes', value: Math.round(seconds / 60) }
}

/**
 * App auto-update state (Electron only; headless replies with the idle status).
 *
 * Progress is polled rather than pushed: the updater lives in the main process
 * and the poll interval simply tightens while a download is running, which
 * keeps it on the existing /api/update endpoint with no extra plumbing.
 */
export function useAppUpdate() {
  const status = ref<UpdateStatus>({ ...IDLE_UPDATE_STATUS })
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const isBusy = computed(() => status.value.downloading || status.value.installing)

  /** Bytes read out as "12.3 / 88.1 MB", once the totals are known. */
  const progressText = computed(() => {
    const { transferred, total } = status.value
    if (transferred === null || total === null || total <= 0) {
      return null
    }
    return `${formatBytes(transferred)} / ${formatBytes(total)}`
  })

  const eta = computed<UpdateEta | null>(() => {
    const { transferred, total, bytesPerSecond } = status.value
    if (transferred === null || total === null || bytesPerSecond === null) {
      return null
    }
    return computeEta(total - transferred, bytesPerSecond)
  })

  async function refresh(): Promise<void> {
    try {
      status.value = await fetchUpdateStatus()
    } catch {
      // Headless / endpoint missing, or the backend is already shutting down
      // for the install — keep the last known status rather than blanking the
      // banner out from under the user.
    }
  }

  /** Re-arm the poll at the cadence the current status calls for. */
  function schedule(): void {
    // A refresh already in flight when the component goes away would otherwise
    // re-arm the timer from its .finally and keep polling forever.
    if (stopped) {
      return
    }
    if (timer !== null) {
      clearTimeout(timer)
    }
    timer = setTimeout(
      () => {
        void refresh().finally(schedule)
      },
      isBusy.value ? ACTIVE_POLL_MS : IDLE_POLL_MS,
    )
  }

  async function start(): Promise<void> {
    await refresh()
    schedule()
  }

  async function install(): Promise<void> {
    // Flip to downloading right away so the button reacts to the click; the
    // first poll replaces this with the real progress a moment later.
    status.value = { ...status.value, downloading: true, percent: 0, error: null }
    schedule()
    try {
      await installUpdate()
    } catch {
      status.value = { ...status.value, downloading: false }
    }
  }

  async function skip(): Promise<void> {
    try {
      await skipUpdate()
    } finally {
      status.value = { ...IDLE_UPDATE_STATUS }
      schedule()
    }
  }

  onBeforeUnmount(() => {
    stopped = true
    if (timer !== null) {
      clearTimeout(timer)
    }
  })

  return { status, isBusy, progressText, eta, start, install, skip }
}
