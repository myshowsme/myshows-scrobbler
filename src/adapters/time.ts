const TICKS_PER_MS = 10_000
const TICKS_PER_MINUTE = 600_000_000

export interface MediaTime {
  hours: number
  minutes: number
  seconds: number
  milliseconds: number
}

export function ticksToMs(ticks: number | null | undefined): number | null {
  return ticks ? Math.floor(ticks / TICKS_PER_MS) : null
}

export function ticksToRuntimeMinutes(ticks: number | null | undefined): number | null {
  return ticks ? Math.round(ticks / TICKS_PER_MINUTE) : null
}

export function msToRuntimeMinutes(ms: number | null | undefined): number | null {
  return ms ? Math.round(ms / 60000) : null
}

export function secondsToRuntimeMinutes(seconds: number | null | undefined): number | null {
  return seconds && seconds > 0 ? Math.round(seconds / 60) : null
}

export function mediaTimeToMs(time: MediaTime): number {
  return (time.hours * 3600 + time.minutes * 60 + time.seconds) * 1000 + time.milliseconds
}

export function percentFromPosition(position: number | null | undefined, duration: number): number {
  return duration > 0 ? ((position ?? 0) / duration) * 100 : 0
}
