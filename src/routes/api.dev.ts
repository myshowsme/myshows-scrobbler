import type { FastifyInstance } from 'fastify'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { MyShowsClient, MYSHOWS_ENDPOINTS } from '../scrobblers/myshows.js'
import { isAsciiToken } from '../utils/validation.js'

interface DevApiContext {
  myShowsClient: MyShowsClient
}

/**
 * Dev-only API routes (fixtures listing + scrobble tester proxy).
 *
 * Registered only when `process.env.NODE_ENV !== 'production'` -
 * see `server.ts` for the gate. Never reachable in prod builds.
 */
export async function devApiRoutes(fastify: FastifyInstance, ctx: DevApiContext): Promise<void> {
  const FIXTURES_ROOT = join(process.cwd(), 'fixtures', 'scrobble')

  // GET /api/fixtures - list all fixture files with metadata
  fastify.get('/api/fixtures', async (_request, reply) => {
    try {
      const files = collectJsonFiles(FIXTURES_ROOT)
      const fixtures = files.map((filePath) => {
        const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
        return {
          path: relative(FIXTURES_ROOT, filePath).replace(/\\/g, '/'),
          ...raw._meta,
          payload: raw.payload,
        }
      })
      return { fixtures }
    } catch (err) {
      reply.code(500)
      return { error: (err as Error).message }
    }
  })

  // POST /api/scrobble/test - proxy payload to MyShows scrobble endpoint
  fastify.post<{ Body: { endpoint: string; payload: unknown } }>(
    '/api/scrobble/test',
    async (request, reply) => {
      const { endpoint, payload } = request.body

      if (!endpoint || !payload) {
        reply.code(400)
        return { error: 'endpoint and payload are required' }
      }

      const allowedEndpoints: string[] = [
        MYSHOWS_ENDPOINTS.SCROBBLE_START,
        MYSHOWS_ENDPOINTS.SCROBBLE_PAUSE,
        MYSHOWS_ENDPOINTS.SCROBBLE_STOP,
      ]
      if (!allowedEndpoints.includes(endpoint)) {
        reply.code(400)
        return { error: `Invalid endpoint. Allowed: ${allowedEndpoints.join(', ')}` }
      }

      const baseUrl = ctx.myShowsClient.getBaseUrl()
      const token = ctx.myShowsClient.getToken()

      if (!baseUrl) {
        reply.code(400)
        return { error: 'MyShows URL is not configured' }
      }
      if (!token) {
        reply.code(400)
        return { error: 'MyShows token is not configured' }
      }
      if (!isAsciiToken(token)) {
        reply.code(400)
        return {
          error:
            'MyShows token contains invalid characters (non-ASCII). Please set a valid token in config.',
        }
      }

      try {
        const url = `${baseUrl}${endpoint}`
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
        })

        const responseBody = await response.text()
        let parsedBody: unknown
        try {
          parsedBody = JSON.parse(responseBody)
        } catch {
          parsedBody = responseBody
        }

        return {
          status: response.status,
          ok: response.ok,
          body: parsedBody,
        }
      } catch (err) {
        reply.code(502)
        return { error: (err as Error).message }
      }
    },
  )
}

function collectJsonFiles(dir: string): string[] {
  const results: string[] = []
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        results.push(...collectJsonFiles(full))
      } else if (entry.endsWith('.json')) {
        results.push(full)
      }
    }
  } catch {
    // Directory doesn't exist - return empty
  }
  return results
}
