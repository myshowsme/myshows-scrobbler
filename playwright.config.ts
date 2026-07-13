import { defineConfig } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const PORT = Number(process.env.E2E_PORT || 3456)
const MOCK_PLEX_PORT = Number(process.env.E2E_MOCK_PLEX_PORT || 4567)
const TMP_DIR = path.resolve('tests/e2e/.tmp')
const CONFIG_PATH = path.join(TMP_DIR, 'config.json')

// Write a deterministic config before Playwright spawns the webServer.
// Playwright evaluates this config file once at startup, before anything else.
fs.mkdirSync(TMP_DIR, { recursive: true })
fs.writeFileSync(
  CONFIG_PATH,
  JSON.stringify(
    {
      myshows_token: 'e2e-token',
      // Token checks go to the mock (see mock-plex-server.ts) — without a
      // "valid" token the UI keeps showing the setup wizard instead of heroes.
      myshows_url: `http://127.0.0.1:${MOCK_PLEX_PORT}/myshows`,
      scrobble_percent: 50,
      log_level: 'error',
      intercept_only: true,
      sources: [
        {
          type: 'plex',
          enabled: true,
          url: `http://127.0.0.1:${MOCK_PLEX_PORT}`,
          token: 'x',
          poll_interval: 500,
          user_filter: [],
        },
      ],
    },
    null,
    2,
  ),
)

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `npx tsx tests/e2e/mock-plex-server.ts ${MOCK_PLEX_PORT}`,
      url: `http://127.0.0.1:${MOCK_PLEX_PORT}/status/sessions`,
      timeout: 20_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'node dist/server/index.mjs --ui',
      url: `http://127.0.0.1:${PORT}/health`,
      timeout: 60_000,
      reuseExistingServer: false,
      env: {
        ...(process.env as Record<string, string>),
        CONFIG_PATH,
        // The server takes its listen port from --port/PORT (config.json has
        // no port field) — pin it so the baseURL above matches.
        PORT: String(PORT),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
