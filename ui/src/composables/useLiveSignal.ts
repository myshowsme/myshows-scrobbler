import { computed, onUnmounted, ref, type ComputedRef, type Ref } from 'vue'
import type { NowPlayingEntry, ScrobbleEvent } from '../types'

const LIVE_WINDOW_MS = 15_000
const TICK_MS = 1000

/**
 * Reports whether the given scrobble event has fresh now-playing activity
 * (a matching entry updated within the last 15 seconds), and exposes the
 * current live percent if so.
 *
 * Used by the hero banner to pulse the progress bar and override the static
 * percent with live progress while the user keeps watching past the scrobble
 * threshold.
 */
export function useLiveSignal(
  scrobbleEvent: Ref<ScrobbleEvent | null>,
  nowPlaying: Ref<NowPlayingEntry[]>,
) {
  const now = useLiveClock()

  const matchedEntry = computed<NowPlayingEntry | null>(() => {
    const e = scrobbleEvent.value
    if (!e) {
      return null
    }
    return nowPlaying.value.find((np) => matches(e, np.event)) ?? null
  })

  const liveActive = computed<boolean>(() => isFresh(matchedEntry.value, now.value))
  const livePercent = computed<number | undefined>(() => {
    const np = matchedEntry.value
    if (!np || !isFresh(np, now.value)) {
      return undefined
    }
    return projectPercent(np, now.value)
  })
  const liveOffsetMs = computed<number | undefined>(() =>
    projectOffsetMs(matchedEntry.value, now.value),
  )

  return { liveActive, livePercent, liveOffsetMs, matchedEntry }
}

/**
 * Shared ticking "now" reference for live UI updates between WS pushes.
 * Multiple consumers reuse the same setInterval (one timer per component
 * lifecycle, not one per hero card).
 */
export function useLiveClock(): Ref<number> {
  const now = ref(Date.now())
  const tick = setInterval(() => {
    now.value = Date.now()
  }, TICK_MS)
  onUnmounted(() => clearInterval(tick))
  return now
}

/**
 * Live-projected percent for an arbitrary now-playing entry. Used by AppShell
 * to drive per-slot progress bars (VLC and QuickTime cards tick independently).
 */
export function useEntryLive(entry: ComputedRef<NowPlayingEntry | null>) {
  const now = useLiveClock()
  const isLive = computed(() => isFresh(entry.value, now.value))
  const percent = computed<number | undefined>(() => {
    const np = entry.value
    if (!np) {
      return undefined
    }
    return projectPercent(np, now.value)
  })
  const offsetMs = computed<number | undefined>(() => projectOffsetMs(entry.value, now.value))
  return { isLive, percent, offsetMs }
}

function isFresh(np: NowPlayingEntry | null, nowMs: number): boolean {
  if (!np) {
    return false
  }
  const updated = Date.parse(np.updatedAt)
  if (!Number.isFinite(updated)) {
    return false
  }
  const age = nowMs - updated
  return age >= 0 && age < LIVE_WINDOW_MS
}

function projectOffsetMs(np: NowPlayingEntry | null, nowMs: number): number | undefined {
  if (!np) {
    return undefined
  }
  const baseOffset = np.event.viewOffset
  if (baseOffset == null) {
    return undefined
  }
  if (np.event.state !== 'playing') {
    return baseOffset
  }
  const updated = Date.parse(np.updatedAt)
  if (!Number.isFinite(updated)) {
    return baseOffset
  }
  const age = Math.min(Math.max(0, nowMs - updated), LIVE_WINDOW_MS)
  const projected = baseOffset + age
  const duration = np.event.duration
  return duration != null ? Math.min(projected, duration) : projected
}

function projectPercent(np: NowPlayingEntry, nowMs: number): number {
  const duration = np.event.duration
  if (!duration || duration <= 0) {
    return np.percent
  }
  const offset = projectOffsetMs(np, nowMs)
  if (offset == null) {
    return np.percent
  }
  return Math.max(0, Math.min(100, (offset / duration) * 100))
}

function matches(scrobble: ScrobbleEvent, np: NowPlayingEntry['event']): boolean {
  if (scrobble.source !== np.source) {
    return false
  }
  if (scrobble.sessionId === np.sessionId) {
    return true
  }
  if (scrobble.type !== np.type) {
    return false
  }
  if (scrobble.type === 'episode') {
    return (
      scrobble.showTitle === np.showTitle &&
      scrobble.season === np.season &&
      scrobble.episode === np.episode
    )
  }
  return scrobble.title === np.title && scrobble.year === np.year
}
