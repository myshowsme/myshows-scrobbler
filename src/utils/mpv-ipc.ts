import net from 'node:net'

/**
 * mpv JSON IPC client.
 *
 * mpv exposes a newline-delimited JSON protocol over a named pipe (Windows)
 * or a unix socket (macOS/Linux) when launched with
 * `--input-ipc-server=<path>` (usually set once in `mpv.conf` via the Stage 4
 * setup action). Each request is `{"command": [...], "request_id": N}\n`; mpv
 * replies `{"error": "success", "data": <value>, "request_id": N}\n`.
 *
 * We open a fresh connection per poll, batch the property queries, correlate
 * replies by `request_id`, then close. Per-poll connect avoids holding a
 * dangling pipe handle across mpv restarts — mpv recreates the pipe each
 * launch, and a persisted client would silently read from a dead handle.
 */

const PIPE_PREFIX = '\\\\.\\pipe\\'

/** Default IPC endpoint the setup action writes into mpv.conf, and the adapter reads from. */
export function defaultMpvSocketPath(): string {
  return process.platform === 'win32' ? `${PIPE_PREFIX}mpv-myshows` : '/tmp/mpv-myshows.sock'
}

/** mpv properties we read each poll. Order matters: request_id = index + 1. */
const MPV_PROPS = [
  'path',
  'media-title',
  'duration',
  'time-pos',
  'pause',
  'eof-reached',
  // Selected audio track (`current-tracks` resolves the `selected: true` entry
  // of track-list). All four return an error on idle mpv or when the file has
  // no audio — mapped to null, never fatal.
  'current-tracks/audio/lang',
  'current-tracks/audio/title',
  'current-tracks/audio/codec',
  'current-tracks/audio/demux-channel-count',
  // Active video parameters — exact resolution and HDR signalling, more
  // reliable than release-name tokens. Error on idle / audio-only → null.
  'video-params/w',
  'video-params/h',
  'video-params/gamma',
  'current-tracks/video/dolby-vision-profile',
  // True when the selected "video" track is just embedded cover art (music
  // file). Lets us tell a song-with-artwork apart from a real video.
  'current-tracks/video/albumart',
  // mpv build version, e.g. "mpv v0.41.0-…". Always available.
  'mpv-version',
] as const

export interface MpvProperties {
  /** Full path of the currently-open file, or null if idle. */
  path: string | null
  /** mpv's display title (often the filename; sometimes a stream title). */
  mediaTitle: string | null
  /** Total duration in seconds. */
  duration: number | null
  /** Current playback position in seconds. */
  timePos: number | null
  /** True when paused. */
  pause: boolean | null
  /** True when playback reached end-of-file (sits on the last frame). */
  eofReached: boolean | null
  /** Language of the selected audio track as authored in the file (usually ISO 639-2, e.g. "rus"). */
  audioLang: string | null
  /** Title of the selected audio track (release naming, e.g. "MVO, HDRezka Studio"). */
  audioTitle: string | null
  /** Codec of the selected audio track (e.g. "ac3", "aac"). */
  audioCodec: string | null
  /** Channel count of the selected audio track. */
  audioChannelCount: number | null
  /** Active video width in pixels. */
  videoWidth: number | null
  /** Active video height in pixels. */
  videoHeight: number | null
  /** Transfer function of the active video ("pq", "hlg", "bt.1886", …). */
  videoGamma: string | null
  /** Dolby Vision profile number of the selected video track, when present. */
  doviProfile: number | null
  /** True when the selected video track is embedded cover art (music file). */
  videoAlbumart: boolean | null
  /** mpv version string ("mpv v0.41.0" or "v0.41.0" depending on build). */
  mpvVersion: string | null
}

function mapResults(raw: Record<string, unknown>): MpvProperties {
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null
  const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
  return {
    path: str(raw['path']),
    mediaTitle: str(raw['media-title']),
    duration: num(raw['duration']),
    timePos: num(raw['time-pos']),
    pause: bool(raw['pause']),
    eofReached: bool(raw['eof-reached']),
    audioLang: str(raw['current-tracks/audio/lang']),
    audioTitle: str(raw['current-tracks/audio/title']),
    audioCodec: str(raw['current-tracks/audio/codec']),
    audioChannelCount: num(raw['current-tracks/audio/demux-channel-count']),
    videoWidth: num(raw['video-params/w']),
    videoHeight: num(raw['video-params/h']),
    videoGamma: str(raw['video-params/gamma']),
    doviProfile: num(raw['current-tracks/video/dolby-vision-profile']),
    videoAlbumart: bool(raw['current-tracks/video/albumart']),
    mpvVersion: str(raw['mpv-version']),
  }
}

/**
 * Connect to the mpv IPC endpoint, query the playback properties, and return
 * them. Resolves `null` if the socket can't be reached (mpv not running, IPC
 * not enabled, or the conf change not yet picked up after restart) or the
 * exchange times out — callers treat null as "no precise reading available".
 */
export async function queryMpvProperties(
  socketPath: string,
  timeoutMs = 1500,
): Promise<MpvProperties | null> {
  return new Promise<MpvProperties | null>((resolve) => {
    const results: Record<string, unknown> = {}
    const pending = new Set<number>()
    let buffer = ''
    let settled = false

    const socket = net.connect(socketPath)

    const finish = (value: MpvProperties | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }

    const timer = setTimeout(() => finish(null), timeoutMs)

    socket.on('connect', () => {
      MPV_PROPS.forEach((prop, index) => {
        const id = index + 1
        pending.add(id)
        socket.write(`${JSON.stringify({ command: ['get_property', prop], request_id: id })}\n`)
      })
    })

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line.trim()) {
          continue
        }
        let msg: { request_id?: unknown; error?: unknown; data?: unknown }
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        // Async event lines carry no request_id — skip them.
        if (typeof msg.request_id !== 'number' || !pending.has(msg.request_id)) {
          continue
        }
        const id = msg.request_id
        pending.delete(id)
        results[MPV_PROPS[id - 1]] = msg.error === 'success' ? msg.data : null
        if (pending.size === 0) {
          finish(mapResults(results))
        }
      }
    })

    socket.on('error', () => finish(null))
  })
}
