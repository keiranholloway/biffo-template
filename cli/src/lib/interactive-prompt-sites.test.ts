import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every prompt goes through `promptOr` (lib/interactive.ts), which refuses when
 * `--non-interactive` is set or stdin is not a terminal. A direct
 * `inquirer.prompt` elsewhere bypasses that guard: on 2026-10-09 the unguarded
 * `plugin upgrade` confirmation, fed `yes y` by a fleet agent, redrew endlessly
 * until the kernel OOM-killed the pipe at 11.5 GB. So only interactive.ts may
 * import inquirer.
 */
const SRC = join(import.meta.dirname, '..')
const ALLOWED = new Set(['lib/interactive.ts'])

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

describe('prompt sites', () => {
  it('finds the CLI source (a scan of nothing would pass vacuously)', () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(50)
  })

  it('imports inquirer only in lib/interactive.ts', () => {
    const offenders = sourceFiles(SRC)
      .map((path) => relative(SRC, path))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) =>
        /from ['"]inquirer['"]|require\(['"]inquirer['"]\)/.test(
          readFileSync(join(SRC, rel), 'utf8'),
        ),
      )
    expect(offenders).toEqual([])
  })
})
