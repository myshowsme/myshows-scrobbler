import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readConfig, writeConfig, setConfigPath } from '../../src/config.js'

let tmpDir: string
let configPath: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myshows-scrobbler-cfg-'))
  configPath = path.join(tmpDir, 'config.json')
  setConfigPath(configPath)
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('readConfig / writeConfig', () => {
  it('creates defaults when the file does not exist', () => {
    const cfg = readConfig()
    expect(cfg.myshowsUrl).toBe('https://myshows.me/scrobble')
    expect(cfg.scrobblePercent).toBe(80)
    expect(cfg.logLevel).toBe('info')
    expect(cfg.interceptOnly).toBe(false)
    expect(cfg.sources).toEqual([])
    expect(fs.existsSync(configPath)).toBe(true)
  })

  it('round-trips snake_case <-> camelCase including interceptOnly', () => {
    writeConfig({
      myshowsToken: 'tok',
      myshowsUrl: 'https://example.test/api',
      scrobblePercent: 70,
      logLevel: 'debug',
      interceptOnly: true,
      sources: [
        {
          type: 'plex',
          enabled: true,
          url: 'http://plex:32400/',
          token: 'x',
          pollInterval: 1234,
          userFilter: ['alice'],
        },
      ],
    })

    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    expect(raw.myshows_token).toBe('tok')
    expect(raw.intercept_only).toBe(true)
    expect(raw.scrobble_percent).toBe(70)
    expect(raw.sources[0].url).toBe('http://plex:32400')
    expect(raw.sources[0].poll_interval).toBe(1234)
    expect(raw.sources[0].user_filter).toEqual(['alice'])
    expect(raw.sources[0].mode).toBeUndefined()

    const cfg = readConfig()
    expect(cfg.interceptOnly).toBe(true)
    expect(cfg.sources[0].url).toBe('http://plex:32400')
    expect(cfg.sources[0].pollInterval).toBe(1234)
    expect(cfg.sources[0].userFilter).toEqual(['alice'])
  })

  it('silently drops the legacy mode field when reading raw sources', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        myshows_token: 'tok',
        myshows_url: 'https://example.test/api',
        scrobble_percent: 80,
        log_level: 'info',
        sources: [
          {
            type: 'plex',
            enabled: true,
            mode: 'webhook',
            url: 'http://plex:32400',
            token: 'x',
            poll_interval: 5000,
            user_filter: [],
          },
        ],
      }),
    )

    const cfg = readConfig()
    expect(cfg.sources).toHaveLength(1)
    expect(cfg.sources[0]).not.toHaveProperty('mode')
    expect(cfg.sources[0].type).toBe('plex')
  })

  it('uses 15 seconds as the default source polling interval', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        myshows_token: 'tok',
        myshows_url: 'https://example.test/api',
        sources: [
          {
            type: 'plex',
            enabled: true,
            url: 'http://plex:32400',
            token: 'x',
            user_filter: [],
          },
        ],
      }),
    )

    const cfg = readConfig()
    expect(cfg.sources[0].pollInterval).toBe(15000)
  })

  it('migrates a v1 flat Plex-only config to v2 sources array', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        myshows_token: 'legacy_tok',
        plex_url: 'http://plex:32400',
        plex_token: 'plex_tok',
        port: 3000,
        plex_user_filter: ['legacy-user'],
        scrobble_percent: 85,
        poll_interval: 2500,
        log_level: 'info',
      }),
    )

    const cfg = readConfig()
    expect(cfg.sources).toHaveLength(1)
    expect(cfg.sources[0]).toMatchObject({
      type: 'plex',
      url: 'http://plex:32400',
      token: 'plex_tok',
      userFilter: ['legacy-user'],
      pollInterval: 2500,
    })

    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    expect(persisted.sources).toBeDefined()
    expect(persisted.sources[0].url).toBe('http://plex:32400')
  })
})
