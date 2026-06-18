import type { SetupAction, SetupChange, PlayerGuardResult } from '../types.js'
import {
  readRegistryValue,
  writeRegistryValue,
  deleteRegistryValue,
} from '../helpers/windows-registry.js'
import { scanPlayers } from '../../utils/process-monitor.js'

/**
 * MPC-HC / MPC-BE "Web Interface" one-click setup actions.
 *
 * MPC stores its preferences under HKCU. Flipping `EnableWebServer=1` and
 * pinning `WebServerPort=13579` is enough to bring up the public HTTP API
 * the `mpc` source-type adapter polls. The same shape of change applies to
 * both forks — they only differ in registry root path — so the apply /
 * restore / diff / verify logic is shared and parameterised by the
 * registry key.
 *
 * Verification uses the same `/variables.html` endpoint the adapter polls,
 * which doubles as proof the setup actually worked end-to-end.
 */

// Registry layouts diverge between the forks (verified against a real
// MPC-HC 2.x and MPC-BE 1.8.9 install):
//   MPC-HC keeps everything flat under  ...\MPC-HC\MPC-HC\Settings  with
//                                       EnableWebServer + WebServerPort.
//   MPC-BE splits features into subkeys; the web server lives at
//                                       ...\MPC-BE\WebServer
//                                       with EnableWebServer + Port (no prefix).
// Writing to the wrong key or value name creates phantom values the player
// never reads. Both forks share the `EnableWebServer` value name; only the
// port property differs (per variant.portProperty).
const MPC_HC_KEY = 'HKCU\\Software\\MPC-HC\\MPC-HC\\Settings'
const MPC_BE_KEY = 'HKCU\\Software\\MPC-BE\\WebServer'

const TARGET_PORT = 13579
const ENABLE_VALUE = 1
const ENABLE_PROPERTY = 'EnableWebServer'
const VERIFY_URL = 'http://127.0.0.1:13579/variables.html'
const VERIFY_TIMEOUT_MS = 1000

/**
 * Internal factory that produces a SetupAction for a given MPC variant.
 * Keeping the variant-specific bits in one config object makes the diff
 * between the two exports tiny — only the registry key and human label.
 */
interface MpcVariant {
  id: string
  name: string
  description: string
  registryKey: string
  /** Value name for the port. MPC-HC: `WebServerPort`; MPC-BE: `Port`. */
  portProperty: string
  /** Matches THIS fork's exe in a process command line. Both MPC-HC and MPC-BE
   *  classify as player 'mpc' in the process scan, so the guard needs the exe
   *  signature to avoid one fork blocking the other's setup. */
  processPattern: RegExp
}

function buildMpcAction(variant: MpcVariant): SetupAction {
  return {
    id: variant.id,
    player: 'mpc',
    name: variant.name,
    description: variant.description,

    async isSupported() {
      return process.platform === 'win32'
    },

    async guard(): Promise<PlayerGuardResult> {
      // MPC writes the on-disk copy of HKCU values on exit, so any change we
      // make while it's running gets clobbered. Refuse to apply until it's
      // closed — the message matches the strategy doc's wording for the
      // not-while-running principle.
      const snapshot = await scanPlayers()
      const isRunning = snapshot.processes.some(
        (proc) => proc.player === 'mpc' && variant.processPattern.test(proc.commandLine),
      )
      if (isRunning) {
        return {
          blocked: true,
          reasonCode: 'player-running',
          reason: `Close ${variant.name.replace(' Web Interface', '')} before changing settings — it will overwrite our changes on exit.`,
        }
      }
      return { blocked: false }
    },

    async diff(): Promise<SetupChange[]> {
      const currentEnable = await readRegistryValue(variant.registryKey, ENABLE_PROPERTY)
      const currentPort = await readRegistryValue(variant.registryKey, variant.portProperty)
      return [
        {
          kind: 'windows-registry',
          target: variant.registryKey,
          property: ENABLE_PROPERTY,
          current: currentEnable?.value ?? null,
          next: ENABLE_VALUE,
        },
        {
          kind: 'windows-registry',
          target: variant.registryKey,
          property: variant.portProperty,
          current: currentPort?.value ?? null,
          next: TARGET_PORT,
        },
      ]
    },

    async apply(changes: SetupChange[]): Promise<void> {
      for (const change of changes) {
        // `next === null` here would mean "delete during apply", which we
        // never do for MPC — but guard against it anyway so a future code
        // path that passes a fabricated change list can't accidentally
        // create a null DWORD.
        if (change.next == null) {
          await deleteRegistryValue(change.target, change.property)
          continue
        }
        await writeRegistryValue(change.target, change.property, 'REG_DWORD', change.next as number)
      }
    },

    async restore(previous: SetupChange[]): Promise<void> {
      for (const change of previous) {
        if (change.next === null) {
          // Value didn't exist before we applied — delete to bit-exact
          // restore (vs. leaving an explicit `0` that wasn't there).
          await deleteRegistryValue(change.target, change.property)
          continue
        }
        await writeRegistryValue(change.target, change.property, 'REG_DWORD', change.next as number)
      }
    },

    async verify(): Promise<boolean> {
      try {
        const res = await fetch(VERIFY_URL, { signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) })
        return res.ok
      } catch {
        return false
      }
    },
  }
}

export const mpcHcWebInterfaceAction: SetupAction = buildMpcAction({
  id: 'mpc-hc-web-interface',
  name: 'MPC-HC Web Interface',
  description: 'Enable MPC-HC web interface for exact position tracking.',
  registryKey: MPC_HC_KEY,
  portProperty: 'WebServerPort',
  processPattern: /mpc-hc/i,
})

export const mpcBeWebInterfaceAction: SetupAction = buildMpcAction({
  id: 'mpc-be-web-interface',
  name: 'MPC-BE Web Interface',
  description: 'Enable MPC-BE web interface for exact position tracking.',
  registryKey: MPC_BE_KEY,
  portProperty: 'Port',
  processPattern: /mpc-be/i,
})
