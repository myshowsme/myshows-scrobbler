import type { SourceConfig, SourceType, NormalizedEvent, AdapterCallbacks } from '../types.js'

export abstract class BaseAdapter {
  protected pollTimer: ReturnType<typeof setInterval> | null = null
  protected running = false
  protected lastConnectionError: string | null = null

  public readonly config: SourceConfig

  constructor(
    config: SourceConfig,
    protected readonly callbacks: AdapterCallbacks,
  ) {
    this.config = config
  }

  abstract get name(): SourceType

  abstract checkConnection(): Promise<boolean>

  protected abstract poll(): Promise<void>

  getLastConnectionError(): string | null {
    return this.lastConnectionError
  }

  isRunning(): boolean {
    return this.running
  }

  start(): void {
    if (this.running) {
      return
    }
    this.running = true
    if (this.pollTimer) {
      return
    }

    this.pollTimer = setInterval(() => void this.poll(), this.config.pollInterval)
    this.log('info', `Polling started, interval: ${this.config.pollInterval}ms`)
    // Kick off immediately so the UI shows "now playing" without waiting for the first tick.
    void this.poll()
  }

  stop(): void {
    this.running = false
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.resetState()
  }

  protected resetState(): void {
    // Subclasses override to clear their session caches on stop.
  }

  protected log(level: string, message: string): void {
    this.callbacks.onLog(level, `[${this.name}] ${message}`)
  }

  protected clearConnectionError(): void {
    this.lastConnectionError = null
  }

  protected setConnectionError(message: string): void {
    this.lastConnectionError = message
  }

  protected async emitScrobble(event: NormalizedEvent): Promise<void> {
    await this.callbacks.onScrobble(event)
  }
}
