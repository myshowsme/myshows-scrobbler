import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { chmodSync, statSync } from 'node:fs'

const execAsync = promisify(exec)

type Tool = { kind: 'mediainfo' | 'ffprobe'; bin: string } | null

let detected: Tool | undefined
const cache = new Map<string, number>()
const probeCache = new Map<string, FileMediaProbe | null>()

/** Reset detected tool + cache (test helper). */
export function _resetDurationResolver(): void {
  detected = undefined
  cache.clear()
  probeCache.clear()
}

async function tryProbeBin(bin: string, versionArg: string): Promise<boolean> {
  try {
    await execAsync(`"${bin}" ${versionArg}`, { timeout: 1500, windowsHide: true })
    return true
  } catch {
    return false
  }
}

/**
 * Load the path to the ffprobe binary bundled with the app via
 * `@ffprobe-installer/ffprobe`. Lazy-loaded so the package import never runs on
 * unsupported platforms / when system tools are present.
 *
 * pnpm blocks postinstall scripts by default, so the bundled binary may not have
 * the executable bit set. We `chmod +x` it ourselves on Unix to make the package
 * work zero-config.
 */
async function loadBundledFfprobe(): Promise<string | null> {
  try {
    const mod = (await import('@ffprobe-installer/ffprobe')) as
      | { default?: { path?: string } }
      | { path?: string }
    const resolved =
      (mod as { path?: string }).path ?? (mod as { default?: { path?: string } }).default?.path
    if (!resolved) {
      return null
    }
    // In a packaged Electron build the resolved path points *into* app.asar, but
    // the binary is unpacked (build.asarUnpack) and only executable from
    // app.asar.unpacked — spawning the in-archive path fails. Rewrite it. No-op
    // outside Electron (no `app.asar` segment in the path).
    const candidate = resolved.replace(/app\.asar([\\/])/g, 'app.asar.unpacked$1')
    if (process.platform !== 'win32') {
      try {
        const stats = statSync(candidate)
        if ((stats.mode & 0o111) === 0) {
          chmodSync(candidate, 0o755)
        }
      } catch {
        /* best-effort */
      }
    }
    return candidate
  } catch {
    return null
  }
}

async function detectTool(): Promise<Tool> {
  if (detected !== undefined) {
    return detected
  }
  if (await tryProbeBin('mediainfo', '--version')) {
    detected = { kind: 'mediainfo', bin: 'mediainfo' }
    return detected
  }
  if (await tryProbeBin('ffprobe', '-version')) {
    detected = { kind: 'ffprobe', bin: 'ffprobe' }
    return detected
  }
  const bundled = await loadBundledFfprobe()
  if (bundled && (await tryProbeBin(bundled, '-version'))) {
    detected = { kind: 'ffprobe', bin: bundled }
    return detected
  }
  detected = null
  return detected
}

function quote(filePath: string): string {
  return filePath.replace(/"/g, '\\"')
}

async function viaMediainfo(bin: string, filePath: string): Promise<number> {
  const { stdout } = await execAsync(
    `"${bin}" --Output="General;%Duration%" "${quote(filePath)}"`,
    { timeout: 5000, windowsHide: true },
  )
  const ms = parseInt(stdout.trim(), 10)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0
}

async function viaFfprobe(bin: string, filePath: string): Promise<number> {
  const { stdout } = await execAsync(
    `"${bin}" -v quiet -print_format json -show_format "${quote(filePath)}"`,
    { timeout: 5000, windowsHide: true },
  )
  const data = JSON.parse(stdout) as { format?: { duration?: string } }
  const secs = parseFloat(data.format?.duration ?? '')
  return Number.isFinite(secs) ? Math.floor(secs) : 0
}

/**
 * Resolve media duration in seconds. Tries, in order:
 *   1. system `mediainfo`
 *   2. system `ffprobe`
 *   3. the ffprobe binary bundled via `@ffprobe-installer/ffprobe`
 * Returns 0 only if all three are unavailable or fail. Cached per-path.
 */
export async function getMediaDurationSeconds(filePath: string): Promise<number> {
  const cached = cache.get(filePath)
  if (cached !== undefined) {
    return cached
  }
  const tool = await detectTool()
  if (!tool) {
    return 0
  }
  let duration = 0
  try {
    duration =
      tool.kind === 'mediainfo'
        ? await viaMediainfo(tool.bin, filePath)
        : await viaFfprobe(tool.bin, filePath)
  } catch {
    duration = 0
  }
  if (duration > 0) {
    cache.set(filePath, duration)
  }
  return duration
}

/**
 * The audio track a player starts playback with: the one flagged `default`
 * in the container (or the first audio stream when none is flagged).
 *
 * This is a best-effort substitute for players whose APIs don't report the
 * SELECTED track (MPC web interface, process-scan players): if the user
 * switches tracks mid-playback we won't know. Values are as authored in the
 * file — language is usually ISO 639-2 ("rus"), title is release-style
 * ("Dub, Велес") — normalize downstream via `languageToIso` etc.
 */
export interface DefaultAudioTrack {
  language: string | null
  title: string | null
  codec: string | null
  channels: number | null
}

/**
 * Video stream facts read from the container. `transfer` and `dovi` are raw
 * signals — map them to a DTO HDR value downstream (`hdrFromVideoProbe`).
 */
export interface FileVideoInfo {
  width: number | null
  height: number | null
  /** Transfer characteristics as the tool reports them ("smpte2084", "PQ"). */
  transfer: string | null
  /** True when the stream carries a Dolby Vision configuration record. */
  dovi: boolean
}

/** Combined per-file probe: one tool invocation covers both streams. */
export interface FileMediaProbe {
  audio: DefaultAudioTrack | null
  video: FileVideoInfo | null
}

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  channels?: number
  width?: number
  height?: number
  color_transfer?: string
  disposition?: { default?: number }
  tags?: Record<string, string>
  side_data_list?: Array<{ side_data_type?: string }>
}

function tagOf(tags: Record<string, string> | undefined, name: string): string | null {
  if (!tags) {
    return null
  }
  for (const [key, value] of Object.entries(tags)) {
    if (key.toLowerCase() === name && value.trim()) {
      return value.trim()
    }
  }
  return null
}

async function probeViaFfprobe(bin: string, filePath: string): Promise<FileMediaProbe> {
  const { stdout } = await execAsync(
    `"${bin}" -v quiet -print_format json -show_streams "${quote(filePath)}"`,
    { timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  )
  const data = JSON.parse(stdout) as { streams?: FfprobeStream[] }
  const streams = data.streams ?? []

  const audioStreams = streams.filter((s) => s.codec_type === 'audio')
  const audioStream = audioStreams.find((s) => s.disposition?.default === 1) ?? audioStreams[0]
  const audio: DefaultAudioTrack | null = audioStream
    ? {
        language: tagOf(audioStream.tags, 'language'),
        title: tagOf(audioStream.tags, 'title'),
        codec: audioStream.codec_name ?? null,
        channels: typeof audioStream.channels === 'number' ? audioStream.channels : null,
      }
    : null

  const videoStream = streams.find((s) => s.codec_type === 'video')
  const video: FileVideoInfo | null = videoStream
    ? {
        width: typeof videoStream.width === 'number' ? videoStream.width : null,
        height: typeof videoStream.height === 'number' ? videoStream.height : null,
        transfer: videoStream.color_transfer ?? null,
        dovi: (videoStream.side_data_list ?? []).some((d) =>
          /dovi|dolby\s*vision/i.test(d.side_data_type ?? ''),
        ),
      }
    : null

  return { audio, video }
}

interface MediainfoTrack {
  '@type'?: string
  'Language'?: string
  'Title'?: string
  'Format'?: string
  'Channels'?: string
  'Default'?: string
  'Width'?: string
  'Height'?: string
  'HDR_Format'?: string
  'transfer_characteristics'?: string
}

function intOrNull(raw: string | undefined): number | null {
  const n = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(n) ? n : null
}

async function probeViaMediainfo(bin: string, filePath: string): Promise<FileMediaProbe> {
  const { stdout } = await execAsync(`"${bin}" --Output=JSON "${quote(filePath)}"`, {
    timeout: 5000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  })
  const data = JSON.parse(stdout) as { media?: { track?: MediainfoTrack[] } }
  const tracks = data.media?.track ?? []

  const audioTracks = tracks.filter((t) => t['@type'] === 'Audio')
  const audioTrack = audioTracks.find((t) => t.Default === 'Yes') ?? audioTracks[0]
  const audio: DefaultAudioTrack | null = audioTrack
    ? {
        language: audioTrack.Language?.trim() || null,
        title: audioTrack.Title?.trim() || null,
        codec: audioTrack.Format?.trim() || null,
        channels: intOrNull(audioTrack.Channels),
      }
    : null

  const videoTrack = tracks.find((t) => t['@type'] === 'Video')
  const video: FileVideoInfo | null = videoTrack
    ? {
        width: intOrNull(videoTrack.Width),
        height: intOrNull(videoTrack.Height),
        transfer: videoTrack.transfer_characteristics?.trim() || null,
        dovi: /dolby\s*vision/i.test(videoTrack.HDR_Format ?? ''),
      }
    : null

  return { audio, video }
}

/**
 * Probe a local file's default audio track and video stream via
 * mediainfo/ffprobe (same tool-discovery order as `getMediaDurationSeconds`).
 * Null when no tool is available or the probe fails. Cached per-path —
 * including null results, so a broken file is probed once.
 */
export async function probeFileMedia(filePath: string): Promise<FileMediaProbe | null> {
  if (probeCache.has(filePath)) {
    return probeCache.get(filePath) ?? null
  }
  const tool = await detectTool()
  if (!tool) {
    return null
  }
  let probe: FileMediaProbe | null = null
  try {
    probe =
      tool.kind === 'mediainfo'
        ? await probeViaMediainfo(tool.bin, filePath)
        : await probeViaFfprobe(tool.bin, filePath)
  } catch {
    probe = null
  }
  probeCache.set(filePath, probe)
  return probe
}

export interface DurationToolInfo {
  kind: 'mediainfo' | 'ffprobe'
  /** "system" — found on PATH; "bundled" — shipped via @ffprobe-installer. */
  source: 'system' | 'bundled'
}

export async function getActiveDurationTool(): Promise<DurationToolInfo | null> {
  const tool = await detectTool()
  if (!tool) {
    return null
  }
  // Treat anything not matching the bare command name as the bundled path.
  const isSystem = tool.bin === tool.kind
  return { kind: tool.kind, source: isSystem ? 'system' : 'bundled' }
}
