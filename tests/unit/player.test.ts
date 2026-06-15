import { describe, it, expect, beforeEach, vi } from 'vite-plus/test'
import { PlayerAdapter } from '../../src/adapters/player.js'
import type { NormalizedEvent, SourceConfig } from '../../src/types.js'
import * as processMonitor from '../../src/utils/process-monitor.js'
import * as mediaDuration from '../../src/utils/media-duration.js'
import * as macosOsa from '../../src/utils/macos-osa.js'
import * as linuxMpris from '../../src/utils/linux-mpris.js'
import * as windowsSmtc from '../../src/utils/windows-smtc.js'
import * as windowsHandleResolver from '../../src/utils/windows-handle-resolver.js'

function makeAdapter(emitted: NormalizedEvent[]): PlayerAdapter {
  const config: SourceConfig = {
    type: 'player',
    enabled: true,
    url: '',
    token: '',
    pollInterval: 5000,
    userFilter: [],
  }
  return new PlayerAdapter(config, {
    onScrobble: async (e) => {
      emitted.push(e)
    },
    onLog: () => {},
  })
}

async function tick(adapter: PlayerAdapter): Promise<void> {
  await (adapter as unknown as { poll(): Promise<void> }).poll()
}

describe('PlayerAdapter', () => {
  beforeEach(() => {
    mediaDuration._resetDurationResolver()
    vi.spyOn(mediaDuration, 'getActiveDurationTool').mockResolvedValue({
      kind: 'mediainfo',
      source: 'system',
    })
    vi.spyOn(mediaDuration, 'getMediaDurationSeconds').mockResolvedValue(2700)
    // Default: no precise readings. Individual tests override per-call to
    // exercise the macOS/MPRIS/SMTC override path. All three probes must be
    // mocked, otherwise the test runner on a real OS would hit the live
    // AppleScript / DBus / SMTC backends and leak whatever the user is
    // currently playing into the test (already burned us once on Windows).
    vi.spyOn(macosOsa, 'probeMacosPlayers').mockResolvedValue([])
    vi.spyOn(linuxMpris, 'probeLinuxMpris').mockResolvedValue([])
    vi.spyOn(windowsSmtc, 'probeWindowsSmtc').mockResolvedValue([])
    // Default: handle resolver doesn't upgrade the bare filename. Individual
    // tests override to simulate a successful path resolve.
    vi.spyOn(windowsHandleResolver, 'resolveWindowsFilePath').mockResolvedValue(null)
    windowsHandleResolver._resetHandleResolverCache()
  })

  it('emits progress for a detected VLC process and stops after debounced disappearance', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = makeAdapter(emitted)
    ;(adapter as unknown as { running: boolean }).running = true

    const startedAt = new Date(Date.now() - 90_000) // running for 90s
    const scan = vi.spyOn(processMonitor, 'scanPlayers')

    scan.mockResolvedValueOnce({
      processes: [
        {
          pid: 1234,
          player: 'vlc',
          startedAt,
          commandLine: '/Applications/VLC.app/Contents/MacOS/VLC /Users/me/Inception.2010.mkv',
        },
      ],
    })

    await tick(adapter)

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      source: 'player',
      action: 'progress',
      state: 'playing',
      type: 'movie',
      title: 'Inception',
      year: 2010,
      duration: 2700_000,
      sourceApp: 'vlc',
    })
    expect(emitted[0].viewOffset).toBeGreaterThan(0)

    // First "empty" tick should NOT terminate the session — guard against
    // transient lsof / scan blips on macOS where a single tick may miss the file.
    scan.mockResolvedValueOnce({ processes: [] })
    await tick(adapter)
    expect(emitted).toHaveLength(1)

    // Second consecutive empty tick crosses the debounce threshold → stop.
    scan.mockResolvedValueOnce({ processes: [] })
    await tick(adapter)

    expect(emitted).toHaveLength(2)
    expect(emitted[1]).toMatchObject({ source: 'player', action: 'stopped' })
  })

  it('does not emit stop after a single missed tick (lsof flicker tolerance)', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = makeAdapter(emitted)
    ;(adapter as unknown as { running: boolean }).running = true

    const proc = {
      pid: 1234,
      player: 'vlc' as const,
      startedAt: new Date(Date.now() - 30_000),
      commandLine: 'vlc /tmp/A.2020.mkv',
    }
    const scan = vi.spyOn(processMonitor, 'scanPlayers')

    scan.mockResolvedValueOnce({ processes: [proc] })
    await tick(adapter)
    scan.mockResolvedValueOnce({ processes: [] }) // blip
    await tick(adapter)
    scan.mockResolvedValueOnce({ processes: [proc] }) // back again
    await tick(adapter)

    // No 'stopped' event should have been emitted — only progress events.
    expect(emitted.every((e) => e.action === 'progress')).toBe(true)
  })

  it('clamps viewOffset to duration', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = makeAdapter(emitted)
    ;(adapter as unknown as { running: boolean }).running = true

    // Process running for 10 hours; duration is 45 min → must clamp.
    const startedAt = new Date(Date.now() - 10 * 3600 * 1000)
    vi.spyOn(processMonitor, 'scanPlayers').mockResolvedValueOnce({
      processes: [
        {
          pid: 1,
          player: 'mpv',
          startedAt,
          commandLine: 'mpv /tmp/Show.S01E03.mkv',
        },
      ],
    })

    await tick(adapter)

    expect(emitted[0].viewOffset).toBe(2700_000)
  })

  it('resets viewOffset when the user switches to a different file in the same player', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = makeAdapter(emitted)
    ;(adapter as unknown as { running: boolean }).running = true

    // VLC has been running for 1 hour with the first file open.
    const startedAt = new Date(Date.now() - 3600 * 1000)
    const scan = vi.spyOn(processMonitor, 'scanPlayers')

    scan.mockResolvedValueOnce({
      processes: [
        {
          pid: 1234,
          player: 'vlc',
          startedAt,
          commandLine: '/Applications/VLC.app/Contents/MacOS/VLC /movies/Inception.2010.mkv',
        },
      ],
    })
    await tick(adapter)

    expect(emitted[0]).toMatchObject({ title: 'Inception' })
    // First file inherits the player's uptime → clamped to duration 2700s.
    expect(emitted[0].viewOffset).toBe(2700_000)

    // User opens a different file inside the same VLC process — same pid, new path.
    scan.mockResolvedValueOnce({
      processes: [
        {
          pid: 1234,
          player: 'vlc',
          startedAt,
          commandLine: '/Applications/VLC.app/Contents/MacOS/VLC /movies/Tenet.2020.mkv',
        },
      ],
    })
    await tick(adapter)

    // Two new events: stopped for Inception, progress for Tenet.
    const tenetProgress = emitted.find((e) => e.action === 'progress' && e.title === 'Tenet')
    expect(tenetProgress).toBeDefined()
    // The new file should start fresh — not inherit Inception's long-running offset.
    expect(tenetProgress!.viewOffset).toBeLessThan(1000)

    const inceptionStop = emitted.find((e) => e.action === 'stopped' && e.title === 'Inception')
    expect(inceptionStop).toBeDefined()
  })

  it('drops pid mapping when the player exits, so a relaunch starts fresh', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = makeAdapter(emitted)
    ;(adapter as unknown as { running: boolean }).running = true

    const scan = vi.spyOn(processMonitor, 'scanPlayers')

    // Open file in pid 100.
    scan.mockResolvedValueOnce({
      processes: [
        {
          pid: 100,
          player: 'vlc',
          startedAt: new Date(Date.now() - 60_000),
          commandLine: 'vlc /movies/A.2020.mkv',
        },
      ],
    })
    await tick(adapter)

    // VLC quits — needs two consecutive empty ticks to cross the debounce.
    scan.mockResolvedValueOnce({ processes: [] })
    await tick(adapter)
    scan.mockResolvedValueOnce({ processes: [] })
    await tick(adapter)

    // VLC reopened — *same* pid (reused after quit) but a new file. Should be
    // treated as a fresh launch, not a "file switched inside running player".
    const relaunchedAt = new Date(Date.now() - 50_000)
    scan.mockResolvedValueOnce({
      processes: [
        {
          pid: 100,
          player: 'vlc',
          startedAt: relaunchedAt,
          commandLine: 'vlc /movies/B.2021.mkv',
        },
      ],
    })
    await tick(adapter)

    const last = emitted[emitted.length - 1]
    expect(last.action).toBe('progress')
    expect(last.title).toBe('B')
    // A fresh launch should reuse the uptime as the initial offset (~50s),
    // not 0 (which would only happen if we still thought pid 100 was running).
    expect(last.viewOffset).toBeGreaterThan(30_000)
  })

  it('tracks two parallel players (VLC + QuickTime) as independent sessions', async () => {
    const emitted: NormalizedEvent[] = []
    const adapter = makeAdapter(emitted)
    ;(adapter as unknown as { running: boolean }).running = true

    const vlcProc = {
      pid: 1234,
      player: 'vlc' as const,
      startedAt: new Date(Date.now() - 60_000),
      commandLine: '/Applications/VLC.app/Contents/MacOS/VLC /movies/Inception.2010.mkv',
    }
    const qtProc = {
      pid: 5678,
      player: 'quicktime' as const,
      startedAt: new Date(Date.now() - 30_000),
      commandLine:
        '/System/Applications/QuickTime Player.app/Contents/MacOS/QuickTime Player /movies/Tenet.2020.mkv',
    }

    const scan = vi.spyOn(processMonitor, 'scanPlayers')

    scan.mockResolvedValueOnce({ processes: [vlcProc, qtProc] })
    await tick(adapter)

    // Both progress events emitted in the same tick.
    expect(emitted).toHaveLength(2)
    const titles = emitted.map((e) => e.title).sort()
    expect(titles).toEqual(['Inception', 'Tenet'])
    const sources = new Set(emitted.map((e) => e.sourceApp))
    expect(sources).toEqual(new Set(['vlc', 'quicktime']))

    // Each has its own sessionId — they don't collide.
    const sessionIds = new Set(emitted.map((e) => e.sessionId))
    expect(sessionIds.size).toBe(2)

    // QuickTime quits while VLC keeps playing.
    scan.mockResolvedValueOnce({ processes: [vlcProc] })
    await tick(adapter)
    scan.mockResolvedValueOnce({ processes: [vlcProc] })
    await tick(adapter)

    // After two consecutive empty ticks for QuickTime, exactly one 'stopped'
    // for Tenet should have been emitted, VLC keeps progressing.
    const tenetStop = emitted.find((e) => e.action === 'stopped' && e.title === 'Tenet')
    expect(tenetStop).toBeDefined()
    const inceptionStop = emitted.find((e) => e.action === 'stopped' && e.title === 'Inception')
    expect(inceptionStop).toBeUndefined()
  })

  describe('precise probe (macOS AppleScript) integration', () => {
    it('overrides duration/position/state from AppleScript when probe matches the process', async () => {
      const emitted: NormalizedEvent[] = []
      const adapter = makeAdapter(emitted)
      ;(adapter as unknown as { running: boolean }).running = true

      const proc = {
        pid: 1234,
        player: 'vlc' as const,
        startedAt: new Date(Date.now() - 10 * 3600 * 1000), // process has been running 10h
        commandLine: '/Applications/VLC.app/Contents/MacOS/VLC /movies/Inception.2010.mkv',
      }
      vi.spyOn(processMonitor, 'scanPlayers').mockResolvedValueOnce({ processes: [proc] })

      // AppleScript reports the user is actually 12 minutes in, paused, 130-min movie.
      vi.spyOn(macosOsa, 'probeMacosPlayers').mockResolvedValueOnce([
        {
          player: 'vlc',
          isPlaying: false,
          title: 'Inception.2010.mkv',
          filePath: '/movies/Inception.2010.mkv',
          positionSeconds: 720,
          durationSeconds: 7800,
        },
      ])

      await tick(adapter)

      expect(emitted).toHaveLength(1)
      expect(emitted[0]).toMatchObject({
        // Exact, NOT the 10-hour clamped uptime estimate.
        viewOffset: 720_000,
        duration: 7800_000,
        // AppleScript state propagates — uptime fallback would always emit "playing".
        state: 'paused',
      })
    })

    it('follows a backward seek from a precise reading (not stuck at high-water)', async () => {
      const emitted: NormalizedEvent[] = []
      const adapter = makeAdapter(emitted)
      ;(adapter as unknown as { running: boolean }).running = true

      const proc = {
        pid: 4321,
        player: 'vlc' as const,
        startedAt: new Date(Date.now() - 60_000),
        commandLine: '/Applications/VLC.app/Contents/MacOS/VLC /movies/Inception.2010.mkv',
      }
      const osa = (positionSeconds: number) => ({
        player: 'vlc' as const,
        isPlaying: true,
        title: 'Inception.2010.mkv',
        filePath: '/movies/Inception.2010.mkv',
        positionSeconds,
        durationSeconds: 7800,
      })
      vi.spyOn(processMonitor, 'scanPlayers').mockResolvedValue({ processes: [proc] })
      const probe = vi.spyOn(macosOsa, 'probeMacosPlayers')

      probe.mockResolvedValueOnce([osa(1200)])
      await tick(adapter)
      probe.mockResolvedValueOnce([osa(100)]) // user seeks backward
      await tick(adapter)

      // Latest viewOffset reflects the seek-back, not the earlier 1200s.
      expect(emitted.at(-1)?.viewOffset).toBe(100_000)
    })

    it('emits an orphan session for a precise reading with no matching process', async () => {
      const emitted: NormalizedEvent[] = []
      const adapter = makeAdapter(emitted)
      ;(adapter as unknown as { running: boolean }).running = true

      vi.spyOn(processMonitor, 'scanPlayers').mockResolvedValueOnce({ processes: [] })
      vi.spyOn(macosOsa, 'probeMacosPlayers').mockResolvedValueOnce([
        {
          player: 'vlc',
          isPlaying: true,
          title: 'OrphanMovie.2024.mkv',
          filePath: '/tmp/OrphanMovie.2024.mkv',
          positionSeconds: 100,
          durationSeconds: 5400,
        },
      ])

      await tick(adapter)

      expect(emitted).toHaveLength(1)
      expect(emitted[0]).toMatchObject({
        source: 'player',
        sourceApp: 'vlc',
        title: 'OrphanMovie',
        viewOffset: 100_000,
        duration: 5400_000,
      })
    })

    it('ignores precise readings without a file path (e.g. TV.app)', async () => {
      const emitted: NormalizedEvent[] = []
      const adapter = makeAdapter(emitted)
      ;(adapter as unknown as { running: boolean }).running = true

      vi.spyOn(processMonitor, 'scanPlayers').mockResolvedValueOnce({ processes: [] })
      vi.spyOn(macosOsa, 'probeMacosPlayers').mockResolvedValueOnce([
        {
          player: 'tv',
          isPlaying: true,
          title: 'Some Episode',
          filePath: null,
          positionSeconds: 30,
          durationSeconds: 200,
        },
      ])

      await tick(adapter)

      // Readings without a file path are filtered out — the session model needs a file.
      expect(emitted).toHaveLength(0)
    })
  })

  describe('uptime saturation', () => {
    it('emits one final stopped when uptime hits duration, then refuses to recreate that session', async () => {
      // The pain point this addresses: with no precise state source (SMTC/MPRIS/OSA)
      // the uptime-based viewOffset clamps at duration → percent stuck at 100%
      // → server-side antispam silences the feed forever. Saturating once and
      // freezing the sessionId keeps the user informed instead of leaving them
      // staring at a frozen UI.
      const emitted: NormalizedEvent[] = []
      const adapter = makeAdapter(emitted)
      ;(adapter as unknown as { running: boolean }).running = true

      const scan = vi.spyOn(processMonitor, 'scanPlayers')
      const proc = {
        pid: 9999,
        player: 'mpc' as const,
        // Process running for 2h, duration is 45min → first poll already saturated.
        startedAt: new Date(Date.now() - 2 * 3600 * 1000),
        commandLine: '"C:\\Program Files\\MPC-BE\\mpc-be64.exe" "C:\\videos\\Foo.S01E01.mkv"',
      }

      scan.mockResolvedValueOnce({ processes: [proc] })
      await tick(adapter)

      // First tick: stopped immediately because uptime > duration.
      expect(emitted).toHaveLength(1)
      expect(emitted[0]).toMatchObject({
        action: 'stopped',
        title: 'Foo',
        season: 1,
        episode: 1,
        viewOffset: 2700_000,
      })

      // Subsequent ticks while the same process is still running: zero emit.
      scan.mockResolvedValueOnce({ processes: [proc] })
      await tick(adapter)
      scan.mockResolvedValueOnce({ processes: [proc] })
      await tick(adapter)
      expect(emitted).toHaveLength(1)
    })

    it('lets the user open a different file in the same player after saturation', async () => {
      // Regression: when Inception saturates and gets removed from this.sessions,
      // the pid bookkeeping must remember pid 9999 is still alive — otherwise
      // the next file (Tenet) would be treated as a "fresh launch" and inherit
      // proc.startedAt from 2h ago, instantly saturating again.
      const emitted: NormalizedEvent[] = []
      const adapter = makeAdapter(emitted)
      ;(adapter as unknown as { running: boolean }).running = true

      const startedAt = new Date(Date.now() - 2 * 3600 * 1000)
      const scan = vi.spyOn(processMonitor, 'scanPlayers')

      scan.mockResolvedValueOnce({
        processes: [
          {
            pid: 9999,
            player: 'mpc',
            startedAt,
            commandLine: '"C:\\mpc\\mpc-be64.exe" "C:\\Inception.2010.mkv"',
          },
        ],
      })
      await tick(adapter)

      scan.mockResolvedValueOnce({
        processes: [
          {
            pid: 9999,
            player: 'mpc',
            startedAt,
            commandLine: '"C:\\mpc\\mpc-be64.exe" "C:\\Tenet.2020.mkv"',
          },
        ],
      })
      await tick(adapter)

      const tenetProgress = emitted.find((e) => e.action === 'progress' && e.title === 'Tenet')
      expect(tenetProgress).toBeDefined()
      // Crucially Tenet doesn't inherit the saturated state.
      expect(tenetProgress!.viewOffset).toBeLessThan(1000)
    })

    it('does not saturate when a precise backend keeps reporting state', async () => {
      // SMTC keeps state fresh. Saturation logic must never fire — that's
      // only for the dumb uptime path.
      const emitted: NormalizedEvent[] = []
      const adapter = makeAdapter(emitted)
      ;(adapter as unknown as { running: boolean }).running = true

      const scan = vi.spyOn(processMonitor, 'scanPlayers')
      const probe = vi.spyOn(windowsSmtc, 'probeWindowsSmtc')
      const proc = {
        pid: 4321,
        player: 'vlc' as const,
        startedAt: new Date(Date.now() - 10 * 3600 * 1000),
        commandLine: 'vlc "C:\\videos\\Show.S02E03.mkv"',
      }

      for (let i = 0; i < 3; i++) {
        scan.mockResolvedValueOnce({ processes: [proc] })
        probe.mockResolvedValueOnce([
          {
            appUserModelId: 'VideoLAN.VLC_pcvm4z2zphcb6!App',
            title: 'Show.S02E03.mkv',
            artist: '',
            albumTitle: '',
            isPlaying: true,
            positionSeconds: 100 + i * 30,
            durationSeconds: 2700,
          },
        ])
        await tick(adapter)
      }

      expect(emitted).toHaveLength(3)
      expect(emitted.every((e) => e.action === 'progress')).toBe(true)
    })
  })

  describe('precise probe (Windows SMTC) integration', () => {
    it('merges SMTC reading into the matching vlc.exe process by player id', async () => {
      // Reproduces the original bug: SMTC has no file path, so naive Map<filePath>
      // lookup always missed. The fix routes path-less precise sessions through a
      // by-player index instead.
      const emitted: NormalizedEvent[] = []
      const adapter = makeAdapter(emitted)
      ;(adapter as unknown as { running: boolean }).running = true

      vi.spyOn(processMonitor, 'scanPlayers').mockResolvedValueOnce({
        processes: [
          {
            pid: 4321,
            player: 'vlc',
            // Process running for 10h to make the bug obvious — without precise
            // override the uptime estimate would dominate.
            startedAt: new Date(Date.now() - 10 * 3600 * 1000),
            commandLine:
              'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe "C:\\videos\\Inception.2010.mkv"',
          },
        ],
      })

      vi.spyOn(windowsSmtc, 'probeWindowsSmtc').mockResolvedValueOnce([
        {
          appUserModelId: 'VideoLAN.VLC_pcvm4z2zphcb6!App',
          title: 'Inception.2010.mkv',
          artist: '',
          albumTitle: '',
          isPlaying: false,
          positionSeconds: 720,
          durationSeconds: 7800,
        },
      ])

      await tick(adapter)

      // Single event (no duplicate orphan), enriched with SMTC precise values.
      expect(emitted).toHaveLength(1)
      expect(emitted[0]).toMatchObject({
        source: 'player',
        sourceApp: 'vlc',
        title: 'Inception',
        year: 2010,
        viewOffset: 720_000,
        duration: 7800_000,
        state: 'paused',
      })
    })

    it('merges SMTC reading into mpc-hc.exe', async () => {
      const emitted: NormalizedEvent[] = []
      const adapter = makeAdapter(emitted)
      ;(adapter as unknown as { running: boolean }).running = true

      vi.spyOn(processMonitor, 'scanPlayers').mockResolvedValueOnce({
        processes: [
          {
            pid: 9001,
            player: 'mpc',
            startedAt: new Date(Date.now() - 60_000),
            commandLine: 'mpc-hc64.exe "D:\\Shows\\Breaking.Bad.S01E03.mkv"',
          },
        ],
      })

      vi.spyOn(windowsSmtc, 'probeWindowsSmtc').mockResolvedValueOnce([
        {
          appUserModelId: 'mpc-hc.exe',
          title: 'Breaking.Bad.S01E03.mkv',
          artist: '',
          albumTitle: '',
          isPlaying: true,
          positionSeconds: 300,
          durationSeconds: 2700,
        },
      ])

      await tick(adapter)

      expect(emitted).toHaveLength(1)
      expect(emitted[0]).toMatchObject({
        sourceApp: 'mpc',
        type: 'episode',
        season: 1,
        episode: 3,
        viewOffset: 300_000,
        state: 'playing',
      })
    })

    it('emits a clean-titled orphan for a UWP (Movies & TV) SMTC reading (no process match)', async () => {
      // UWP video apps publish to SMTC but their process (Video.UI.exe) is
      // often not caught by the scan — the orphan path is the only signal.
      // Verifies it strips the `smtc:AUMID:` prefix and uses the bare title so
      // guessit parses it cleanly. (Browser SMTC sessions are filtered now —
      // see SMTC_SKIP_PLAYERS — so this exercises the orphan path via wmp.)
      const emitted: NormalizedEvent[] = []
      const adapter = makeAdapter(emitted)
      ;(adapter as unknown as { running: boolean }).running = true

      vi.spyOn(processMonitor, 'scanPlayers').mockResolvedValueOnce({ processes: [] })
      vi.spyOn(windowsSmtc, 'probeWindowsSmtc').mockResolvedValueOnce([
        {
          appUserModelId: 'Microsoft.ZuneVideo_8wekyb3d8bbwe!Microsoft.ZuneVideo',
          title: 'Tenet (2020)',
          artist: '',
          albumTitle: '',
          isPlaying: true,
          positionSeconds: 60,
          durationSeconds: 8400,
        },
      ])

      await tick(adapter)

      expect(emitted).toHaveLength(1)
      expect(emitted[0]).toMatchObject({
        source: 'player',
        sourceApp: 'wmp',
        title: 'Tenet',
        year: 2020,
        viewOffset: 60_000,
        duration: 8400_000,
        state: 'playing',
      })
    })

    it('keeps a single orphan session across many polls (stable orphan sessionId)', async () => {
      // Regression: previously each poll minted a fresh negative pid, so the
      // sessionId changed every tick → adapter saw a chain of phantom new
      // sessions and was emitting a stop for the previous one after the grace
      // period. With a stable orphan id only a single session lives across polls.
      const emitted: NormalizedEvent[] = []
      const adapter = makeAdapter(emitted)
      ;(adapter as unknown as { running: boolean }).running = true

      const smtcSession = {
        appUserModelId: 'Microsoft.ZuneVideo_8wekyb3d8bbwe!Microsoft.ZuneVideo',
        title: 'Long Movie (2024)',
        artist: '',
        albumTitle: '',
        isPlaying: true,
        positionSeconds: 60,
        durationSeconds: 7200,
      }

      const scan = vi.spyOn(processMonitor, 'scanPlayers')
      const probe = vi.spyOn(windowsSmtc, 'probeWindowsSmtc')

      // Five consecutive polls — same SMTC session reported each time.
      for (let i = 0; i < 5; i++) {
        scan.mockResolvedValueOnce({ processes: [] })
        probe.mockResolvedValueOnce([{ ...smtcSession, positionSeconds: 60 + i * 5 }])
        await tick(adapter)
      }

      // Expect 5 progress events for the same session — no stop in between.
      expect(emitted).toHaveLength(5)
      expect(emitted.every((e) => e.action === 'progress')).toBe(true)
      const sessionIds = new Set(emitted.map((e) => e.sessionId))
      expect(sessionIds.size).toBe(1)
    })

    it('skips spotify SMTC sessions', async () => {
      const emitted: NormalizedEvent[] = []
      const adapter = makeAdapter(emitted)
      ;(adapter as unknown as { running: boolean }).running = true

      vi.spyOn(processMonitor, 'scanPlayers').mockResolvedValueOnce({ processes: [] })
      vi.spyOn(windowsSmtc, 'probeWindowsSmtc').mockResolvedValueOnce([
        {
          appUserModelId: 'Spotify.Spotify',
          title: 'Some Song',
          artist: 'Some Artist',
          albumTitle: '',
          isPlaying: true,
          positionSeconds: 30,
          durationSeconds: 200,
        },
      ])

      await tick(adapter)

      expect(emitted).toHaveLength(0)
    })

    it('upgrades bare-filename (from window title) to full path via the kernel handle resolver', async () => {
      // This is the live MPC-BE case: argv empty, no SMTC, window title has
      // only the filename. The NtQuerySystemInformation resolver walks the
      // process's open file handles and returns the actual full path so
      // ffprobe / duration / scrobble percent can do their job.
      const emitted: NormalizedEvent[] = []
      const adapter = makeAdapter(emitted)
      ;(adapter as unknown as { running: boolean }).running = true

      vi.spyOn(processMonitor, 'scanPlayers').mockResolvedValueOnce({
        processes: [
          {
            pid: 147196,
            player: 'mpc',
            startedAt: new Date(Date.now() - 60_000),
            commandLine: '"C:\\Program Files\\MPC-BE\\mpc-be64.exe"',
            windowTitle: 'From.S04E02.2160p.AMZN.WEB-DL.H.265.mkv - MPC-BE x64 1.8.9',
          },
        ],
      })

      const resolverSpy = vi.spyOn(windowsHandleResolver, 'resolveWindowsFilePath')
      resolverSpy.mockResolvedValueOnce(
        'F:\\Plex\\Сериалы\\FROM.S04.2160p.AMZN.WEB-DL\\From.S04E02.2160p.AMZN.WEB-DL.H.265.mkv',
      )

      await tick(adapter)

      expect(resolverSpy).toHaveBeenCalledWith(147196, 'From.S04E02.2160p.AMZN.WEB-DL.H.265.mkv')
      expect(emitted).toHaveLength(1)
      const ev = emitted[0]
      expect(ev).toMatchObject({
        sourceApp: 'mpc',
        type: 'episode',
        season: 4,
        episode: 2,
      })
      // sessionId derived from the upgraded full path, not the bare filename.
      expect(ev.sessionId).toContain('F:\\Plex\\')
      // Duration comes from the mocked mediainfo (2700) — proves the resolved
      // path made it through to getMediaDurationSeconds.
      expect(ev.duration).toBe(2700_000)
    })

    it('falls back to MainWindowTitle when MPC-BE has no file in argv and does not publish SMTC', async () => {
      // Real-world repro: MPC-BE 64-bit opened via Open File dialog.
      // CommandLine is just the exe (no positional file arg). MPC-BE doesn't
      // register with SMTC at all. The only signal we have is the window
      // title — without this fallback the user sees no scrobble.
      const emitted: NormalizedEvent[] = []
      const adapter = makeAdapter(emitted)
      ;(adapter as unknown as { running: boolean }).running = true

      vi.spyOn(processMonitor, 'scanPlayers').mockResolvedValueOnce({
        processes: [
          {
            pid: 147196,
            player: 'mpc',
            // Player has been running for 24h, but we don't know when the
            // user opened the *file*. proc.startedAt must NOT drive viewOffset.
            startedAt: new Date(Date.now() - 24 * 3600 * 1000),
            commandLine: '"C:\\Program Files\\MPC-BE\\mpc-be64.exe"',
            windowTitle: 'From.S04E02.2160p.AMZN.WEB-DL.H.265.mkv - MPC-BE x64 1.8.9',
          },
        ],
      })

      await tick(adapter)

      expect(emitted).toHaveLength(1)
      expect(emitted[0]).toMatchObject({
        sourceApp: 'mpc',
        type: 'episode',
        season: 4,
        episode: 2,
        source: 'player',
      })
      // Crucial: the 24h uptime must NOT bleed into viewOffset for a
      // late-discovered file. First poll should be near zero, not clamped-to-duration.
      expect(emitted[0].viewOffset).toBeLessThan(1000)
    })

    it('emits orphan SMTC session when vlc.exe is running but argv has no file (drag-drop)', async () => {
      // The classic Windows pain point: VLC launched without a path argv
      // (file opened via UWP file picker or drag-drop into running window).
      // Pre-fix this scenario produced zero scrobble events. Now SMTC fills in.
      const emitted: NormalizedEvent[] = []
      const adapter = makeAdapter(emitted)
      ;(adapter as unknown as { running: boolean }).running = true

      vi.spyOn(processMonitor, 'scanPlayers').mockResolvedValueOnce({
        processes: [
          {
            pid: 7777,
            player: 'vlc',
            startedAt: new Date(Date.now() - 30_000),
            // No file path in argv — extractFilePath returns null and
            // findOpenMediaFile is win32-noop, so Pass 1 skips this proc.
            commandLine: 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
          },
        ],
      })

      vi.spyOn(windowsSmtc, 'probeWindowsSmtc').mockResolvedValueOnce([
        {
          appUserModelId: 'VideoLAN.VLC_pcvm4z2zphcb6!App',
          title: 'Dune.Part.Two.2024.mkv',
          artist: '',
          albumTitle: '',
          isPlaying: true,
          positionSeconds: 1500,
          durationSeconds: 9900,
        },
      ])

      await tick(adapter)

      expect(emitted).toHaveLength(1)
      expect(emitted[0]).toMatchObject({
        sourceApp: 'vlc',
        title: 'Dune',
        year: 2024,
        viewOffset: 1500_000,
        duration: 9900_000,
      })
    })
  })

  describe('precise probe (Windows SMTC) filtering', () => {
    // SMTC reads are no-ops off win32 (probe returns []), but the tests mock
    // the probe so the filter logic runs on every platform. `browser` and
    // `spotify` sessions must yield zero emitted events. Membership of
    // SMTC_SKIP_PLAYERS is asserted separately in tests/unit/windows-smtc.test.ts.

    it('skips SMTC sessions classified as "browser" (weak metadata, risk of false scrobbles)', async () => {
      const emitted: NormalizedEvent[] = []
      const adapter = makeAdapter(emitted)
      ;(adapter as unknown as { running: boolean }).running = true

      vi.spyOn(processMonitor, 'scanPlayers').mockResolvedValueOnce({ processes: [] })
      vi.spyOn(windowsSmtc, 'probeWindowsSmtc').mockResolvedValueOnce([
        {
          appUserModelId: 'Chrome',
          title: 'Netflix',
          artist: '',
          albumTitle: '',
          isPlaying: true,
          positionSeconds: 42,
          durationSeconds: 2400,
        },
      ])

      await tick(adapter)

      // Browser SMTC sessions must not produce any event — even an orphan one.
      expect(emitted).toHaveLength(0)
    })

    it('skips SMTC sessions classified as "spotify"', async () => {
      const emitted: NormalizedEvent[] = []
      const adapter = makeAdapter(emitted)
      ;(adapter as unknown as { running: boolean }).running = true

      vi.spyOn(processMonitor, 'scanPlayers').mockResolvedValueOnce({ processes: [] })
      vi.spyOn(windowsSmtc, 'probeWindowsSmtc').mockResolvedValueOnce([
        {
          appUserModelId: 'Spotify.Spotify',
          title: 'Some Song',
          artist: 'Some Artist',
          albumTitle: 'Some Album',
          isPlaying: true,
          positionSeconds: 12,
          durationSeconds: 200,
        },
      ])

      await tick(adapter)

      expect(emitted).toHaveLength(0)
    })
  })

  describe('source-precedence (excluded players)', () => {
    it('skips a scanned player owned by an enabled precise source (no double-count)', async () => {
      const emitted: NormalizedEvent[] = []
      const adapter = makeAdapter(emitted)
      adapter.setExcludedPlayers(['mpc'])
      ;(adapter as unknown as { running: boolean }).running = true

      vi.spyOn(processMonitor, 'scanPlayers').mockResolvedValueOnce({
        processes: [
          {
            pid: 123,
            commandLine: 'C:\\mpc-hc64.exe "C:\\Movies\\Show.S01E01.mkv"',
            startedAt: new Date(),
            player: 'mpc',
          },
        ],
      })

      await tick(adapter)
      // mpc is owned by the precise `mpc` source → the player adapter must not
      // emit an uptime-estimated event for it.
      expect(emitted).toHaveLength(0)
    })

    it('still tracks non-excluded players', async () => {
      const emitted: NormalizedEvent[] = []
      const adapter = makeAdapter(emitted)
      adapter.setExcludedPlayers(['mpc'])
      ;(adapter as unknown as { running: boolean }).running = true

      vi.spyOn(processMonitor, 'scanPlayers').mockResolvedValueOnce({
        processes: [
          {
            pid: 200,
            commandLine: '/Applications/VLC.app/Contents/MacOS/VLC /Users/me/Film.2020.mkv',
            startedAt: new Date(),
            player: 'vlc',
          },
        ],
      })

      await tick(adapter)
      expect(emitted).toHaveLength(1)
      expect(emitted[0].sourceApp).toBe('vlc')
    })
  })
})
