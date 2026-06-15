import { describe, expect, it } from 'vite-plus/test'
import config from '../../ui/vite.config.js'

describe('UI Vite config', () => {
  it('proxies API and WebSocket traffic to the same backend target in dev', () => {
    const proxy = config.server?.proxy
    if (!proxy || typeof proxy === 'string' || Array.isArray(proxy)) {
      throw new Error('Expected object proxy config')
    }

    const apiProxy = proxy['/api']
    const wsProxy = proxy['/ws']
    if (typeof apiProxy !== 'object' || typeof wsProxy !== 'object') {
      throw new Error('Expected /api and /ws proxy objects')
    }

    expect(wsProxy.target).toBe(apiProxy.target)
    expect(wsProxy.ws).toBe(true)
  })
})
