import { test, expect } from '@playwright/test'
import type { MockPlexSession } from './mock-plex-server.js'

const MOCK_PLEX_URL = `http://127.0.0.1:${process.env.E2E_MOCK_PLEX_PORT || 4567}`

async function setMockState(sessions: MockPlexSession[]): Promise<void> {
  const res = await fetch(`${MOCK_PLEX_URL}/mock/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessions }),
  })
  if (!res.ok) {
    throw new Error(`mock-plex setState failed: ${res.status}`)
  }
}

function episodeSession(overrides: Partial<MockPlexSession> = {}): MockPlexSession {
  return {
    sessionKey: 'k1',
    ratingKey: '42',
    type: 'episode',
    title: 'Pilot',
    grandparentTitle: 'Breaking Bad',
    parentIndex: 1,
    index: 1,
    year: 2008,
    duration: 2820000,
    viewOffset: 564000, // 20%
    Guid: [{ id: 'imdb://tt0959621' }],
    Player: { state: 'playing' },
    ...overrides,
  }
}

test.beforeEach(async ({ page }) => {
  // Clear mock state so each test starts clean and any leftover session is stopped.
  await setMockState([])
  // One poll interval + a little slack so the scrobbler finalizes any prior session.
  await new Promise((r) => setTimeout(r, 800))
  // Pin the UI language so text assertions don't depend on the OS locale.
  await page.addInitScript(() => localStorage.setItem('locale', 'en'))
})

test.describe('polling → UI', () => {
  test('health endpoint responds', async ({ request }) => {
    const res = await request.get('/health')
    expect(res.ok()).toBeTruthy()
  })

  test('active Plex session shows up in the hero, stopped above threshold → success in feed', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.locator('header.AppHeader')).toBeVisible()

    // Fresh server: nothing playing, nothing scrobbled.
    await expect(page.locator('.Hero__progress-fill--live')).toHaveCount(0)
    await expect(page.locator('.EventRow--ok')).toHaveCount(0)

    // Start a session at 20% — the hero goes live. (The feed may already get a
    // success row here: the START scrobble is sent as soon as playback is seen.)
    await setMockState([episodeSession({ viewOffset: 564000 })])

    const hero = page.locator('.Hero').first()
    await expect(hero).toBeVisible({ timeout: 5000 })
    await expect(hero.locator('.Hero__progress-fill--live')).toBeVisible({ timeout: 5000 })
    await expect(hero.locator('.Hero__title')).toContainText('Breaking Bad')
    await expect(hero.locator('.Hero__percent')).toContainText('20')

    // Advance to 70% (above the 50% threshold).
    await setMockState([episodeSession({ viewOffset: 1974000 })])
    await expect(hero.locator('.Hero__percent')).toContainText('70', { timeout: 5000 })

    // Remove the session → scrobble finalizes → success row in the feed and
    // the live pulse stops (the hero itself stays, showing the last scrobble).
    await setMockState([])

    const okRow = page.locator('.EventRow--ok').first()
    await expect(okRow).toBeVisible({ timeout: 10000 })
    await expect(okRow.locator('.EventRow__title')).toContainText('Breaking Bad — 1×01')
    // The live-freshness window is 15s, so allow for it to lapse.
    await expect(page.locator('.Hero__progress-fill--live')).toHaveCount(0, { timeout: 20000 })
  })

  test('session stopped below threshold → skipped entry in feed', async ({ page }) => {
    await page.goto('/')

    // 20% is below the 50% threshold.
    await setMockState([episodeSession({ viewOffset: 564000 })])
    await expect(page.locator('.Hero__progress-fill--live').first()).toBeVisible({ timeout: 5000 })

    await setMockState([])

    const skippedRow = page.locator('.EventRow--skipped').first()
    await expect(skippedRow).toBeVisible({ timeout: 10000 })
    await expect(skippedRow.locator('.EventRow__title')).toContainText(/below threshold/i)
  })
})
