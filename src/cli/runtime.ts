import { readConfig } from '../config.js'
import type { ServerOptions } from '../server.js'
import type { AppConfig } from '../types.js'
import type { CliArgs } from './args.js'
import { hasCliConfigOverrides, mergeCliConfig } from './options.js'

export interface RuntimeContext {
  config: AppConfig
  hasConfigOverrides: boolean
  resolveConfig: () => AppConfig
  serverOptions: ServerOptions
}

export function buildRuntimeContext(args: CliArgs): RuntimeContext {
  const hasConfigOverrides = hasCliConfigOverrides(args)
  const resolveConfig = () => {
    const fileConfig = readConfig()
    return hasConfigOverrides ? mergeCliConfig(fileConfig, args) : fileConfig
  }
  const config = resolveConfig()

  return {
    config,
    hasConfigOverrides,
    resolveConfig,
    serverOptions: {
      ui: args.ui ?? false,
      interceptOnly: args.interceptOnly,
      configPath: args.configPath,
      port: args.port,
      host: args.host,
      configProvider: hasConfigOverrides ? resolveConfig : undefined,
    },
  }
}
