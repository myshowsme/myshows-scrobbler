import http from 'node:http'

export interface MockPlexSession {
  sessionKey: string
  ratingKey: string
  type: 'movie' | 'episode'
  title: string
  year?: number
  grandparentTitle?: string
  parentIndex?: number
  index?: number
  duration: number
  viewOffset: number
  Guid?: Array<{ id: string }>
  Player?: { state: string }
}

export interface MockPlexState {
  sessions: MockPlexSession[]
}

export interface MockPlexServer {
  url: string
  port: number
  setState(state: MockPlexState): void
  close(): Promise<void>
}

export function startMockPlexServer(port: number): MockPlexServer {
  let state: MockPlexState = { sessions: [] }

  const server = http.createServer((req, res) => {
    const url = req.url ?? ''

    // Control endpoint: POST /mock/state { sessions: [...] }
    if (req.method === 'POST' && url === '/mock/state') {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk.toString()
      })
      req.on('end', () => {
        try {
          state = JSON.parse(body) as MockPlexState
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        } catch (err) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: (err as Error).message }))
        }
      })
      return
    }

    if (req.method === 'GET' && url.startsWith('/status/sessions')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          MediaContainer: { Metadata: state.sessions },
        }),
      )
      return
    }

    // Plex metadata lookup (hit during "stopped" handling for user rating).
    if (req.method === 'GET' && url.startsWith('/library/metadata/')) {
      const ratingKey = url.split('/').pop()?.split('?')[0] ?? ''
      const match = state.sessions.find((s) => s.ratingKey === ratingKey)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          MediaContainer: {
            Metadata: [
              {
                userRating: null,
                Guid: match?.Guid ?? [],
              },
            ],
          },
        }),
      )
      return
    }

    res.writeHead(404)
    res.end()
  })

  server.listen(port)

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    setState(next) {
      state = next
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

// When invoked directly (node ./mock-plex-server.js <port>), run as a standalone
// process — Playwright spawns it this way as a secondary webServer.
if (
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` ||
  process.argv[1]?.endsWith('mock-plex-server.js') ||
  process.argv[1]?.endsWith('mock-plex-server.ts')
) {
  const port = Number(process.argv[2] || process.env.MOCK_PLEX_PORT || 4567)
  const srv = startMockPlexServer(port)
  // eslint-disable-next-line no-console
  console.log(`[mock-plex] listening on ${srv.url}`)
  process.on('SIGTERM', () => {
    void srv.close().then(() => process.exit(0))
  })
  process.on('SIGINT', () => {
    void srv.close().then(() => process.exit(0))
  })
}
