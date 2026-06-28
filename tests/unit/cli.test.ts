import { describe, expect, it } from 'vite-plus/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseCliArgs } from '../../src/cli/args.js'
import { hasCliConfigOverrides, mergeCliConfig, validateConfig } from '../../src/cli/options.js'
import { buildRuntimeContext } from '../../src/cli/runtime.js'
import { getConfigPath, setConfigPath, writeConfig } from '../../src/config.js'
import type { AppConfig } from '../../src/types.js'

const baseConfig: AppConfig = {
  myshowsToken: '',
  myshowsUrl: 'https://myshows.me/scrobble',
  scrobblePercent: 80,
  minDurationMinutes: 5,
  stopAtThreshold: true,
  logLevel: 'info',
  interceptOnly: false,
  sources: [],
}

describe('CLI args', () => {
  it('parses server flags and env fallbacks', () => {
    const args = parseCliArgs(['--no-ui', '--host', '127.0.0.1'], {
      PORT: '4321',
      CONFIG_PATH: 'custom.json',
    })

    expect(args.ui).toBe(false)
    expect(args.host).toBe('127.0.0.1')
    expect(args.port).toBe(4321)
    expect(args.configPath).toBe('custom.json')
  })

  it('parses repeated source and check-source flags', () => {
    const args = parseCliArgs([
      '--source',
      'plex',
      '--source',
      'kodi',
      '--check-source',
      'plex',
      '--dry-run',
    ])

    expect(args.sources).toEqual(['plex', 'kodi'])
    expect(args.checkSources).toEqual(['plex'])
    expect(args.interceptOnly).toBe(true)
  })

  it('leaves interceptOnly undefined when the flag is absent', () => {
    const args = parseCliArgs([])

    expect(args.interceptOnly).toBeUndefined()
  })

  it('rejects invalid source types', () => {
    expect(() => parseCliArgs(['--source', 'bad'])).toThrow('Invalid --source')
  })
})

describe('CLI config merge', () => {
  it('does not disable interceptOnly from config when the flag is absent', () => {
    const args = parseCliArgs([])
    const merged = mergeCliConfig({ ...baseConfig, interceptOnly: true }, args)

    expect(merged.interceptOnly).toBe(true)
  })

  it('detects only runtime config overrides', () => {
    expect(hasCliConfigOverrides(parseCliArgs(['--ui']))).toBe(false)
    expect(hasCliConfigOverrides(parseCliArgs(['--port', '4321']))).toBe(false)
    expect(hasCliConfigOverrides(parseCliArgs(['--intercept-only']))).toBe(true)
    expect(hasCliConfigOverrides(parseCliArgs(['--emby-url', 'http://emby']))).toBe(true)
  })

  it('applies top-level and source-specific overrides without mutating the base config', () => {
    const args = parseCliArgs([
      '--myshows-token',
      'myshows-token',
      '--log-level',
      'debug',
      '--scrobble-percent',
      '75',
      '--plex-url',
      'http://plex:32400/',
      '--plex-token',
      'plex-token',
      '--poll-interval',
      '2500',
    ])

    const merged = mergeCliConfig(baseConfig, args)

    expect(baseConfig.sources).toEqual([])
    expect(merged.myshowsToken).toBe('myshows-token')
    expect(merged.logLevel).toBe('debug')
    expect(merged.scrobblePercent).toBe(75)
    expect(merged.sources).toEqual([
      {
        type: 'plex',
        enabled: true,
        url: 'http://plex:32400',
        token: 'plex-token',
        pollInterval: 2500,
        userFilter: [],
      },
    ])
  })

  it('validates missing enabled source URLs as warnings', () => {
    const args = parseCliArgs(['--source', 'jellyfin'])
    const merged = mergeCliConfig(baseConfig, args)
    const issues = validateConfig(merged)

    expect(issues).toEqual([{ level: 'warning', message: 'jellyfin: url is empty' }])
  })

  it('does not warn about an empty URL for a token-only Stremio source', () => {
    const args = parseCliArgs(['--source', 'stremio'])
    const merged = mergeCliConfig(baseConfig, args)
    const issues = validateConfig(merged)

    expect(issues).toEqual([])
  })

  it('parses --stremio-token into a token-only override with no URL', () => {
    const args = parseCliArgs(['--stremio-token', 'AUTHKEY'])

    expect(args.sourceOverrides.stremio).toEqual({ url: undefined, token: 'AUTHKEY' })

    const merged = mergeCliConfig(baseConfig, args)
    const stremio = merged.sources.find((s) => s.type === 'stremio')
    expect(stremio).toMatchObject({ type: 'stremio', enabled: true, url: '', token: 'AUTHKEY' })
  })
})

describe('CLI runtime wiring', () => {
  it('keeps configProvider live when CLI config overrides are present', () => {
    const previousConfigPath = getConfigPath()
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myshows-scrobbler-cli-'))
    const configPath = path.join(tmpDir, 'config.json')
    const source: AppConfig['sources'][number] = {
      type: 'plex',
      enabled: true,
      url: 'http://plex:32400',
      token: 'plex-token',
      pollInterval: 5000,
      userFilter: [],
    }

    try {
      setConfigPath(configPath)
      writeConfig({ ...baseConfig, scrobblePercent: 80, sources: [source] })

      const runtime = buildRuntimeContext(
        parseCliArgs(['--myshows-token', 'cli-token', '--poll-interval', '15000']),
      )

      expect(runtime.serverOptions.configProvider).toBeDefined()
      expect(runtime.config).toMatchObject({
        myshowsToken: 'cli-token',
        scrobblePercent: 80,
      })
      expect(runtime.config.sources[0].pollInterval).toBe(15000)

      writeConfig({ ...baseConfig, scrobblePercent: 10, sources: [source] })
      const freshConfig = runtime.serverOptions.configProvider?.()

      expect(freshConfig).toMatchObject({
        myshowsToken: 'cli-token',
        scrobblePercent: 10,
      })
      expect(freshConfig?.sources[0].pollInterval).toBe(15000)
    } finally {
      setConfigPath(previousConfigPath)
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('does not install configProvider for server-only CLI flags', () => {
    const runtime = buildRuntimeContext(parseCliArgs(['--port', '4321', '--ui']))

    expect(runtime.serverOptions.port).toBe(4321)
    expect(runtime.serverOptions.ui).toBe(true)
    expect(runtime.serverOptions.configProvider).toBeUndefined()
  })
})
