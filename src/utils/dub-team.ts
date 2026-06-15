import { guessit } from 'guessit-js'

const CACHE_MAX = 512
const cache = new Map<string, string | null>()

export function clearDubTeamCache(): void {
  cache.clear()
}

export function extractDubTeam(filePath: string | null | undefined): string | null {
  if (!filePath) {
    return null
  }

  const cached = cache.get(filePath)
  if (cached !== undefined) {
    cache.delete(filePath)
    cache.set(filePath, cached)
    return cached
  }

  const result = doExtract(filePath)

  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) {
      cache.delete(oldest)
    }
  }
  cache.set(filePath, result)
  return result
}

function doExtract(filePath: string): string | null {
  const filename = filePath.split('/').pop()?.split('\\').pop() ?? ''
  if (!filename) {
    return null
  }

  try {
    const result = guessit(filename)
    const releaseGroup = result?.release_group
    if (typeof releaseGroup === 'string' && releaseGroup.trim()) {
      return releaseGroup.trim()
    }
  } catch {
    // ignore
  }

  return null
}
