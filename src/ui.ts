import type { FastifyInstance } from 'fastify'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { info, warn } from './logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export async function registerUI(fastify: FastifyInstance): Promise<void> {
  // Try compiled UI first (dist/ui), then fallback to project ui dir
  const distPath = path.join(__dirname, '..', 'ui')
  const devPath = path.join(__dirname, '..', '..', 'ui', 'dist')

  let uiPath: string
  if (fs.existsSync(distPath) && fs.existsSync(path.join(distPath, 'index.html'))) {
    uiPath = distPath
  } else if (fs.existsSync(devPath) && fs.existsSync(path.join(devPath, 'index.html'))) {
    uiPath = devPath
  } else {
    warn('UI build not found. Run: npm run build:ui')
    return
  }

  try {
    const staticPlugin = await import('@fastify/static')
    await fastify.register(staticPlugin.default, {
      root: uiPath,
      prefix: '/',
    })
    info(`UI enabled, serving from ${uiPath}`)
  } catch {
    warn('@fastify/static not installed — UI disabled. Run: npm install @fastify/static')
  }
}
