import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SetupAction, SetupChange } from '../types.js'
import {
  IINA_DOMAIN,
  ADVANCED_KEY,
  USER_OPTIONS_KEY,
  readIinaPrefs,
  getOption,
  upsertOption,
  removeOption,
  setAdvancedEnabled,
  deleteKey,
  writeUserOptions,
} from '../helpers/iina-prefs.js'
import { IINA_DEFAULT_SOCKET } from '../../adapters/iina-ipc.js'
import { scanPlayers } from '../../utils/process-monitor.js'
import { queryMpvProperties } from '../../utils/mpv-ipc.js'

/**
 * IINA "enable JSON IPC" one-click setup action.
 *
 * IINA has no AppleScript bridge (unlike VLC/QuickTime, which the `player`
 * adapter reads directly), so the only way to get exact position/pause/seek
 * from it is its embedded mpv's JSON IPC. This action enables that by writing
 * the mpv option into IINA's prefs:
 *
 *   enableAdvancedSettings = true
 *   userOptions += ["input-ipc-server", "/tmp/iina-myshows.sock"]
 *
 * The same socket is what `IinaIpcAdapter` connects to. Flow: apply → restart
 * IINA → enable the `iina` source. Reversible.
 *
 * IINA persists its prefs to disk on quit, so it must be closed while we write
 * (the guard enforces it) — otherwise it overwrites the change on exit.
 */

const IPC_KEY = 'input-ipc-server'

async function iinaInstalled(): Promise<boolean> {
  const candidates = ['/Applications/IINA.app', path.join(os.homedir(), 'Applications', 'IINA.app')]
  for (const candidate of candidates) {
    try {
      await fs.access(candidate)
      return true
    } catch {
      // Try the next location.
    }
  }
  return false
}

/**
 * Apply a set of changes to IINA's prefs, merging into whatever is already
 * there so unrelated advanced options / mpv overrides survive. Shared by
 * `apply` and `restore` — restore just feeds the swapped (previous) changes.
 */
async function applyIinaChanges(changes: SetupChange[]): Promise<void> {
  const prefs = await readIinaPrefs()
  let options = prefs.userOptions

  for (const change of changes) {
    if (change.property === ADVANCED_KEY) {
      if (change.next === null) {
        await deleteKey(ADVANCED_KEY)
      } else {
        await setAdvancedEnabled(change.next === 'true' || change.next === '1')
      }
      continue
    }
    // Any other property is an mpv option override keyed by its option name.
    if (change.next === null) {
      options = removeOption(options, change.property)
    } else {
      options = upsertOption(options, change.property, String(change.next))
    }
  }

  await writeUserOptions(options)
}

export const iinaIpcSetupAction: SetupAction = {
  id: 'iina-ipc',
  player: 'iina',
  name: 'IINA JSON IPC',
  description: 'Enable IINA JSON IPC for exact position tracking.',

  async isSupported() {
    return process.platform === 'darwin' && (await iinaInstalled())
  },

  async guard() {
    const { processes } = await scanPlayers()
    const running = processes.some((proc) => proc.player === 'iina')
    if (running) {
      return {
        blocked: true,
        reasonCode: 'player-running',
        reason:
          'Close IINA before applying — it overwrites its settings on exit. Reopen it afterwards.',
      }
    }
    return { blocked: false }
  },

  async diff(): Promise<SetupChange[]> {
    const prefs = await readIinaPrefs()
    return [
      {
        kind: 'macos-defaults',
        target: `${IINA_DOMAIN} › ${ADVANCED_KEY}`,
        property: ADVANCED_KEY,
        current: prefs.advancedPresent ? (prefs.advancedEnabled ? 'true' : 'false') : null,
        next: 'true',
      },
      {
        kind: 'macos-defaults',
        target: `${IINA_DOMAIN} › ${USER_OPTIONS_KEY}`,
        property: IPC_KEY,
        current: getOption(prefs.userOptions, IPC_KEY),
        next: IINA_DEFAULT_SOCKET,
      },
    ]
  },

  async apply(changes: SetupChange[]): Promise<void> {
    await applyIinaChanges(changes)
  },

  async restore(previous: SetupChange[]): Promise<void> {
    await applyIinaChanges(previous)
  },

  async verify(): Promise<boolean> {
    // Only true once IINA has been restarted and opened the socket — typically
    // false right after apply (expected). The UI polls verify() until it flips.
    const props = await queryMpvProperties(IINA_DEFAULT_SOCKET, 1000)
    return props !== null
  },
}
