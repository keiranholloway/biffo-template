import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isInstanceRepo } from './core-version.js'

// cli/src/lib/ -> cli/src/ -> cli/ -> repo root
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * `.python-version` is the one place the Python interpreter is chosen.
 *
 * Every pyproject here says `requires-python = ">=3.13"` with no upper bound, so
 * with no `.python-version` `uv sync` takes the NEWEST interpreter it can find.
 * On 2026-10-10 that became CPython 3.15.0 on the runners, and every template PR
 * failed whatever its diff: coverage refused `concurrency=greenlet` under
 * PyTracer, and alembic in `pg-test-db.sh` raised `greenlet context must be a
 * contextvars.Context or None` (biffo-template#2465, #2466; tabsii-platform
 * fixed its own copy in tabsii-platform#1650). The `PYTHON_VERSION: '3.13'`
 * env in ci.yml never reached uv, so it pinned nothing.
 *
 * uv reads `.python-version` from the project directory or any parent, so one
 * file at each repo root pins every `uv sync`/`uv run` under it. The template's
 * reaches instances through `biffo core upgrade` (core-manifest.json
 * templateOwned); each skeleton's copy is what a new plugin or sibling is born
 * with. The checks below keep every other statement of the version in step.
 */
const pinned = readFileSync(join(repoRoot, '.python-version'), 'utf8').trim()

const skeletonRoots = readdirSync(join(repoRoot, '_skeletons'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(repoRoot, '_skeletons', entry.name))

function pyprojects(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.venv', '.git', 'dist', '.worktrees'].includes(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...pyprojects(path))
    else if (entry.name === 'pyproject.toml') out.push(path)
  }
  return out
}

function workflowFiles(): string[] {
  return [
    join(repoRoot, '.github/workflows'),
    ...skeletonRoots.map((root) => join(root, '.github/workflows')),
  ]
    .filter((dir) => existsSync(dir))
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
        .map((name) => join(dir, name)),
    )
}

describe('the pinned Python version', () => {
  it('is a minor version, not a bare major or a patch release', () => {
    expect(pinned).toMatch(/^3\.\d+$/)
  })

  it('is carried by every skeleton that holds a Python project', () => {
    for (const root of skeletonRoots) {
      if (pyprojects(root).length === 0) continue
      const file = join(root, '.python-version')
      expect(existsSync(file), `${relative(repoRoot, file)} is missing`).toBe(true)
      expect(readFileSync(file, 'utf8').trim(), relative(repoRoot, file)).toBe(pinned)
    }
  })

  it('reaches instances through `biffo core upgrade`', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'core-manifest.json'), 'utf8')) as {
      templateOwned: string[]
    }
    expect(manifest.templateOwned).toContain('.python-version')
  })

  // services/ and packages/ are user-owned in an instance (core-manifest.json), so an instance cannot fix
  // what this would find there: it runs only in the template.
  it.skipIf(isInstanceRepo(repoRoot))('is admitted by every pyproject `requires-python`', () => {
    const projects = [
      ...pyprojects(join(repoRoot, 'services')),
      ...pyprojects(join(repoRoot, 'packages')),
    ]
    projects.push(...skeletonRoots.flatMap((root) => pyprojects(root)))
    expect(projects.length).toBeGreaterThan(0)
    for (const file of projects) {
      const floor = /requires-python\s*=\s*">=\s*(3\.\d+)/.exec(readFileSync(file, 'utf8'))?.[1]
      if (!floor) continue
      const [, floorMinor] = floor.split('.').map(Number)
      const [, pinnedMinor] = pinned.split('.').map(Number)
      expect(pinnedMinor, `${relative(repoRoot, file)} requires >=${floor}`).toBeGreaterThanOrEqual(
        floorMinor,
      )
    }
  })

  it('matches every version a workflow states for itself', () => {
    const stated: string[] = []
    for (const file of workflowFiles()) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const m = /^\s*(?:python-version|PYTHON_VERSION):\s*['"]?([\d.]+)['"]?\s*$/.exec(line)
          if (m) {
            stated.push(m[1])
            expect(m[1], `${relative(repoRoot, file)}:${i + 1}`).toBe(pinned)
          }
        })
    }
    expect(stated.length).toBeGreaterThan(0)
  })
})
