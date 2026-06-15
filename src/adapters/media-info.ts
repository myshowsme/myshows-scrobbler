import type { MediaInfo } from '../types.js'

export function resolutionFromDimensions(width?: number, height?: number): string | null {
  const maxSide = Math.max(width ?? 0, height ?? 0)
  if (maxSide >= 3800) {
    return '2160'
  }
  if (maxSide >= 1900) {
    return '1080'
  }
  if (maxSide >= 1200) {
    return '720'
  }
  if (maxSide >= 700) {
    return '576'
  }
  if (maxSide > 0) {
    return '480'
  }
  return null
}

export function hdrFromText(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const text = value?.toLowerCase()
    if (!text) {
      continue
    }

    if (text.includes('dovi') || text.includes('dolbyvision') || text.includes('dolby vision')) {
      return 'dolby_vision'
    }
    if (text.includes('hdr10plus') || text.includes('hdr10+') || text.includes('hdr10 plus')) {
      return 'hdr10_plus'
    }
    if (text.includes('hdr10') || text === 'hdr') {
      return 'hdr10'
    }
    if (text.includes('hlg')) {
      return 'hlg'
    }
  }

  return null
}

function filenameOf(filePath?: string): string | null {
  return filePath?.split('/').pop()?.split('\\').pop()?.toLowerCase() ?? null
}

/**
 * Resolution from release-name tokens ("Беглец.2023.WEB-DL.2160p.mkv" → '2160').
 * Conservative: bare numbers like "1080" collide with too many things in
 * filenames, so the p/i suffix is required everywhere except the unambiguous
 * 4K aliases. Returns the same logical values as `resolutionFromDimensions`.
 */
export function resolutionFromFilename(filePath?: string): string | null {
  const name = filenameOf(filePath)
  if (!name) {
    return null
  }
  if (/\b(2160p?|4k|uhd)\b/.test(name)) {
    return '2160'
  }
  if (/\b1080[pi]\b/.test(name)) {
    return '1080'
  }
  if (/\b720p\b/.test(name)) {
    return '720'
  }
  if (/\b576[pi]\b/.test(name)) {
    return '576'
  }
  if (/\b480p\b/.test(name)) {
    return '480'
  }
  return null
}

/**
 * HDR format from release-name tokens ("...DV.HDR.H.265..." → 'dolby_vision').
 * Token-based on purpose: `hdrFromText` substring-matches free-form API strings,
 * which would false-positive on filenames (e.g. "dv" inside "DVDRip"). DV wins
 * over HDR when both tokens are present — that's the convention for "Dolby
 * Vision with HDR10 fallback" releases.
 */
export function hdrFromFilename(filePath?: string): string | null {
  const name = filenameOf(filePath)
  if (!name) {
    return null
  }
  if (/\b(dv|dovi|dolby[._\s-]?vision)\b/.test(name)) {
    return 'dolby_vision'
  }
  if (/\bhdr10(?:\+|[._\s-]?plus\b)/.test(name)) {
    return 'hdr10_plus'
  }
  if (/\bhdr(10)?\b/.test(name)) {
    return 'hdr10'
  }
  if (/\bhlg\b/.test(name)) {
    return 'hlg'
  }
  return null
}

/**
 * HDR format from a video transfer function, as players report it:
 * mpv `video-params/gamma` ("pq", "hlg"), ffprobe `color_transfer`
 * ("smpte2084", "arib-std-b67"), VLC status strings ("SMPTE ST2084 (PQ)"),
 * mediainfo `transfer_characteristics` ("PQ"). PQ alone can't distinguish
 * HDR10 from HDR10+ (the plus is per-frame metadata) — report plain hdr10;
 * Dolby Vision is signalled separately by every backend and must be checked
 * BEFORE calling this.
 */
export function hdrFromTransfer(transfer: string | null | undefined): string | null {
  const t = transfer?.toLowerCase()
  if (!t) {
    return null
  }
  if (t.includes('pq') || t.includes('2084')) {
    return 'hdr10'
  }
  if (t.includes('hlg') || t.includes('arib')) {
    return 'hlg'
  }
  return null
}

/** DTO HDR value from a container video probe (Dolby Vision flag wins). */
export function hdrFromVideoProbe(
  video: { transfer: string | null; dovi: boolean } | null | undefined,
): string | null {
  if (!video) {
    return null
  }
  if (video.dovi) {
    return 'dolby_vision'
  }
  return hdrFromTransfer(video.transfer)
}

export function containerFromFile(filePath?: string): string | null {
  const filename = filePath?.split('/').pop()?.split('\\').pop()
  const match = filename?.match(/\.([a-z0-9]+)$/i)
  return match?.[1]?.toLowerCase() ?? null
}

export function mediaInfoOrNull(info: MediaInfo): MediaInfo | null {
  return Object.values(info).some((value) => value != null) ? info : null
}
