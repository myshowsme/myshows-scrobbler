import type { ScrobbleRequest, ScrobbleResponse } from './scrobble-dto.js'
import { info, error as logError } from '../logger.js'
import { isAsciiToken } from '../utils/validation.js'
import { fetchWithTimeout } from '../http.js'

export const MYSHOWS_ENDPOINTS = {
  SCROBBLE_START: '/start',
  SCROBBLE_PAUSE: '/pause',
  SCROBBLE_STOP: '/stop',
  CHECK: '/check',
} as const

export type ScrobbleEndpoint =
  | typeof MYSHOWS_ENDPOINTS.SCROBBLE_START
  | typeof MYSHOWS_ENDPOINTS.SCROBBLE_PAUSE
  | typeof MYSHOWS_ENDPOINTS.SCROBBLE_STOP

export class MyShowsClient {
  private token: string
  private baseUrl: string

  constructor(token: string, baseUrl: string) {
    this.token = token
    this.baseUrl = this.normalizeBaseUrl(baseUrl)
  }

  setToken(token: string): void {
    this.token = token
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = this.normalizeBaseUrl(baseUrl)
  }

  getToken(): string {
    return this.token
  }

  getBaseUrl(): string {
    return this.baseUrl
  }

  // HTTP request helper

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.getRequiredBaseUrl()}${endpoint}`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    }

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`
    }

    const response = await fetchWithTimeout(url, { ...options, headers })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`MyShows API error: ${response.status} ${text}`)
    }

    return response.json() as Promise<T>
  }

  private normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.trim().replace(/\/+$/, '')
  }

  private getRequiredBaseUrl(): string {
    if (!this.baseUrl) {
      throw new Error('MyShows URL is empty')
    }
    return this.baseUrl
  }

  // Token check

  async checkToken(): Promise<{ valid: boolean; error?: string }> {
    if (!this.token) {
      return { valid: false, error: 'Token is empty' }
    }

    try {
      await this.request(MYSHOWS_ENDPOINTS.CHECK, { method: 'GET' })
      return { valid: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { valid: false, error: message }
    }
  }

  // Scrobble - send DTO payload to /scrobble/start|pause|stop

  async sendScrobble(
    endpoint: ScrobbleEndpoint,
    payload: ScrobbleRequest,
  ): Promise<{ success: boolean; data?: ScrobbleResponse; error?: string }> {
    if (!this.token) {
      return { success: false, error: 'Token is empty' }
    }
    if (!isAsciiToken(this.token)) {
      return { success: false, error: 'Token contains invalid non-ASCII characters' }
    }

    let lastError: string | undefined

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const data = await this.request<ScrobbleResponse>(endpoint, {
          method: 'POST',
          body: JSON.stringify(payload),
        })
        return { success: true, data }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        if (attempt < 3) {
          const delay = Math.pow(2, attempt - 1) * 1000
          info(`[MyShows] Attempt ${attempt} failed, retrying in ${delay}ms: ${lastError}`)
          await this.sleep(delay)
        }
      }
    }

    logError(`[MyShows] All 3 attempts failed: ${lastError}`)
    return { success: false, error: lastError }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
