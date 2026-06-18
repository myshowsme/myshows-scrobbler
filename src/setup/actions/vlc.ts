import { randomBytes } from 'node:crypto'
import type { SetupAction, SetupChange, PlayerGuardResult } from '../types.js'
import { readIni, getIniValue, writeIniValue, deleteIniValue } from '../helpers/ini-file.js'
import {
  resolveVlcrcPath,
  buildVlcAuthHeader,
  VLCRC_SECTION_CORE,
  VLCRC_SECTION_LUA,
  VLCRC_KEY_EXTRAINTF,
  VLCRC_KEY_HOST,
  VLCRC_KEY_PORT,
  VLCRC_KEY_PASSWORD,
  VLCRC_DEFAULT_HOST,
  VLCRC_DEFAULT_PORT,
} from '../helpers/vlcrc-path.js'
import { scanPlayers } from '../../utils/process-monitor.js'

/**
 * VLC "enable HTTP interface" one-click setup action.
 *
 * VLC ships with a built-in HTTP API. Turning it on requires writing four
 * keys to VLC's text INI config `vlcrc`:
 *
 *   [core]
 *     extraintf=http
 *     http-host=127.0.0.1
 *     http-port=8080
 *   [lua]
 *     http-password=<random>
 *
 * Section name is `[core]`, NOT `[main]` — verified by reading what VLC
 * itself writes after enabling Web interface through its Preferences UI. An
 * earlier draft wrote to `[main]`; VLC silently ignored it because that
 * section doesn't exist in its schema. The Qt UI ships its own `[qt]`
 * section; "main settings" live under `[core]` (see `[core] # core program`
 * in any vlcrc).
 *
 * `http-host` and `http-port` are required even though VLC documents 8080
 * as the default — left unset, the lua HTTP interface refuses to bind
 * (verified by `Test-NetConnection 127.0.0.1 -Port 8080` failing with only
 * `extraintf=http` set; passes once host/port are explicit).
 *
 * On apply we generate a fresh random password — there's no shared secret
 * to leak between users. The `VlcHttpAdapter` re-reads vlcrc at startup to
 * pull the same password, so the user never has to copy it anywhere.
 *
 * vlcrc path + section/key names + auth header live in
 * `setup/helpers/vlcrc-path.ts` so both this action and the adapter share
 * one source of truth.
 */

const PASSWORD_BYTES = 18 // → 24-char base64url, plenty for HTTP basic auth

// Re-export so downstream callers (UI types generator, tests) keep a stable
// import surface from the action module.
export { resolveVlcrcPath }

/**
 * Merge `http` into VLC's comma-separated `extraintf` list. Returns the value
 * to write. Preserves whatever the user already had (e.g. `qt,oldrc`) so the
 * Qt UI doesn't disappear when we enable the HTTP interface — a common gotcha
 * if you just overwrite the field with `http`.
 */
export function ensureHttpInExtraIntf(current: string | null): string {
  const tokens = (current ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  if (tokens.includes('http')) {
    return tokens.join(',')
  }
  return tokens.concat('http').join(',')
}

function generatePassword(): string {
  return randomBytes(PASSWORD_BYTES).toString('base64url')
}

export const vlcHttpInterfaceAction: SetupAction = {
  id: 'vlc-http-interface',
  player: 'vlc',
  name: 'VLC Web Interface',
  description: 'Enable VLC HTTP interface for exact position tracking.',

  async isSupported() {
    // vlcrc-based config works the same on Windows, macOS, Linux.
    return true
  },

  async guard(): Promise<PlayerGuardResult> {
    // VLC rewrites vlcrc whenever the user closes Preferences dialog with
    // changes pending, and on some platforms also on quit. To avoid that
    // races with our write, refuse to apply while VLC is open — same policy
    // as MPC, much more conservative than mpv (mpv never rewrites its conf).
    const snapshot = await scanPlayers()
    const isRunning = snapshot.processes.some((proc) => proc.player === 'vlc')
    if (isRunning) {
      return {
        blocked: true,
        reasonCode: 'player-running',
        reason: 'Close VLC before changing settings — it may overwrite our changes on exit.',
      }
    }
    return { blocked: false }
  },

  async diff(): Promise<SetupChange[]> {
    const confPath = resolveVlcrcPath()
    const read = await readIni(confPath)

    const currentExtraIntf = read
      ? getIniValue(read, VLCRC_SECTION_CORE, VLCRC_KEY_EXTRAINTF)
      : null
    const currentHost = read ? getIniValue(read, VLCRC_SECTION_CORE, VLCRC_KEY_HOST) : null
    const currentPort = read ? getIniValue(read, VLCRC_SECTION_CORE, VLCRC_KEY_PORT) : null
    const currentPassword = read ? getIniValue(read, VLCRC_SECTION_LUA, VLCRC_KEY_PASSWORD) : null

    // Keep an existing password rather than rotating on every diff — otherwise
    // isApplied (derived from current===next per entry) would never be true,
    // and the UI would show the action as "not applied" forever.
    const nextPassword = currentPassword ?? generatePassword()

    return [
      {
        kind: 'ini-file',
        target: confPath,
        property: encodePropertyRef(VLCRC_SECTION_CORE, VLCRC_KEY_EXTRAINTF),
        current: currentExtraIntf,
        next: ensureHttpInExtraIntf(currentExtraIntf),
      },
      {
        kind: 'ini-file',
        target: confPath,
        property: encodePropertyRef(VLCRC_SECTION_CORE, VLCRC_KEY_HOST),
        current: currentHost,
        next: VLCRC_DEFAULT_HOST,
      },
      {
        kind: 'ini-file',
        target: confPath,
        property: encodePropertyRef(VLCRC_SECTION_CORE, VLCRC_KEY_PORT),
        current: currentPort,
        next: VLCRC_DEFAULT_PORT,
      },
      {
        kind: 'ini-file',
        target: confPath,
        property: encodePropertyRef(VLCRC_SECTION_LUA, VLCRC_KEY_PASSWORD),
        current: currentPassword,
        next: nextPassword,
      },
    ]
  },

  // apply and restore both walk the change list and either delete (next is
  // null) or write the value. Single helper avoids two near-identical loops
  // drifting apart (an earlier version diverged on `==` vs `===` for the
  // null check).
  async apply(changes: SetupChange[]): Promise<void> {
    await writeIniChanges(changes)
  },

  async restore(previous: SetupChange[]): Promise<void> {
    await writeIniChanges(previous)
  },

  async verify(): Promise<boolean> {
    // Read the password we just wrote (or the one already there) and probe
    // VLC's default endpoint. We don't read host/port from vlcrc because we
    // never wrote them — VLC defaults to 127.0.0.1:8080 and that's what the
    // adapter polls.
    const confPath = resolveVlcrcPath()
    const read = await readIni(confPath)
    if (!read) {
      return false
    }
    const password = getIniValue(read, VLCRC_SECTION_LUA, VLCRC_KEY_PASSWORD) ?? ''
    try {
      const res = await fetch('http://127.0.0.1:8080/requests/status.json', {
        headers: { Authorization: buildVlcAuthHeader(password) },
        signal: AbortSignal.timeout(1000),
      })
      return res.ok
    } catch {
      return false
    }
  },
}

async function writeIniChanges(changes: SetupChange[]): Promise<void> {
  for (const change of changes) {
    const { section, key } = parsePropertyRef(change.property)
    if (change.next === null) {
      await deleteIniValue(change.target, section, key)
      continue
    }
    await writeIniValue(change.target, section, key, String(change.next))
  }
}

function encodePropertyRef(section: string, key: string): string {
  return `[${section}] ${key}`
}

/**
 * The `property` field on each `SetupChange` for VLC carries both the INI
 * section and the key, formatted as `[section] key`. Splitting at apply /
 * restore time keeps SetupChange flat (one entry per property) while still
 * routing each write to the right INI section.
 */
function parsePropertyRef(ref: string): { section: string; key: string } {
  const match = /^\[([^\]]+)\]\s+(.+)$/.exec(ref)
  if (!match) {
    throw new Error(`vlc setup: malformed property reference "${ref}" (expected "[section] key")`)
  }
  return { section: match[1], key: match[2] }
}
