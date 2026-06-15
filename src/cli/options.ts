import type { AppConfig, SourceConfig, SourceType } from '../types.js'
import { SOURCE_TYPES, isLocalSource } from '../types.js'
import { DEFAULT_SOURCE_POLL_INTERVAL } from '../config.js'
import type { CliArgs } from './args.js'

function defaultSource(type: SourceType): SourceConfig {
  return {
    type,
    enabled: true,
    url: '',
    token: '',
    pollInterval: DEFAULT_SOURCE_POLL_INTERVAL,
    userFilter: [],
  }
}

function ensureSource(config: AppConfig, type: SourceType): SourceConfig {
  const existing = config.sources.find((source) => source.type === type)
  if (existing) {
    return existing
  }

  const source = defaultSource(type)
  config.sources.push(source)
  return source
}

export function mergeCliConfig(config: AppConfig, args: CliArgs): AppConfig {
  const next: AppConfig = {
    ...config,
    sources: config.sources.map((source) => ({ ...source, userFilter: [...source.userFilter] })),
  }

  if (args.interceptOnly !== undefined) {
    next.interceptOnly = args.interceptOnly
  }
  if (args.logLevel !== undefined) {
    next.logLevel = args.logLevel
  }
  if (args.myshowsToken !== undefined) {
    next.myshowsToken = args.myshowsToken
  }
  if (args.myshowsUrl !== undefined) {
    next.myshowsUrl = args.myshowsUrl
  }
  if (args.scrobblePercent !== undefined) {
    next.scrobblePercent = args.scrobblePercent
  }

  for (const type of args.sources) {
    ensureSource(next, type).enabled = true
  }

  for (const type of SOURCE_TYPES) {
    const override = args.sourceOverrides[type]
    if (!override) {
      continue
    }

    const source = ensureSource(next, type)
    source.enabled = true
    if (override.url !== undefined) {
      source.url = override.url.trim().replace(/\/+$/, '')
    }
    if (override.token !== undefined) {
      source.token = override.token
    }
  }

  if (args.pollInterval !== undefined) {
    const touchedTypes = new Set<SourceType>([
      ...args.sources,
      ...(Object.keys(args.sourceOverrides) as SourceType[]),
    ])
    const targets =
      touchedTypes.size > 0
        ? next.sources.filter((source) => touchedTypes.has(source.type))
        : next.sources

    for (const source of targets) {
      source.pollInterval = args.pollInterval
    }
  }

  return next
}

export function hasCliConfigOverrides(args: CliArgs): boolean {
  return (
    args.interceptOnly !== undefined ||
    args.logLevel !== undefined ||
    args.myshowsToken !== undefined ||
    args.myshowsUrl !== undefined ||
    args.scrobblePercent !== undefined ||
    args.pollInterval !== undefined ||
    args.sources.length > 0 ||
    Object.keys(args.sourceOverrides).length > 0
  )
}

export interface ConfigValidationIssue {
  level: 'error' | 'warning'
  message: string
}

export function validateConfig(config: AppConfig): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = []

  if (!config.myshowsUrl?.trim()) {
    issues.push({ level: 'error', message: 'myshows_url is required' })
  }

  if (config.scrobblePercent < 0 || config.scrobblePercent > 100) {
    issues.push({ level: 'error', message: 'scrobble_percent must be 0..100' })
  }

  for (const source of config.sources) {
    if (!SOURCE_TYPES.includes(source.type)) {
      // Unknown types should not crash startup — they can appear in a stale config
      // after an adapter was renamed or removed. The server skips them at runtime.
      issues.push({ level: 'warning', message: `Unknown source type: ${source.type} (skipped)` })
      continue
    }
    // Local sources (e.g. process-scanning `player`) take no URL/token.
    if (source.enabled && !isLocalSource(source.type) && !source.url.trim()) {
      issues.push({ level: 'warning', message: `${source.type}: url is empty` })
    }
    if (source.enabled && source.pollInterval < 1) {
      issues.push({ level: 'error', message: `${source.type}: poll_interval must be positive` })
    }
  }

  return issues
}
