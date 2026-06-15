import { describe, it, expect, afterEach } from 'vite-plus/test'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { NormalizedEvent, SourceConfig } from '../../src/types.js'
import { IinaIpcAdapter } from '../../src/adapters/iina-ipc.js'
import { buildEvent } from '../../src/adapters/mpv-ipc.js'
import type { MpvProperties } from '../../src/utils/mpv-ipc.js'

/** Minimal fake mpv/IINA IPC server (IINA embeds mpv, identical protocol). */
function fakeServer(properties: Record<string, unknown>): Promise<{
  socketPath: string
  close: () => Promise<void>
}> {
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\test-iina-${randomUUID()}`
      : path.join(os.tmpdir(), `test-iina-${randomUUID()}.sock`)
  const server = net.createServer((socket) => {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
        if (!line.trim()) {
          continue
        }
        const msg = JSON.parse(line) as { command: string[]; request_id: number }
        const prop = msg.command[1]
        const has = Object.prototype.hasOwnProperty.call(properties, prop)
        socket.write(
          `${JSON.stringify({
            error: has ? 'success' : 'property unavailable',
            data: has ? properties[prop] : null,
            request_id: msg.request_id,
          })}\n`,
        )
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(socketPath, () => {
      resolve({ socketPath, close: () => new Promise<void>((r) => server.close(() => r())) })
    })
  })
}

function makeAdapter(url: string, emitted: NormalizedEvent[]): IinaIpcAdapter {
  const config: SourceConfig = {
    type: 'iina',
    enabled: true,
    url,
    token: '',
    pollInterval: 5000,
    userFilter: [],
  }
  return new IinaIpcAdapter(config, {
    onScrobble: async (e) => {
      emitted.push(e)
    },
    onLog: () => {},
  })
}

let cleanup: (() => Promise<void>) | null = null
afterEach(async () => {
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

describe('buildEvent source attribution', () => {
  const props: MpvProperties = {
    path: '/Users/me/Movies/Arrival.2016.mkv',
    mediaTitle: 'Arrival.2016.mkv',
    duration: 6960,
    timePos: 120,
    pause: false,
    eofReached: false,
    audioLang: null,
    audioTitle: null,
    audioCodec: null,
    audioChannelCount: null,
    videoWidth: null,
    videoHeight: null,
    videoGamma: null,
    doviProfile: null,
    mpvVersion: null,
  }

  it('tags events with the given source and prefixes the sessionId', () => {
    const event = buildEvent(props, 'progress', 'iina')
    expect(event?.source).toBe('iina')
    expect(event?.sessionId).toBe('iina:/Users/me/Movies/Arrival.2016.mkv')
  })

  it('defaults to mpv when no source is passed', () => {
    const event = buildEvent(props, 'progress')
    expect(event?.source).toBe('mpv')
    expect(event?.sessionId.startsWith('mpv:')).toBe(true)
  })
})

describe('IinaIpcAdapter', () => {
  it('reports the iina source type', () => {
    const adapter = makeAdapter('', [])
    expect(adapter.name).toBe('iina')
  })

  it('emits a scrobble with source "iina" from a live IPC endpoint', async () => {
    const server = await fakeServer({
      'path': '/Users/me/TV/Severance.S01E04.mkv',
      'media-title': 'Severance.S01E04.mkv',
      'duration': 3000,
      'time-pos': 300,
      'pause': false,
      'eof-reached': false,
    })
    cleanup = server.close

    const emitted: NormalizedEvent[] = []
    const adapter = makeAdapter(server.socketPath, emitted)
    ;(adapter as unknown as { running: boolean }).running = true
    await (adapter as unknown as { poll(): Promise<void> }).poll()

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      source: 'iina',
      type: 'episode',
      season: 1,
      episode: 4,
      state: 'playing',
    })
  })
})
