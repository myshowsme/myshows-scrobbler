import { defineConfig, type ProxyOptions } from 'vite-plus'
import vue from '@vitejs/plugin-vue'
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_BACKEND_PORT = 5172

/** App version from the root package.json — injected for display in the UI. */
function readAppVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function resolveBackendPort(): number {
  const envPort = process.env.SCROBBLER_BACKEND_PORT ?? process.env.BACKEND_PORT ?? process.env.PORT
  if (envPort) {
    const parsed = Number.parseInt(envPort, 10)
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }

  try {
    const configPath = path.resolve(__dirname, '../data/config.json')
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { port?: number }
    if (typeof raw.port === 'number' && raw.port > 0) {
      return raw.port
    }
  } catch {
    // Fall back to the historical default when local config is unavailable.
  }

  return DEFAULT_BACKEND_PORT
}

const backendPort = resolveBackendPort()
const backendHttpTarget = `http://127.0.0.1:${backendPort}`

function isBackendUnavailable(error: Error & { code?: string }): boolean {
  return error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET'
}

const configureProxy: NonNullable<ProxyOptions['configure']> = (proxy) => {
  proxy.on('error', (error, _req, res) => {
    const err = error as Error & { code?: string }
    if (!isBackendUnavailable(err)) {
      console.error('[scrobbler-ui] proxy error:', err)
    }

    // WS upgrade failures hand us a bare socket with no writeHead — skip those.
    if (res && 'writeHead' in res) {
      if (!res.headersSent) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
      }
      res.end(
        JSON.stringify({
          error: `Scrobbler backend is unavailable on port ${backendPort}`,
          code: 'backend_unavailable',
          port: backendPort,
        }),
      )
    }
  })
}

export default defineConfig({
  plugins: [vue()],
  root: __dirname,
  define: {
    __APP_VERSION__: JSON.stringify(readAppVersion()),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: backendHttpTarget,
        configure: configureProxy,
      },
      '/ws': {
        target: backendHttpTarget,
        ws: true,
        configure: configureProxy,
      },
    },
  },
  build: {
    outDir: path.resolve(__dirname, '../dist/ui'),
    emptyOutDir: true,
  },
})
