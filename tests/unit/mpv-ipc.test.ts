import { describe, it, expect, afterEach } from 'vite-plus/test'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { queryMpvProperties } from '../../src/utils/mpv-ipc.js'
import { buildEvent, resolveMpvSocket } from '../../src/adapters/mpv-ipc.js'
import type { MpvProperties } from '../../src/utils/mpv-ipc.js'

/**
 * Fake mpv IPC server: answers `get_property` requests from a fixed property
 * map so we can exercise the real socket round-trip + JSON line framing
 * without mpv installed. Uses a unix socket on POSIX and a named pipe on win32.
 */
function fakeMpvServer(properties: Record<string, unknown>): Promise<{
  socketPath: string
  close: () => Promise<void>
}> {
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\test-mpv-${randomUUID()}`
      : path.join(os.tmpdir(), `test-mpv-${randomUUID()}.sock`)

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
      resolve({
        socketPath,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res())
          }),
      })
    })
  })
}

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

describe('queryMpvProperties', () => {
  it('reads all properties from a live IPC endpoint', async () => {
    const server = await fakeMpvServer({
      'path': 'C:\\Movies\\Dune.2021.mkv',
      'media-title': 'Dune.2021.mkv',
      'duration': 9300.5,
      'time-pos': 1234.5,
      'pause': false,
      'eof-reached': false,
    })
    cleanup = server.close
    const props = await queryMpvProperties(server.socketPath)
    expect(props).not.toBeNull()
    expect(props?.path).toBe('C:\\Movies\\Dune.2021.mkv')
    expect(props?.duration).toBe(9300.5)
    expect(props?.timePos).toBe(1234.5)
    expect(props?.pause).toBe(false)
    expect(props?.eofReached).toBe(false)
  })

  it('maps unavailable properties to null', async () => {
    const server = await fakeMpvServer({ pause: true })
    cleanup = server.close
    const props = await queryMpvProperties(server.socketPath)
    expect(props?.pause).toBe(true)
    expect(props?.path).toBeNull()
    expect(props?.duration).toBeNull()
  })

  it('returns null when the socket is unreachable', async () => {
    const dead =
      process.platform === 'win32'
        ? '\\\\.\\pipe\\does-not-exist-xyz'
        : '/tmp/does-not-exist-xyz.sock'
    expect(await queryMpvProperties(dead, 500)).toBeNull()
  })
})

describe('resolveMpvSocket', () => {
  it('uses the configured path when provided', () => {
    expect(resolveMpvSocket('/tmp/custom.sock')).toBe('/tmp/custom.sock')
  })

  it('falls back to the platform default when empty', () => {
    const resolved = resolveMpvSocket('')
    if (process.platform === 'win32') {
      expect(resolved).toBe('\\\\.\\pipe\\mpv-myshows')
    } else {
      expect(resolved).toBe('/tmp/mpv-myshows.sock')
    }
  })
})

describe('buildEvent', () => {
  const base: MpvProperties = {
    path: 'D:\\TV\\The.Wire.S01E03.mkv',
    mediaTitle: 'The.Wire.S01E03.mkv',
    duration: 3600,
    timePos: 600,
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

  it('builds an episode progress event', () => {
    const event = buildEvent(base, 'progress')
    expect(event?.type).toBe('episode')
    expect(event?.source).toBe('mpv')
    expect(event?.season).toBe(1)
    expect(event?.episode).toBe(3)
    expect(event?.state).toBe('playing')
    expect(event?.duration).toBe(3_600_000)
    expect(event?.viewOffset).toBe(600_000)
    expect(event?.sessionId).toBe('mpv:D:\\TV\\The.Wire.S01E03.mkv')
  })

  it('reports paused state', () => {
    const event = buildEvent({ ...base, pause: true }, 'progress')
    expect(event?.state).toBe('paused')
  })

  it('falls back to media-title when path is null', () => {
    const event = buildEvent({ ...base, path: null }, 'progress')
    expect(event?.sessionId).toBe('mpv:The.Wire.S01E03.mkv')
  })

  it('returns null when neither path nor title is set (idle mpv)', () => {
    const event = buildEvent(
      {
        path: null,
        mediaTitle: null,
        duration: null,
        timePos: null,
        pause: null,
        eofReached: null,
        audioLang: null,
        audioTitle: null,
        audioCodec: null,
        audioChannelCount: null,
        videoWidth: null,
        videoHeight: null,
        videoGamma: null,
        doviProfile: null,
        mpvVersion: null,
      },
      'progress',
    )
    expect(event).toBeNull()
  })
})
