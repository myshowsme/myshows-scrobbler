import type { SourceConfig, SourceType, AdapterCallbacks } from '../types.js'
import { BaseAdapter } from './base.js'

type AdapterConstructor = new (config: SourceConfig, callbacks: AdapterCallbacks) => BaseAdapter

const ADAPTERS = new Map<SourceType, AdapterConstructor>()

export function registerAdapter(type: SourceType, ctor: AdapterConstructor): void {
  ADAPTERS.set(type, ctor)
}

export function createAdapter(config: SourceConfig, callbacks: AdapterCallbacks): BaseAdapter {
  const AdapterClass = ADAPTERS.get(config.type)
  if (!AdapterClass) {
    throw new Error(`Unknown source type: ${config.type}`)
  }
  return new AdapterClass(config, callbacks)
}

export function getRegisteredTypes(): SourceType[] {
  return [...ADAPTERS.keys()]
}

export function hasAdapter(type: SourceType): boolean {
  return ADAPTERS.has(type)
}
