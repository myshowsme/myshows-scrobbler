import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'

/**
 * Regression guard: the probe must be strictly read-only.
 *
 * PotPlayer's WM_USER API packs the command in wParam and the *value* in
 * lParam. The 0x500x block mixes getters and setters, and the setters are one
 * digit away from the getters we want:
 *
 *   0x5000 POT_GET_VOLUME        0x5001 POT_SET_VOLUME
 *   0x5002 POT_GET_TOTAL_TIME    0x5005 POT_SET_CURRENT_TIME
 *   0x5003 POT_GET_PROGRESS_TIME 0x5007 POT_SET_PLAY_STATUS
 *   0x5004 POT_GET_CURRENT_TIME  0x5008 POT_SET_PLAY_ORDER
 *   0x5006 POT_GET_PLAY_STATUS   0x5009 POT_SET_CLOSE
 *
 * Sending a setter with lParam 0 silently mutates the user's player — e.g.
 * 0x5001 with lParam 0 mutes PotPlayer on every poll cycle.
 */

const sendMessage = vi.fn()

vi.mock('../../src/utils/win32-bridge.js', () => ({
  isWin32: () => true,
  findWindow: () => ({}) as NonNullable<unknown>,
  sendMessage: (...args: number[]) => sendMessage(...args),
}))

const { probeWindowsPotPlayer } = await import('../../src/utils/windows-potplayer.js')

const POT_SET_COMMANDS = new Map<number, string>([
  [0x5001, 'POT_SET_VOLUME'],
  [0x5005, 'POT_SET_CURRENT_TIME'],
  [0x5007, 'POT_SET_PLAY_STATUS'],
  [0x5008, 'POT_SET_PLAY_ORDER'],
  [0x5009, 'POT_SET_CLOSE'],
  [0x5010, 'POT_SEND_VIRTUAL_KEY'],
])

describe('probeWindowsPotPlayer command codes', () => {
  beforeEach(() => {
    sendMessage.mockReset()
    // Plausible responses: playing, 45 min long, 10 min in.
    sendMessage.mockImplementation((_hwnd: unknown, _msg: number, wParam: number) => {
      if (wParam === 0x5006) {
        return 2
      }
      if (wParam === 0x5002) {
        return 2_700_000
      }
      if (wParam === 0x5004) {
        return 600_000
      }
      return 0
    })
  })

  it('never sends a POT_SET_* command', async () => {
    await probeWindowsPotPlayer()

    const setCalls = sendMessage.mock.calls
      .map((call) => call[2] as number)
      .filter((wParam) => POT_SET_COMMANDS.has(wParam))
      .map((wParam) => `0x${wParam.toString(16)} (${POT_SET_COMMANDS.get(wParam)})`)

    expect(setCalls).toEqual([])
  })

  it('reads playback status via POT_GET_PLAY_STATUS (0x5006)', async () => {
    const result = await probeWindowsPotPlayer()

    const wParams = sendMessage.mock.calls.map((call) => call[2] as number)
    expect(wParams).toContain(0x5006)
    expect(result).toMatchObject({ isPlaying: true, isPaused: false })
  })

  it('maps PotPlayer status codes: -1/0 stopped, 1 paused, 2 playing', async () => {
    for (const [status, expected] of [
      [-1, { isPlaying: false, isPaused: false }],
      [0, { isPlaying: false, isPaused: false }],
      [1, { isPlaying: false, isPaused: true }],
      [2, { isPlaying: true, isPaused: false }],
    ] as const) {
      sendMessage.mockImplementation((_hwnd: unknown, _msg: number, wParam: number) => {
        if (wParam === 0x5006) {
          return status
        }
        if (wParam === 0x5002) {
          return 2_700_000
        }
        if (wParam === 0x5004) {
          return 600_000
        }
        return 0
      })
      expect(await probeWindowsPotPlayer()).toMatchObject(expected)
    }
  })
})
