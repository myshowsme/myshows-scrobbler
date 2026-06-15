#!/usr/bin/env node

import { createRequire } from 'node:module'
import { DEFAULT_PORT, requireMyShowsUrl, setConfigPath } from './config.js'
import { createAdapter } from './adapters/registry.js'
import { CliError, parseCliArgs } from './cli/args.js'
import { HELP_TEXT, versionText } from './cli/help.js'
import { validateConfig } from './cli/options.js'
import { maybeAutoDetectKodiCredentials } from './cli/kodi-credentials-detect.js'
import { maybeAutoDetectPlexToken } from './cli/plex-token-detect.js'
import { buildRuntimeContext } from './cli/runtime.js'
import { createServer, registerBuiltInAdapters } from './server.js'
import { listSetupActions, getSetupAction } from './setup/registry.js'
import { applySetup, restoreSetup } from './setup/runtime.js'
import { loadSnapshot } from './setup/snapshot-store.js'
import { Logger } from './logger.js'

const require = createRequire(import.meta.url)

function readPackageVersion(): string {
  for (const packagePath of ['../package.json', '../../package.json']) {
    try {
      return (require(packagePath) as { version: string }).version
    } catch {
      // Try the next layout: source tree first, packed dist/server second.
    }
  }

  return 'unknown'
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2))

  if (args.help) {
    console.log(HELP_TEXT)
    return
  }

  if (args.version) {
    console.log(versionText(readPackageVersion()))
    return
  }

  if (args.configPath) {
    setConfigPath(args.configPath)
  }

  let runtime = buildRuntimeContext(args)
  // If the user enabled Plex / Kodi but didn't supply a token, try the
  // local app's config (Plex `Preferences.xml` / Kodi `guisettings.xml`).
  // On success we re-build the runtime so the discovered token flows
  // everywhere (validation, checkSource probes, server adapters) without
  // a second wiring step.
  await Promise.all([
    maybeAutoDetectPlexToken(runtime.config, args),
    maybeAutoDetectKodiCredentials(runtime.config, args),
  ])
  if (args.sourceOverrides.plex?.token != null || args.sourceOverrides.kodi?.token != null) {
    runtime = buildRuntimeContext(args)
  }
  const config = runtime.config
  const issues = validateConfig(config)
  const errors = issues.filter((issue) => issue.level === 'error')

  if (args.checkConfig) {
    for (const issue of issues) {
      const stream = issue.level === 'error' ? console.error : console.warn
      stream(`${issue.level}: ${issue.message}`)
    }
    if (errors.length > 0) {
      process.exit(2)
    }
    console.log('Config OK')
    return
  }

  if (errors.length > 0) {
    for (const issue of errors) console.error(`error: ${issue.message}`)
    process.exit(2)
  }

  if (args.checkSources.length > 0) {
    registerBuiltInAdapters()
    const logger = new Logger(config.logLevel)
    let failed = false

    for (const sourceType of args.checkSources) {
      const source = config.sources.find((candidate) => candidate.type === sourceType)
      if (!source) {
        console.error(`${sourceType}: source is not configured`)
        failed = true
        continue
      }

      const adapter = createAdapter(source, {
        onScrobble: async () => {},
        onLog: (level, message) => logger.getLogFn()(level, message),
      })
      const ok = await adapter.checkConnection()
      console.log(`${sourceType}: ${ok ? 'OK' : 'FAIL'}`)
      if (!ok) {
        failed = true
      }
    }

    if (failed) {
      process.exit(3)
    }
    return
  }

  // ── One-click setup commands (registry populated via server.js import) ──

  if (args.listSetup) {
    for (const action of listSetupActions()) {
      const supported = (await action.isSupported()) ? 'supported' : 'unsupported'
      console.log(`${action.id}\t${action.player}\t${supported}\t${action.name}`)
    }
    return
  }

  if (args.runSetup) {
    const action = getSetupAction(args.runSetup)
    if (!action) {
      console.error(`Unknown setup action: ${args.runSetup} (try --list-setup)`)
      process.exit(2)
    }
    const changes = await action.diff()
    console.log(`Planned changes for "${action.id}":`)
    for (const change of changes) {
      console.log(
        `  ${change.target} :: ${change.property}: ${change.current ?? '(absent)'} -> ${change.next}`,
      )
    }
    try {
      const { snapshot, verified } = await applySetup(action)
      console.log(`Applied. Snapshot id: ${snapshot.id}`)
      console.log(
        `Verify: ${verified ? 'OK (endpoint reachable)' : 'not reachable yet — restart the player and retry'}`,
      )
      console.log(`Undo with: --undo-setup ${snapshot.id}`)
    } catch (err) {
      console.error(`Setup failed: ${(err as Error).message}`)
      process.exit(3)
    }
    return
  }

  if (args.undoSetup) {
    const snapshot = await loadSnapshot(args.undoSetup)
    if (!snapshot) {
      console.error(`Unknown snapshot: ${args.undoSetup}`)
      process.exit(2)
    }
    const action = getSetupAction(snapshot.actionId)
    if (!action) {
      console.error(`Action "${snapshot.actionId}" for this snapshot is no longer registered`)
      process.exit(2)
    }
    try {
      await restoreSetup(args.undoSetup, action)
      console.log(`Restored snapshot ${args.undoSetup} (${snapshot.actionId})`)
    } catch (err) {
      console.error(`Restore failed: ${(err as Error).message}`)
      process.exit(3)
    }
    return
  }

  requireMyShowsUrl(config)

  const { logger, config: serverConfig, start } = await createServer(runtime.serverOptions)

  try {
    await start()
    const effectiveInterceptOnly = args.interceptOnly || config.interceptOnly

    if (args.ui) {
      logger.info(`Web UI: http://localhost:${args.port ?? DEFAULT_PORT}`)
    } else {
      logger.info('Headless mode (use --ui to enable web interface)')
    }

    if (effectiveInterceptOnly) {
      logger.warn('Intercept-only mode: events will be logged but NOT sent to MyShows')
    }

    const enabledSources = serverConfig.sources.filter((s) => s.enabled)
    if (enabledSources.length === 0) {
      logger.warn('No sources configured. Open the web UI or edit data/config.json.')
    } else {
      for (const s of enabledSources) {
        logger.info(`${s.type}: polling every ${s.pollInterval}ms`)
      }
    }

    if (!effectiveInterceptOnly && !config.myshowsToken) {
      logger.warn('MyShows token not configured!')
    }
  } catch (err) {
    logger.error('Startup failed', err)
    process.exit(1)
  }
}

main().catch((err) => {
  if (err instanceof CliError) {
    console.error(`error: ${err.message}`)
    console.error('Run with --help for usage.')
    process.exit(2)
  }

  console.error(err)
  process.exit(1)
})
