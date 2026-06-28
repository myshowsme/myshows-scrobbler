import { parseArgs } from 'node:util'
import type { LogLevel, SourceType } from '../types.js'
import { isLocalSource, sourceNeedsUrl, SOURCE_TYPES as ALL_SOURCE_TYPES } from '../types.js'

// Derived from the canonical list in types.ts so new source types (mpc, mpv,
// iina, …) are accepted by --source / --check-source without a second edit here.
const SOURCE_TYPES = new Set<SourceType>(ALL_SOURCE_TYPES)
const LOG_LEVELS = new Set<LogLevel>(['debug', 'info', 'warn', 'error'])

export interface CliArgs {
  help: boolean
  version: boolean
  ui?: boolean
  interceptOnly?: boolean
  configPath?: string
  host?: string
  port?: number
  logLevel?: LogLevel
  myshowsToken?: string
  myshowsUrl?: string
  scrobblePercent?: number
  pollInterval?: number
  sources: SourceType[]
  sourceOverrides: Partial<Record<SourceType, { url?: string; token?: string }>>
  checkConfig: boolean
  checkSources: SourceType[]
  /** List registered one-click setup actions and exit. */
  listSetup: boolean
  /** Run the setup action with this id (applySetup) and exit. */
  runSetup?: string
  /** Restore the setup snapshot with this id (restoreSetup) and exit. */
  undoSetup?: string
}

export class CliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliError'
  }
}

function one(value: string | string[] | boolean | undefined, name: string): string | undefined {
  if (Array.isArray(value)) {
    return value.at(-1)
  }
  if (typeof value === 'string') {
    return value
  }
  if (value === true) {
    throw new CliError(`Missing value for --${name}`)
  }
  return undefined
}

function many(value: string | string[] | boolean | undefined, name: string): string[] {
  if (Array.isArray(value)) {
    return value
  }
  if (typeof value === 'string') {
    return [value]
  }
  if (value === true) {
    throw new CliError(`Missing value for --${name}`)
  }
  return []
}

function parseNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new CliError(`Invalid --${name}: ${value}`)
  }
  return parsed
}

function parsePort(value: string | undefined, source: string): number | undefined {
  const parsed = parseNumber(value, source)
  if (parsed === undefined) {
    return undefined
  }
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new CliError(`Invalid ${source}: expected port 1..65535`)
  }
  return parsed
}

function parsePercent(value: string | undefined): number | undefined {
  const parsed = parseNumber(value, 'scrobble-percent')
  if (parsed === undefined) {
    return undefined
  }
  if (parsed < 0 || parsed > 100) {
    throw new CliError('Invalid --scrobble-percent: expected 0..100')
  }
  return parsed
}

function parsePollInterval(value: string | undefined): number | undefined {
  const parsed = parseNumber(value, 'poll-interval')
  if (parsed === undefined) {
    return undefined
  }
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliError('Invalid --poll-interval: expected a positive integer')
  }
  return parsed
}

function parseSource(value: string, name: string): SourceType {
  if (!SOURCE_TYPES.has(value as SourceType)) {
    throw new CliError(`Invalid --${name}: ${value}`)
  }
  return value as SourceType
}

function parseLogLevel(value: string | undefined): LogLevel | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!LOG_LEVELS.has(value as LogLevel)) {
    throw new CliError(`Invalid --log-level: ${value}`)
  }
  return value as LogLevel
}

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  const { values } = parseArgs({
    args: argv,
    allowNegative: true,
    options: {
      'help': { type: 'boolean', short: 'h' },
      'version': { type: 'boolean', short: 'v' },
      'ui': { type: 'boolean' },
      'with-ui': { type: 'boolean' },
      'no-ui': { type: 'boolean' },
      'intercept-only': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'config': { type: 'string' },
      'host': { type: 'string' },
      'port': { type: 'string' },
      'log-level': { type: 'string' },
      'myshows-token': { type: 'string' },
      'myshows-url': { type: 'string' },
      'scrobble-percent': { type: 'string' },
      'poll-interval': { type: 'string' },
      'source': { type: 'string', multiple: true },
      'plex-url': { type: 'string' },
      'plex-token': { type: 'string' },
      'jellyfin-url': { type: 'string' },
      'jellyfin-token': { type: 'string' },
      'emby-url': { type: 'string' },
      'emby-token': { type: 'string' },
      'kodi-url': { type: 'string' },
      'kodi-token': { type: 'string' },
      'stremio-token': { type: 'string' }, // token-only: no --stremio-url
      'check-config': { type: 'boolean' },
      'check-source': { type: 'string', multiple: true },
      'list-setup': { type: 'boolean' },
      'run-setup': { type: 'string' },
      'undo-setup': { type: 'string' },
    },
  })

  const explicitUi = values.ui === true || values['with-ui'] === true
  const explicitNoUi = values['no-ui'] === true || values.ui === false
  if (explicitUi && explicitNoUi) {
    throw new CliError('Use either --ui or --no-ui, not both')
  }

  const port = parsePort(one(values.port, 'port') ?? env.PORT, env.PORT ? 'PORT' : '--port')
  const sources = many(values.source, 'source').map((value) => parseSource(value, 'source'))
  const checkSources = many(values['check-source'], 'check-source').map((value) =>
    parseSource(value, 'check-source'),
  )
  const explicitInterceptOnly = values['intercept-only'] === true || values['dry-run'] === true

  const sourceOverrides: CliArgs['sourceOverrides'] = {}
  const valuesRecord = values as Record<string, string | string[] | boolean | undefined>
  for (const source of SOURCE_TYPES) {
    // Local sources (e.g. process-scanning player) have no URL/token to override.
    if (isLocalSource(source)) {
      continue
    }
    // Token-only sources (Stremio) have no URL — only a token override.
    const url = sourceNeedsUrl(source)
      ? one(valuesRecord[`${source}-url`], `${source}-url`)
      : undefined
    const token = one(valuesRecord[`${source}-token`], `${source}-token`)
    if (url !== undefined || token !== undefined) {
      sourceOverrides[source] = { url, token }
    }
  }

  return {
    help: values.help === true,
    version: values.version === true,
    ui: explicitUi ? true : explicitNoUi ? false : undefined,
    interceptOnly: explicitInterceptOnly ? true : undefined,
    configPath: one(values.config, 'config') ?? env.CONFIG_PATH,
    host: one(values.host, 'host'),
    port,
    logLevel: parseLogLevel(one(values['log-level'], 'log-level')),
    myshowsToken: one(values['myshows-token'], 'myshows-token'),
    myshowsUrl: one(values['myshows-url'], 'myshows-url'),
    scrobblePercent: parsePercent(one(values['scrobble-percent'], 'scrobble-percent')),
    pollInterval: parsePollInterval(one(values['poll-interval'], 'poll-interval')),
    sources,
    sourceOverrides,
    checkConfig: values['check-config'] === true,
    checkSources,
    listSetup: values['list-setup'] === true,
    runSetup: one(values['run-setup'], 'run-setup'),
    undoSetup: one(values['undo-setup'], 'undo-setup'),
  }
}
