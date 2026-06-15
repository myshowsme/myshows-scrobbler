import { computed, type Ref } from 'vue'
import type { PollingLog, ScrobbleEvent } from '../types'

export type MergedItemKind = 'scrobble' | 'log'

export interface MergedScrobble {
  kind: 'scrobble'
  data: ScrobbleEvent
  key: string
  ts: number
}

export interface MergedLog {
  kind: 'log'
  data: PollingLog
  key: string
  ts: number
}

export type MergedItem = MergedScrobble | MergedLog

const MAX_ITEMS = 50

/**
 * Merges ScrobbleEvent + PollingLog streams chronologically (newest first),
 * applying the verbose filter (info/debug logs hidden when verbose=false).
 *
 * Capped at 50 items to mirror the backend ring buffer.
 */
export function useEvents(
  events: Ref<ScrobbleEvent[]>,
  logs: Ref<PollingLog[]>,
  verbose: Ref<boolean>,
) {
  const merged = computed<MergedItem[]>(() => {
    const items: MergedItem[] = []

    for (let i = 0; i < events.value.length; i++) {
      const e = events.value[i]
      items.push({
        kind: 'scrobble',
        data: e,
        key: `s-${i}-${e.timestamp}`,
        ts: tsOf(e.timestamp),
      })
    }

    for (let i = 0; i < logs.value.length; i++) {
      const l = logs.value[i]
      const lvl = l.level.toLowerCase()
      const include = verbose.value || lvl === 'warn' || lvl === 'error'
      if (!include) {
        continue
      }
      items.push({
        kind: 'log',
        data: l,
        key: `l-${i}-${l.timestamp}`,
        ts: tsOf(l.timestamp),
      })
    }

    items.sort((a, b) => b.ts - a.ts)
    return items.slice(0, MAX_ITEMS)
  })

  return { merged }
}

function tsOf(iso: string): number {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}
