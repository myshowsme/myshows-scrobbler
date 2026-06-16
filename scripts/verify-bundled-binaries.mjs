// Pre-flight check run in CI *after* `build:all` and *before* electron-builder
// packs the installers. It fails loudly — with a GitHub Actions `::error::`
// annotation — when something electron-builder would silently bundle is broken
// or missing, so we never publish an installer that crashes on first launch.
//
// What it guards (the things that break per-platform, not in the matrix author's
// local dev):
//   1. The three build outputs electron-builder packs (`build.files` in
//      package.json): the electron entry, the server entry, the UI bundle.
//   2. koffi — a native FFI addon. Its `.node` lives in a platform-specific
//      `@koromix/koffi-<platform>` optional dependency; if pnpm didn't install
//      the right one for this runner, `require('koffi')` throws here instead of
//      at runtime in a shipped build.
//   3. ffprobe — a per-platform binary from `@ffprobe-installer/<platform>`
//      (asarUnpack'd). We resolve it the same way the runtime does and confirm
//      the file is actually on disk.
//
// Run locally with `node scripts/verify-bundled-binaries.mjs` after a build.

import { existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const errors = []
const fail = (message) => {
  // `::error::` turns this into an annotation in the Actions UI; the plain line
  // keeps it readable in local runs too.
  console.error(`::error::${message}`)
  errors.push(message)
}
const ok = (message) => console.log(`  ✓ ${message}`)

// 1. Build outputs that electron-builder packs (build.files in package.json).
console.log('Build outputs:')
const buildOutputs = ['dist/electron/electron.mjs', 'dist/server/index.mjs', 'dist/ui/index.html']
for (const rel of buildOutputs) {
  const abs = join(root, rel)
  if (existsSync(abs)) {
    ok(rel)
  } else {
    fail(`${rel} missing — did \`pnpm build:all\` run before packing?`)
  }
}

// 2. koffi native FFI addon (asarUnpack: node_modules/koffi, @koromix).
console.log('Native modules:')
try {
  const koffi = require('koffi')
  ok(`koffi loaded (v${koffi.version})`)
} catch (err) {
  fail(
    `koffi failed to load — the @koromix/koffi-* binary for this platform is ` +
      `missing or mismatched: ${err instanceof Error ? err.message : String(err)}`,
  )
}

// 3. ffprobe binary (asarUnpack: node_modules/@ffprobe-installer). Resolve the
// path exactly as src/utils/media-duration.ts does at runtime.
console.log('Bundled binaries:')
try {
  const ffprobe = require('@ffprobe-installer/ffprobe')
  if (ffprobe?.path && existsSync(ffprobe.path) && statSync(ffprobe.path).size > 0) {
    ok(`ffprobe (v${ffprobe.version}) at ${ffprobe.path}`)
  } else {
    fail(`ffprobe binary not found on disk at ${ffprobe?.path ?? '<unresolved>'}`)
  }
} catch (err) {
  fail(
    `@ffprobe-installer/ffprobe failed to resolve: ${err instanceof Error ? err.message : String(err)}`,
  )
}

if (errors.length > 0) {
  console.error(`\n${errors.length} check(s) failed — aborting before electron-builder.`)
  process.exit(1)
}
console.log('\nAll bundled-binary checks passed.')
