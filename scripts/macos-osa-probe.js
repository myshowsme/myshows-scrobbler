// JXA probe — read playback state from every AppleScript-aware macOS player
// in a single osascript invocation, return JSON on stdout.
//
// Run: osascript -l JavaScript scripts/macos-osa-probe.js
//
// Output shape (each entry is a playing session; the array is empty when
// nothing is active):
//   [
//     {
//       "player": "vlc" | "quicktime" | "tv",
//       "isPlaying": boolean,
//       "title": string,
//       "filePath": string | null,        // for VLC/QuickTime; null for TV
//       "positionSeconds": number,
//       "durationSeconds": number
//     },
//     ...
//   ]
//
// Why JXA over per-app osascript runs: one process, one ~50ms cold-start,
// instead of N × 50ms for each tick. Also JSON.stringify is trivial in JXA.

'use strict'

ObjC.import('AppKit')

function safe(fn) {
  try {
    const v = fn()
    return v === undefined ? null : v
  } catch {
    return null
  }
}

function isRunning(name) {
  const apps = ObjC.unwrap($.NSWorkspace.sharedWorkspace.runningApplications)
  for (let i = 0; i < apps.length; i++) {
    const app = apps[i]
    const localized = ObjC.unwrap(app.localizedName)
    const bundle = ObjC.unwrap(app.bundleIdentifier)
    if (localized === name || bundle === name) {
      return true
    }
  }
  return false
}

function probeVlc() {
  if (!isRunning('VLC')) return null
  const app = Application('VLC')
  const playing = safe(() => app.playing())
  if (playing == null) return null

  // VLC scripting dictionary exposes the "of current item" chain as flattened
  // root methods in JXA: durationOfCurrentItem, nameOfCurrentItem, pathOfCurrentItem.
  const name = safe(() => app.nameOfCurrentItem())
  const path = safe(() => app.pathOfCurrentItem())
  const position = safe(() => app.currentTime())
  const duration = safe(() => app.durationOfCurrentItem())

  if (name == null && path == null) return null

  return {
    player: 'vlc',
    isPlaying: Boolean(playing),
    title: name || (path ? String(path).split('/').pop() : ''),
    filePath: path || null,
    positionSeconds: typeof position === 'number' ? position : 0,
    durationSeconds: typeof duration === 'number' ? duration : 0,
  }
}

function probeQuickTime() {
  if (!isRunning('QuickTime Player')) return null
  const app = Application('QuickTime Player')
  const count = safe(() => app.documents.length)
  if (!count) return null
  const doc = app.documents[0]
  const name = safe(() => doc.name())
  const playing = safe(() => doc.playing())
  const position = safe(() => doc.currentTime())
  const duration = safe(() => doc.duration())
  // POSIX path of (file of document). In JXA `doc.file()` returns a Path-like
  // object — `String(file)` coerces it to the POSIX path string; calling
  // .toString() directly returns "[object NSURL]" instead, which is useless.
  let filePath = null
  try {
    const file = doc.file()
    if (file) {
      const coerced = String(file)
      if (coerced && coerced !== '[object NSURL]') {
        filePath = coerced
      }
    }
  } catch {
    /* unsupported file ref — keep null */
  }

  if (!name && !filePath) return null

  return {
    player: 'quicktime',
    isPlaying: Boolean(playing),
    title: name || (filePath ? filePath.split('/').pop() : ''),
    filePath,
    positionSeconds: typeof position === 'number' ? position : 0,
    durationSeconds: typeof duration === 'number' ? duration : 0,
  }
}

function probeMediaApp(appName, playerId) {
  if (!isRunning(appName)) return null
  const app = Application(appName)
  const state = safe(() => app.playerState())
  if (state !== 'playing' && state !== 'paused') return null
  const track = safe(() => app.currentTrack)
  if (!track) return null
  const name = safe(() => track.name())
  const duration = safe(() => track.duration())
  const position = safe(() => app.playerPosition())
  if (!name) return null
  return {
    player: playerId,
    isPlaying: state === 'playing',
    title: name,
    filePath: null,
    positionSeconds: typeof position === 'number' ? position : 0,
    durationSeconds: typeof duration === 'number' ? duration : 0,
  }
}

// JXA entrypoint — osascript invokes the top-level `run` function automatically.
// eslint-disable-next-line no-unused-vars
function run() {
  const probes = [
    probeVlc,
    probeQuickTime,
    // Music.app is intentionally not probed — MyShows tracks shows/movies, not
    // music. TV.app stays (Apple TV+ content is a future mapping target).
    () => probeMediaApp('TV', 'tv'),
  ]

  const result = []
  for (const fn of probes) {
    const r = safe(fn)
    if (r) result.push(r)
  }
  return JSON.stringify(result)
}
