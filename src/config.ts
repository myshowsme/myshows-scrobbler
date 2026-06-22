import fs from 'node:fs'
import path from 'node:path'
import { info, error as logError } from './logger.js'
import type {
  AppConfig,
  SourceConfig,
  LegacyConfig,
  RawConfig,
  RawSourceConfig,
  LogLevel,
} from './types.js'

let configPath = process.env.CONFIG_PATH || './data/config.json'

export function setConfigPath(p: string): void {
  configPath = p
}

export function getConfigPath(): string {
  return configPath
}

// ── Defaults ──

export const DEFAULT_PORT = 5172
export const DEFAULT_MYSHOWS_URL = 'https://myshows.me/scrobble'
export const DEFAULT_SOURCE_POLL_INTERVAL = 15000
export const SERVICE_REQUEST_TIMEOUT_MS = 5000

export const DEFAULT_MIN_DURATION_MINUTES = 5
export const DEFAULT_STOP_AT_THRESHOLD = true

const DEFAULT_CONFIG: AppConfig = {
  myshowsToken: '',
  myshowsUrl: DEFAULT_MYSHOWS_URL,
  scrobblePercent: 80,
  minDurationMinutes: DEFAULT_MIN_DURATION_MINUTES,
  stopAtThreshold: DEFAULT_STOP_AT_THRESHOLD,
  logLevel: 'info',
  interceptOnly: false,
  sources: [],
}

/** Coerce a possibly-garbage `min_duration_minutes` value to a sane number. */
function normalizeMinDuration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return DEFAULT_MIN_DURATION_MINUTES
  }
  return value
}

const DEFAULT_SOURCE: Omit<SourceConfig, 'type'> = {
  enabled: true,
  url: '',
  token: '',
  pollInterval: DEFAULT_SOURCE_POLL_INTERVAL,
  userFilter: [],
}

function normalizeSourceUrl(url: string | undefined): string {
  return (url ?? '').trim().replace(/\/+$/, '')
}

// ── snake_case <-> camelCase conversion ──

function rawSourceToConfig(raw: RawSourceConfig): SourceConfig {
  return {
    type: raw.type,
    enabled: raw.enabled ?? true,
    url: normalizeSourceUrl(raw.url),
    token: raw.token ?? '',
    pollInterval: raw.poll_interval ?? DEFAULT_SOURCE.pollInterval,
    userFilter: raw.user_filter ?? [],
  }
}

function configSourceToRaw(src: SourceConfig): RawSourceConfig {
  return {
    type: src.type,
    enabled: src.enabled,
    url: normalizeSourceUrl(src.url),
    token: src.token,
    poll_interval: src.pollInterval,
    user_filter: src.userFilter,
  }
}

function rawToConfig(raw: RawConfig): AppConfig {
  return {
    myshowsToken: raw.myshows_token ?? '',
    myshowsUrl: raw.myshows_url ?? DEFAULT_MYSHOWS_URL,
    scrobblePercent: raw.scrobble_percent ?? DEFAULT_CONFIG.scrobblePercent,
    minDurationMinutes: normalizeMinDuration(raw.min_duration_minutes),
    stopAtThreshold:
      typeof raw.stop_at_threshold === 'boolean'
        ? raw.stop_at_threshold
        : DEFAULT_CONFIG.stopAtThreshold,
    logLevel: (raw.log_level as LogLevel) ?? DEFAULT_CONFIG.logLevel,
    interceptOnly: raw.intercept_only ?? false,
    sources: (raw.sources ?? []).map(rawSourceToConfig),
  }
}

function configToRaw(config: AppConfig): RawConfig {
  return {
    myshows_token: config.myshowsToken,
    ...(config.myshowsUrl ? { myshows_url: config.myshowsUrl } : {}),
    scrobble_percent: config.scrobblePercent,
    min_duration_minutes: config.minDurationMinutes,
    stop_at_threshold: config.stopAtThreshold,
    log_level: config.logLevel,
    intercept_only: config.interceptOnly,
    sources: config.sources.map(configSourceToRaw),
  }
}

// ── Legacy migration (v1 flat plex config -> v2 sources array) ──

function migrateLegacy(data: LegacyConfig & Partial<RawConfig>): RawConfig {
  if (data.sources && Array.isArray(data.sources)) {
    return data as RawConfig
  }

  const raw: RawConfig = {
    myshows_token: data.myshows_token ?? '',
    ...(data.myshows_url ? { myshows_url: data.myshows_url } : {}),
    scrobble_percent: data.scrobble_percent ?? DEFAULT_CONFIG.scrobblePercent,
    min_duration_minutes: data.min_duration_minutes ?? DEFAULT_CONFIG.minDurationMinutes,
    stop_at_threshold: data.stop_at_threshold ?? DEFAULT_CONFIG.stopAtThreshold,
    log_level: data.log_level ?? DEFAULT_CONFIG.logLevel,
    sources: [],
  }

  if (data.plex_url || data.plex_token) {
    raw.sources.push({
      type: 'plex',
      enabled: true,
      url: normalizeSourceUrl(data.plex_url),
      token: data.plex_token ?? '',
      poll_interval: data.poll_interval ?? DEFAULT_SOURCE.pollInterval,
      user_filter: data.plex_user_filter ?? [],
    })
  }

  return raw
}

// ── Public API ──

export function readConfig(): AppConfig {
  try {
    if (!fs.existsSync(configPath)) {
      const dir = path.dirname(configPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      writeConfig(DEFAULT_CONFIG)
      return { ...DEFAULT_CONFIG }
    }

    const data = fs.readFileSync(configPath, 'utf8')
    const parsed = JSON.parse(data) as LegacyConfig & Partial<RawConfig>

    const raw = migrateLegacy(parsed)

    // If migration occurred (legacy had no sources), persist the new format
    if (!parsed.sources && raw.sources.length > 0) {
      info('Config migrated from v1 (Plex-only) to v2 (multi-source)')
      fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), 'utf8')
    }

    return rawToConfig(raw)
  } catch (err) {
    logError(`Config read error: ${(err as Error).message}`)
    return { ...DEFAULT_CONFIG }
  }
}

export function requireMyShowsUrl(config: AppConfig): string {
  const myshowsUrl = config.myshowsUrl?.trim()
  if (!myshowsUrl) {
    throw new Error('Config error: myshows_url is required')
  }
  return myshowsUrl
}

export function writeConfig(config: AppConfig): boolean {
  try {
    const dir = path.dirname(configPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    const raw = configToRaw(config)
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), 'utf8')
    info('Config saved')
    return true
  } catch (err) {
    logError(`Config write error: ${(err as Error).message}`)
    return false
  }
}
