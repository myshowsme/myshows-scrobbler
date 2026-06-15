import { onMounted, onUnmounted, ref, type Ref } from 'vue'
import type {
  NowPlayingEntry,
  PollingLog,
  ScrobbleEvent,
  SourceErrorCode,
  SourceType,
} from '../types'

const MAX = 50
const RECONNECT_DELAY_MS = 3000

export interface SourceErrorEvent {
  source: SourceType
  error: string
  code: SourceErrorCode
  /** Local timestamp when the message arrived (ISO). */
  receivedAt: string
}

/**
 * WebSocket bus.
 *
 * Reactive refs that mirror backend WS broadcasts:
 *   - `events`  ← `{ type: 'event', data: ScrobbleEvent }`     (capped 50, newest first)
 *   - `logs`    ← `{ type: 'log',   data: PollingLog }`        (capped 50, newest first)
 *   - `nowPlaying` ← `{ type: 'nowPlaying', data: NowPlayingEntry[] }` (full snapshot)
 *   - `lastSourceError` ← `{ type: 'sourceError', data: ... }` (latest)
 *
 * Initial events are replayed by the backend on WS connect.
 * Polling logs are NOT replayed — fetch them via REST on mount if needed.
 *
 * Auto-reconnects with a 3s delay on close.
 */
export function useWebSocket() {
  const connected = ref(false)
  const events = ref<ScrobbleEvent[]>([])
  const logs = ref<PollingLog[]>([])
  const nowPlaying = ref<NowPlayingEntry[]>([])
  /** Latest sourceError per source type. Watch this ref to react. */
  const lastSourceError = ref<SourceErrorEvent | null>(null)

  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let unmounted = false

  function pushCapped<T>(arr: Ref<T[]>, item: T) {
    arr.value = [item, ...arr.value].slice(0, MAX)
  }

  function pushLog(item: PollingLog) {
    const existingIndex = logs.value.findIndex(
      (log) => log.level === item.level && log.message === item.message,
    )
    if (existingIndex !== -1) {
      logs.value = [
        item,
        ...logs.value.slice(0, existingIndex),
        ...logs.value.slice(existingIndex + 1),
      ].slice(0, MAX)
      return
    }

    pushCapped(logs, item)
  }

  function resolveWsUrl(): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${window.location.host}/ws`
  }

  function connect() {
    ws = new WebSocket(resolveWsUrl())

    ws.onopen = () => {
      connected.value = true
    }

    ws.onclose = () => {
      connected.value = false
      if (!unmounted) {
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS)
      }
    }

    ws.onerror = () => {
      connected.value = false
    }

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data)
        if (data?.type === 'event' && data.data) {
          pushCapped(events, data.data as ScrobbleEvent)
        } else if (data?.type === 'log' && data.data) {
          pushLog(data.data as PollingLog)
        } else if (data?.type === 'nowPlaying' && Array.isArray(data.data)) {
          nowPlaying.value = data.data as NowPlayingEntry[]
        } else if (data?.type === 'sourceError' && data.data) {
          const d = data.data as { source: SourceType; error: string; code: SourceErrorCode }
          lastSourceError.value = {
            source: d.source,
            error: d.error,
            code: d.code,
            receivedAt: new Date().toISOString(),
          }
        }
      } catch {
        /* ignore parse errors */
      }
    }
  }

  function disconnect() {
    unmounted = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
    }
    if (ws) {
      ws.onclose = null
      ws.close()
    }
    connected.value = false
  }

  onMounted(connect)
  onUnmounted(disconnect)

  return { connected, events, logs, nowPlaying, lastSourceError }
}
