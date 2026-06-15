import { readConfig, writeConfig, DEFAULT_SOURCE_POLL_INTERVAL } from '../config.js'
import type { Logger } from '../logger.js'
import { listSetupActions } from '../setup/registry.js'
import type { SetupAction, SetupChange } from '../setup/types.js'
import type { SourceType } from '../types.js'

/**
 * For every setup-action that's already applied (vlcrc / mpv conf / etc.
 * carry the changes), make sure the matching source row is enabled in
 * config. Covers the user who enabled a player's API in a previous install,
 * then nuked userData while the player config on disk kept the change.
 * Idempotent; doesn't touch URL/token (meaningless for local players).
 */
export async function bootstrapSourcesForAppliedSetups(logger: Logger): Promise<void> {
  for (const action of listSetupActions()) {
    if (!(await isAppliedSafely(action))) {
      continue
    }
    const sourceType = action.player as SourceType
    const config = readConfig()
    const existing = config.sources.find((s) => s.type === sourceType)
    if (existing?.enabled) {
      continue
    }
    const updated = existing
      ? config.sources.map((s) => (s.type === sourceType ? { ...s, enabled: true } : s))
      : [
          ...config.sources,
          {
            type: sourceType,
            enabled: true,
            url: '',
            token: '',
            pollInterval: DEFAULT_SOURCE_POLL_INTERVAL,
            userFilter: [],
          },
        ]
    writeConfig({ ...config, sources: updated })
    logger.info(`Setup: enabled ${sourceType} source (${action.id} already applied)`)
  }
}

/**
 * Mirrors api.ts isApplied, with one extra rule: an empty diff does NOT
 * count as applied. That's what an unsupported/no-op action returns, and
 * treating it as applied would enable sources on platforms that can't run
 * the player API. Errors also count as not applied, so a broken action
 * can't block the rest of the bootstrap.
 */
async function isAppliedSafely(action: SetupAction): Promise<boolean> {
  try {
    const changes = await action.diff()
    return changes.length > 0 && changes.every((c: SetupChange) => c.current === c.next)
  } catch {
    return false
  }
}
