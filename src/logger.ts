import type { LogLevel } from './types.js'

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'] as const

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[36m', // cyan
  info: '\x1b[32m', // green
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
}

const RESET = '\x1b[0m'

export class Logger {
  private level: LogLevel

  constructor(level: LogLevel = 'info') {
    this.level = level
  }

  setLevel(level: LogLevel): void {
    this.level = level
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVELS.indexOf(level) >= LEVELS.indexOf(this.level)
  }

  private format(level: LogLevel, message: string): string {
    const timestamp = new Date().toISOString()
    const color = LEVEL_COLORS[level]
    return `${color}[${timestamp}] [${level.toUpperCase()}]${RESET} ${message}`
  }

  debug(message: string): void {
    if (this.shouldLog('debug')) {
      console.log(this.format('debug', message))
    }
  }

  info(message: string): void {
    if (this.shouldLog('info')) {
      console.log(this.format('info', message))
    }
  }

  warn(message: string): void {
    if (this.shouldLog('warn')) {
      console.warn(this.format('warn', message))
    }
  }

  error(message: string, error?: unknown): void {
    if (this.shouldLog('error')) {
      const errMessage =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : error != null
              ? JSON.stringify(error)
              : ''
      console.error(this.format('error', `${message}${errMessage ? `: ${errMessage}` : ''}`))
    }
  }

  getLogFn(): (level: string, msg: string) => void {
    return (level: string, msg: string) => {
      switch (level) {
        case 'debug':
          this.debug(msg)
          break
        case 'info':
          this.info(msg)
          break
        case 'warn':
          this.warn(msg)
          break
        case 'error':
          this.error(msg)
          break
        default:
          this.info(msg)
      }
    }
  }
}

// Module-level convenience functions (default logger instance)
let defaultLogger = new Logger('info')

export function setDefaultLogger(logger: Logger): void {
  defaultLogger = logger
}

export function setLogLevel(level: LogLevel): void {
  defaultLogger.setLevel(level)
}

export function debug(message: string): void {
  defaultLogger.debug(message)
}

export function info(message: string): void {
  defaultLogger.info(message)
}

export function warn(message: string): void {
  defaultLogger.warn(message)
}

export function error(message: string, err?: unknown): void {
  defaultLogger.error(message, err)
}
