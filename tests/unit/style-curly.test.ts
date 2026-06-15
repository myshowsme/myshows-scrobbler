import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vite-plus/test'

const ROOT = process.cwd()
const SEARCH_DIRS = ['src', 'tests', 'ui/src']
const EXTENSIONS = new Set(['.ts', '.vue'])

const SINGLE_LINE_IF_WITH_BODY =
  /^\s*if\s*\(.+\)\s+(return|throw|continue|break|[A-Za-z_$][\w$]*(?:[.[(]|=))/

function collectFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath))
      continue
    }

    if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath)
    }
  }

  return files
}

describe('code style', () => {
  it('requires braces for if statements', () => {
    const offenders = SEARCH_DIRS.flatMap((dir) => collectFiles(path.join(ROOT, dir)))
      .flatMap((file) =>
        fs
          .readFileSync(file, 'utf8')
          .split(/\r?\n/)
          .map((line, index) => ({ file, line, number: index + 1 }))
          .filter(({ line }) => SINGLE_LINE_IF_WITH_BODY.test(line)),
      )
      .map(({ file, number, line }) => `${path.relative(ROOT, file)}:${number}: ${line.trim()}`)

    expect(offenders).toEqual([])
  })
})
