/**
 * biffo-template#2134 — a scaffolded plugin's Python must be isort-clean for ANY plugin name.
 *
 * The skeleton's import order is correct only for the placeholder `example_plugin`. Token substitution renames the
 * modules, and isort orders (and, in some layouts, sections) imports by module name, so the substituted file can be
 * unsorted: `a5_throwaway_fakes` sorts differently against `biffo_plugin_sdk` than `example_plugin_fakes` does. The
 * instance's required lint check (`select` includes `I`) then fails on a raw scaffold.
 *
 * The oracle is the real tool — `ruff check --select I` over every scaffolded `.py` — not a re-implementation of
 * isort's ordering, so this cannot drift from what the instance actually enforces.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execa } from '../lib/exec.js'
import { findSkeletonRoot } from '../lib/plugin-scaffold.js'
import { makeTmpDir } from '../test-utils/tmp.js'
import { runPluginCreate } from './plugin-create.js'

vi.mock('../lib/logger.js', () => ({
  log: { step: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const SKELETON = findSkeletonRoot(new URL('.', import.meta.url).pathname, 'plugin-template')

// `a5-throwaway` is the name from the report; `a-first` sorts before `biffo_plugin_sdk`; `zeta-crm` sorts after it.
// `example-plugin` is the placeholder itself and must keep working.
const NAMES = ['a5-throwaway', 'a-first', 'acme-crm', 'zeta-crm', 'example-plugin']

function pythonFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...pythonFiles(p))
    else if (entry.name.endsWith('.py')) out.push(p)
  }
  return out
}

async function isortViolations(files: string[]): Promise<string> {
  const result = await execa(
    'uvx',
    ['ruff', 'check', '--select', 'I', '--no-cache', '--output-format', 'concise', ...files],
    { reject: false },
  )
  // Exit 0 = clean, 1 = violations. Anything else means ruff did not run, which must not read as "clean".
  expect([0, 1], `ruff did not run: ${result.stderr}`).toContain(result.exitCode)
  return result.exitCode === 0 ? '' : result.stdout
}

let root: string
beforeEach(() => {
  root = makeTmpDir('biffo-import-order')
  mkdirSync(join(root, 'services'), { recursive: true })
})

const git = () =>
  ({
    isGitRepo: vi.fn().mockResolvedValue(true),
    init: vi.fn(),
    add: vi.fn(),
    commit: vi.fn(),
  }) as never

describe.runIf(SKELETON)('scaffolded plugin Python is isort-clean for any name (#2134)', () => {
  afterEach(() => vi.clearAllMocks())

  for (const name of NAMES) {
    it(`in-tree: ${name}`, async () => {
      await runPluginCreate(
        name,
        {
          firstParty: false,
          standalone: false,
          skeletonRoot: SKELETON!,
          dryRun: false,
          commit: false,
          cwd: root,
        },
        { git: git() },
      )
      const dest = join(root, 'services', name)
      const files = pythonFiles(dest)
      expect(files.length).toBeGreaterThan(3)
      expect(await isortViolations(files)).toBe('')
    }, 120_000)

    it(`standalone: ${name}`, async () => {
      await runPluginCreate(
        name,
        {
          firstParty: false,
          standalone: true,
          skeletonRoot: SKELETON!,
          dryRun: false,
          commit: false,
          cwd: root,
        },
        { git: git() },
      )
      const dest = join(root, `biffo-plugin-${name}`)
      expect(existsSync(dest)).toBe(true)
      expect(await isortViolations(pythonFiles(dest))).toBe('')
    }, 120_000)
  }

  it('the oracle catches an unsorted file (guards the guard)', async () => {
    const bad = join(root, 'bad.py')
    writeFileSync(bad, 'import sys\nimport os\n')
    expect(await isortViolations([bad])).toContain('I001')
  })
})
