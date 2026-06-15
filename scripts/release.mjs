// Tags the current commit with the version from package.json and pushes it,
// which triggers the Release workflow (.github/workflows/release.yml).
//
// Usage: bump "version" in package.json, commit, then run `pnpm release`.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import process from 'node:process'

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function fail(message) {
  console.error(`release: ${message}`)
  process.exit(1)
}

const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const tag = `v${version}`

if (git('status', '--porcelain') !== '') {
  fail('working tree is not clean — commit or stash your changes first')
}

const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
if (branch !== 'main') {
  fail(`releases are tagged from main, you are on "${branch}"`)
}

git('fetch', 'origin', 'main', '--tags')

if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) {
  fail('local main and origin/main differ — push or pull first')
}

if (git('tag', '--list', tag) !== '') {
  fail(`tag ${tag} already exists — bump "version" in package.json first`)
}

console.log(`Tagging ${git('rev-parse', '--short', 'HEAD')} as ${tag} and pushing...`)
git('tag', tag)
git('push', 'origin', tag)
console.log(`Done. The Release workflow is building the ${tag} draft:`)
console.log('  https://github.com/myshowsme/myshows-scrobbler/actions')
