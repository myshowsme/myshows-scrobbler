import { fetchWithTimeout } from '../http.js'

export const STREMIO_API_BASE = 'https://api.strem.io'

export interface StremioLibItemState {
  timeOffset?: number
  duration?: number
  /** Episode video id, e.g. "tt123:1:5". API uses snake_case; some clients camelCase. */
  video_id?: string
  videoId?: string
  lastWatched?: string
  flaggedWatched?: boolean
  timesWatched?: number
  season?: number
  episode?: number
  watched?: string
}

export interface StremioLibItem {
  _id: string
  name: string
  type: string
  /** Release year — API returns a string, often "" when unknown. */
  year?: number | string
  _mtime: number
  removed?: boolean
  temp?: boolean
  state: StremioLibItemState
}

interface ApiEnvelope<T> {
  result?: T
  error?: { code?: number; message?: string }
}

async function apiPost<T>(base: string, method: string, body: unknown): Promise<T> {
  const res = await fetchWithTimeout(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw { status: res.status, message: `HTTP ${res.status}` }
  }
  const json = (await res.json()) as ApiEnvelope<T>
  if (json.error) {
    throw { status: json.error.code ?? 0, message: json.error.message ?? 'Stremio API error' }
  }
  return json.result as T
}

export function datastoreMeta(
  authKey: string,
  base: string = STREMIO_API_BASE,
): Promise<[string, number][]> {
  return apiPost<[string, number][]>(base, 'datastoreMeta', {
    authKey,
    collection: 'libraryItem',
  })
}

export function datastoreGet(
  authKey: string,
  ids: string[],
  base: string = STREMIO_API_BASE,
): Promise<StremioLibItem[]> {
  return apiPost<StremioLibItem[]>(base, 'datastoreGet', {
    authKey,
    collection: 'libraryItem',
    ids,
    all: false,
  })
}
