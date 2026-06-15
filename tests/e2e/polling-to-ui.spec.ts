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

test.beforeEach(async () => {
  // Clear mock state so each test starts clean and any leftover session is stopped.
  await setMockState([])
  // One poll interval + a little slack so the scrobbler finalizes any prior session.
  await new Promise((r) => setTimeout(r, 800))
})

test.describe('polling → UI', () => {
  test('health endpoint responds', async ({ request }) => {
    const res = await request.get('/health')
    expect(res.ok()).toBeTruthy()
  })

  test('active Plex session shows up in Now playing, stopped above threshold → success in feed', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.locator('header h1')).toContainText('MyShows Scrobbler')

    // Initially no session.
    await expect(page.locator('.now-playing')).toHaveCount(0)

    // Start a session at 20% — appears in NowPlaying, not in feed.
    await setMockState([episodeSession({ viewOffset: 564000 })])

    const nowPlaying = page.locator('.now-playing')
    await expect(nowPlaying).toBeVisible({ timeout: 5000 })
    await expect(nowPlaying.locator('.np-title')).toContainText('Breaking Bad S1E1 - Pilot')
    await expect(nowPlaying.locator('.np-percent')).toContainText('20')

    // Feed should still be empty (no stopped/success yet).
    await expect(page.locator('.events-list .event-item')).toHaveCount(0)

    // Advance to 70% (above the 50% threshold).
    await setMockState([episodeSession({ viewOffset: 1974000 })])
    await expect(nowPlaying.locator('.np-percent')).toContainText('70', { timeout: 5000 })

    // Remove session → stopped event → success in feed, NowPlaying disappears.
    await setMockState([])
    await expect(page.locator('.now-playing')).toHaveCount(0, { timeout: 5000 })

    const feedItem = page.locator('.events-list .event-item').first()
    await expect(feedItem).toBeVisible({ timeout: 5000 })
    await expect(feedItem.locator('.event-title')).toContainText('Breaking Bad S1E1 - Pilot')
    await expect(feedItem.locator('.status')).toHaveClass(/success/)
  })

  test('session stopped below threshold → skipped entry in feed', async ({ page }) => {
    await page.goto('/')

    // 20% is below the 50% threshold.
    await setMockState([episodeSession({ viewOffset: 564000 })])
    await expect(page.locator('.now-playing')).toBeVisible({ timeout: 5000 })

    await setMockState([])
    await expect(page.locator('.now-playing')).toHaveCount(0, { timeout: 5000 })

    const feedItem = page.locator('.events-list .event-item').first()
    await expect(feedItem).toBeVisible({ timeout: 5000 })
    await expect(feedItem.locator('.status')).toHaveClass(/skipped/)
    await expect(feedItem.locator('.status')).toContainText(/Below threshold/i)
  })
})
