import type { SetupAction } from './types.js'

/**
 * Registry of available setup actions. Symmetric with `adapters/registry.ts` —
 * actions are registered at module-load time by their owning package and
 * looked up by stable id from HTTP routes / UI.
 */

const actions = new Map<string, SetupAction>()

export function registerSetupAction(action: SetupAction): void {
  if (actions.has(action.id)) {
    throw new Error(`Setup action already registered: ${action.id}`)
  }
  actions.set(action.id, action)
}

export function getSetupAction(id: string): SetupAction | undefined {
  return actions.get(id)
}

export function listSetupActions(): SetupAction[] {
  return [...actions.values()]
}

/** Test-only: wipe the registry between cases. */
export function clearSetupActions(): void {
  actions.clear()
}
