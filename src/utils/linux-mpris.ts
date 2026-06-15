import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

export type MprisPlayerKind =
  | 'vlc'
  | 'mpv'
  | 'smplayer'
  | 'celluloid'
  | 'totem'
  | 'rhythmbox'
  | 'unknown'

/**
 * One playback session reported by an MPRIS-compliant Linux player. Shape
 * deliberately mirrors `OsaPlayback` (macOS) so both backends feed into
 * `gatherPreciseSessions()` through the same downstream code.
 */
export interface MprisPlayback {
  /** Logical player id derived from the DBus bus name. */
  player: MprisPlayerKind
  /** Raw DBus bus name, e.g. "org.mpris.MediaPlayer2.vlc". Useful for logs. */
  busName: string
  isPlaying: boolean
  title: string
  filePath: string | null
  positionSeconds: number
  durationSeconds: number
}

const LIST_NAMES_CMD =
  'gdbus call --session --dest=org.freedesktop.DBus ' +
  '--object-path=/org/freedesktop/DBus ' +
  '--method=org.freedesktop.DBus.ListNames'

/**
 * Probe every MPRIS-compliant player currently registered on the session DBus.
 * Returns an empty array on non-Linux platforms, when `gdbus` is missing, or
 * when DBus itself isn't reachable (headless server, missing session bus).
 *
 * Why gdbus and not a native DBus library: zero npm deps, zero native build.
 * `gdbus` ships with glib (`libglib2.0-bin`) which is preinstalled on every
 * mainstream desktop distro. Cost is one `child_process.exec` per MPRIS player
 * per poll (~10-30ms each).
 */
export async function probeLinuxMpris(): Promise<MprisPlayback[]> {
  if (process.platform !== 'linux') {
    return []
  }
  let busNames: string[]
  try {
    busNames = await listMprisBusNames()
  } catch {
    return []
  }
  const results: MprisPlayback[] = []
  for (const busName of busNames) {
    const sample = await probeOne(busName)
    if (sample) {
      results.push(sample)
    }
  }
  return results
}

async function listMprisBusNames(): Promise<string[]> {
  const { stdout } = await execAsync(LIST_NAMES_CMD, { timeout: 3000 })
  // gdbus returns: (['org.mpris.MediaPlayer2.vlc', 'org.freedesktop.DBus', ...],)
  const matches = stdout.match(/'org\.mpris\.MediaPlayer2\.[^']+'/g) ?? []
  return matches.map((m) => m.slice(1, -1))
}

async function probeOne(busName: string): Promise<MprisPlayback | null> {
  const cmd =
    `gdbus call --session --dest=${shellEscape(busName)} ` +
    `--object-path=/org/mpris/MediaPlayer2 ` +
    `--method=org.freedesktop.DBus.Properties.GetAll ` +
    `org.mpris.MediaPlayer2.Player`
  let stdout: string
  try {
    const result = await execAsync(cmd, { timeout: 3000 })
    stdout = result.stdout
  } catch {
    return null
  }
  return parseGetAllReply(busName, stdout)
}

/**
 * Parse the gdbus textual reply for `Properties.GetAll(org.mpris.MediaPlayer2.Player)`.
 *
 * Reply format example:
 *   ({'PlaybackStatus': <'Playing'>, 'Metadata': <{'xesam:title': <'Foo'>,
 *     'xesam:url': <'file:///x/y.mkv'>, 'mpris:length': <int64 7800000000>}>,
 *     'Position': <int64 4500000000>, ...},)
 *
 * We do narrow regex picks rather than a full GVariant parser — the format is
 * stable and we only need three fields.
 */
export function parseGetAllReply(busName: string, reply: string): MprisPlayback | null {
  const status = pickString(reply, 'PlaybackStatus')
  if (!status) {
    return null
  }
  if (status !== 'Playing' && status !== 'Paused') {
    return null
  }
  const positionUs = pickInt64(reply, 'Position') ?? 0
  const lengthUs = pickMetadataInt64(reply, 'mpris:length') ?? 0
  const xUrl = pickMetadataString(reply, 'xesam:url')
  const xTitle = pickMetadataString(reply, 'xesam:title')

  const filePath = xUrl ? fileUrlToPath(xUrl) : null
  const title = xTitle || filePath?.split('/').pop() || ''
  if (!title && !filePath) {
    return null
  }
  return {
    player: classifyBusName(busName),
    busName,
    isPlaying: status === 'Playing',
    title,
    filePath,
    positionSeconds: positionUs / 1_000_000,
    durationSeconds: lengthUs / 1_000_000,
  }
}

function pickString(reply: string, key: string): string | null {
  // `'<key>': <'<value>'>` — single-quoted value inside angle brackets.
  const re = new RegExp(`'${key}'\\s*:\\s*<'([^']*)'>`)
  const m = re.exec(reply)
  return m ? m[1] : null
}

function pickInt64(reply: string, key: string): number | null {
  // `'<key>': <int64 <value>>` — int64 outside the metadata dict.
  const re = new RegExp(`'${key}'\\s*:\\s*<int64\\s+(-?\\d+)>`)
  const m = re.exec(reply)
  return m ? Number(m[1]) : null
}

function pickMetadataString(reply: string, key: string): string | null {
  const re = new RegExp(`'${escapeRegex(key)}'\\s*:\\s*<'([^']*)'>`)
  const m = re.exec(reply)
  return m ? m[1] : null
}

function pickMetadataInt64(reply: string, key: string): number | null {
  const re = new RegExp(`'${escapeRegex(key)}'\\s*:\\s*<(?:int64|uint64)\\s+(-?\\d+)>`)
  const m = re.exec(reply)
  return m ? Number(m[1]) : null
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function shellEscape(s: string): string {
  // bus names are restricted to [a-zA-Z0-9_.-], so this is safe. Just in case.
  return /^[a-zA-Z0-9_.-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

function classifyBusName(busName: string): MprisPlayerKind {
  const tail = busName.slice('org.mpris.MediaPlayer2.'.length).toLowerCase()
  if (tail.startsWith('vlc')) {
    return 'vlc'
  }
  if (tail.startsWith('mpv')) {
    return 'mpv'
  }
  if (tail.startsWith('smplayer')) {
    return 'smplayer'
  }
  if (tail.startsWith('celluloid') || tail.startsWith('io.github.celluloid')) {
    return 'celluloid'
  }
  if (tail.startsWith('totem') || tail.startsWith('org.gnome.totem')) {
    return 'totem'
  }
  if (tail.startsWith('rhythmbox')) {
    return 'rhythmbox'
  }
  return 'unknown'
}

/** Convert a `file:///...` URL into a POSIX path (with %-decoding). */
function fileUrlToPath(url: string): string | null {
  if (!url.startsWith('file://')) {
    return null
  }
  try {
    return decodeURIComponent(url.replace(/^file:\/\//, ''))
  } catch {
    return url.replace(/^file:\/\//, '')
  }
}
