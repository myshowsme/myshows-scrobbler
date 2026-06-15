import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

/**
 * Windows registry read/write/delete via the built-in `reg.exe`. No FFI,
 * no PowerShell — `reg.exe` ships with Windows since NT and is always on PATH.
 *
 * The helpers validate keys/value names with conservative regexes before
 * interpolating them into the command line. This is *defense in depth*:
 * callers should only ever pass hard-coded constants for keys/value names
 * (we're writing to specific player configs, not arbitrary user input),
 * but the validation makes shell injection impossible if that contract ever
 * weakens.
 */

const VALID_KEY = /^HK(?:CU|LM|CR|U|CC)\\[A-Za-z0-9 \\_\-.]+$/
const VALID_VALUE_NAME = /^[A-Za-z0-9_-]+$/

function assertSafeKey(key: string): void {
  if (!VALID_KEY.test(key)) {
    throw new Error(`Unsafe registry key: ${key}`)
  }
}

function assertSafeValueName(name: string): void {
  if (!VALID_VALUE_NAME.test(name)) {
    throw new Error(`Unsafe registry value name: ${name}`)
  }
}

export type RegType = 'REG_DWORD' | 'REG_SZ' | 'REG_BINARY'

export interface RegistryRead {
  type: RegType
  value: string | number
}

/**
 * Read a single registry value. Returns `null` when the key or value doesn't
 * exist (reg.exe returns non-zero in both cases — we collapse both to "absent"
 * because the setup framework needs that as a normal state, not an error).
 */
export async function readRegistryValue(key: string, name: string): Promise<RegistryRead | null> {
  if (process.platform !== 'win32') {
    return null
  }
  assertSafeKey(key)
  assertSafeValueName(name)
  try {
    const { stdout } = await execAsync(`reg query "${key}" /v ${name}`, {
      timeout: 4000,
      windowsHide: true,
    })
    // reg.exe output:
    //   <indent>ValueName    REG_DWORD    0x1
    //   <indent>ValueName    REG_SZ       Some string
    const pattern = new RegExp(`\\b${name}\\s+(REG_\\w+)\\s+(.+?)\\s*$`, 'm')
    const m = pattern.exec(stdout)
    if (!m) {
      return null
    }
    const type = m[1] as RegType
    const raw = m[2]
    if (type === 'REG_DWORD') {
      return { type, value: parseInt(raw, 16) }
    }
    return { type, value: raw }
  } catch {
    return null
  }
}

export async function writeRegistryValue(
  key: string,
  name: string,
  type: RegType,
  value: string | number,
): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('writeRegistryValue: Windows-only')
  }
  assertSafeKey(key)
  assertSafeValueName(name)
  const dataArg = type === 'REG_DWORD' ? String(value) : `"${String(value).replace(/"/g, '\\"')}"`
  await execAsync(`reg add "${key}" /v ${name} /t ${type} /d ${dataArg} /f`, {
    timeout: 4000,
    windowsHide: true,
  })
}

/** Delete a value. Idempotent — silently succeeds if the value is already absent. */
export async function deleteRegistryValue(key: string, name: string): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('deleteRegistryValue: Windows-only')
  }
  assertSafeKey(key)
  assertSafeValueName(name)
  try {
    await execAsync(`reg delete "${key}" /v ${name} /f`, {
      timeout: 4000,
      windowsHide: true,
    })
  } catch (err) {
    const message = (err as Error).message
    // "ERROR: The system was unable to find the specified registry key or value."
    if (!/not\s+find/i.test(message)) {
      throw err
    }
  }
}
