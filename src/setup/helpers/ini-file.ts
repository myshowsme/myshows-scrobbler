import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Minimal INI file helpers — sufficient for the formats used by VLC (vlcrc)
 * and mpv (mpv.conf):
 *
 *   - one `key=value` per line
 *   - optional `[section]` headers (vlcrc has them, mpv.conf usually doesn't)
 *   - `#` and `;` line comments
 *
 * Round-trip preservation: `setIniValue` operates on the raw string so
 * unrelated lines (comments, formatting, untouched keys) survive untouched.
 * Parsing strips comments for the *map view* only.
 */

export interface IniRead {
  /** Original file contents — pass back to `setIniValue` to round-trip. */
  raw: string
  /** Parsed view. Key `null` collects entries that appear before any [section]. */
  sections: Map<string | null, Map<string, string>>
}

export async function readIni(filePath: string): Promise<IniRead | null> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw err
  }
  return parseIni(raw)
}

export function parseIni(raw: string): IniRead {
  const sections = new Map<string | null, Map<string, string>>()
  let current: string | null = null
  sections.set(null, new Map())
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
      continue
    }
    // Section header. VLC's vlcrc writes them with trailing comments
    // (`[lua] # Lua interpreter`), so we accept any leading `[name]` and
    // ignore whatever's after the closing bracket on the same line.
    const headerMatch = /^\[([^\]]+)\]/.exec(trimmed)
    if (headerMatch) {
      current = headerMatch[1]
      if (!sections.has(current)) {
        sections.set(current, new Map())
      }
      continue
    }
    const eq = trimmed.indexOf('=')
    if (eq === -1) {
      continue
    }
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (!sections.has(current)) {
      sections.set(current, new Map())
    }
    sections.get(current)?.set(key, value)
  }
  return { raw, sections }
}

/**
 * Get a single value from an already-parsed view. Returns null when absent.
 * Section `null` means "top of file, before any [section]".
 */
export function getIniValue(read: IniRead, section: string | null, key: string): string | null {
  const sec = read.sections.get(section)
  if (!sec) {
    return null
  }
  return sec.get(key) ?? null
}

/**
 * Set a key's value in an INI string. Strategy:
 *
 *   - If the key exists in the target section, replace its line in place.
 *   - If the section exists but the key doesn't, insert just before the next
 *     section header (or at EOF for the last section).
 *   - If the section is missing entirely, append `[section]` + key=value at EOF.
 *
 * Comments and unrelated keys are preserved. Returns the new file contents.
 */
export function setIniValue(
  raw: string,
  section: string | null,
  key: string,
  value: string,
): string {
  const lines = raw.split(/\r?\n/)
  // Match `[name]` at the start of the line, ignoring trailing comments such
  // as `[lua] # Lua interpreter` (VLC's vlcrc style). Without this leniency
  // setIniValue would fail to find existing sections and append duplicates.
  const headerOf = (line: string): string | null => {
    const m = /^\s*\[([^\]]+)\]/.exec(line)
    return m ? m[1] : null
  }

  // Resolve the target section's line range [startIdx, endIdx).
  //   section=null  → the implicit top-of-file zone, ending at the first [header]
  //   section='X'   → lines after [X] up to the next [header] (or EOF)
  let startIdx = section === null ? 0 : -1
  let endIdx = lines.length
  for (let i = 0; i < lines.length; i += 1) {
    const header = headerOf(lines[i])
    if (header === null) {
      continue
    }
    if (section === null) {
      endIdx = i
      break
    }
    if (header === section) {
      startIdx = i + 1
      for (let j = i + 1; j < lines.length; j += 1) {
        if (headerOf(lines[j]) !== null) {
          endIdx = j
          break
        }
      }
      break
    }
  }

  // Section requested but not found — append `[section]` + key at EOF.
  if (section !== null && startIdx === -1) {
    const trailing: string[] = []
    if (lines.length > 0 && lines[lines.length - 1] !== '') {
      trailing.push('')
    }
    trailing.push(`[${section}]`, `${key}=${value}`)
    return lines.concat(trailing).join('\n')
  }

  // Look for an existing line for this key within the target range; replace
  // in place if found.
  for (let i = startIdx; i < endIdx; i += 1) {
    const eq = lines[i].indexOf('=')
    if (eq === -1) {
      continue
    }
    const lineKey = lines[i].slice(0, eq).trim()
    if (lineKey === key) {
      lines[i] = `${key}=${value}`
      return lines.join('\n')
    }
  }

  // Key not present — insert at the end of the target section.
  lines.splice(endIdx, 0, `${key}=${value}`)
  return lines.join('\n')
}

/**
 * Remove a key's line from an INI string. Removes the first matching line in
 * the target section (or top-of-file for `section === null`). No-op if absent.
 * Returns the new file contents.
 */
export function removeIniValue(raw: string, section: string | null, key: string): string {
  const lines = raw.split(/\r?\n/)
  // Match `[name]` at the start of the line, ignoring trailing comments such
  // as `[lua] # Lua interpreter` (VLC's vlcrc style). Without this leniency
  // setIniValue would fail to find existing sections and append duplicates.
  const headerOf = (line: string): string | null => {
    const m = /^\s*\[([^\]]+)\]/.exec(line)
    return m ? m[1] : null
  }
  let inTargetSection = section === null
  for (let i = 0; i < lines.length; i += 1) {
    const header = headerOf(lines[i])
    if (header !== null) {
      inTargetSection = header === section
      continue
    }
    if (!inTargetSection) {
      continue
    }
    const eq = lines[i].indexOf('=')
    if (eq === -1) {
      continue
    }
    if (lines[i].slice(0, eq).trim() === key) {
      lines.splice(i, 1)
      break
    }
  }
  return lines.join('\n')
}

/** Convenience: read → mutate → write, creating the file (and parent dir) if absent. */
export async function writeIniValue(
  filePath: string,
  section: string | null,
  key: string,
  value: string,
): Promise<void> {
  const raw = await readRaw(filePath)
  const next = setIniValue(raw, section, key, value)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, next, 'utf8')
}

/** Convenience: read → remove key → write. No-op (no write) if the file is absent. */
export async function deleteIniValue(
  filePath: string,
  section: string | null,
  key: string,
): Promise<void> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw err
  }
  await fs.writeFile(filePath, removeIniValue(raw, section, key), 'utf8')
}

async function readRaw(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err
    }
    return ''
  }
}
