import { describe, it, expect } from 'vite-plus/test'
import { probeWindowsPotPlayer } from '../../src/utils/windows-potplayer.js'

describe('probeWindowsPotPlayer', () => {
  it('returns null on non-win32 platforms (no koffi load attempt)', async () => {
    // The probe must short-circuit before touching koffi on Mac/Linux test
    // runners — otherwise the unit suite breaks for everyone not on Windows.
    // On a Windows CI runner this still returns null because PotPlayer is
    // unlikely to be running during test execution.
    const result = await probeWindowsPotPlayer()
    if (process.platform === 'win32') {
      // On Windows the only guarantee is "null OR a well-shaped object".
      if (result !== null) {
        expect(result).toMatchObject({
          isPlaying: expect.any(Boolean),
          isPaused: expect.any(Boolean),
          positionSeconds: expect.any(Number),
          durationSeconds: expect.any(Number),
        })
      }
    } else {
      expect(result).toBeNull()
    }
  })
})
