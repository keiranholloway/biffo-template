import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deriveNames, findSkeletonRoot, scaffoldPlugin } from './plugin-scaffold.js'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * Scaffold **two** plugins from the real skeleton and check they can coexist.
 *
 * ## Why this exists
 *
 * Five separate failure conditions were found in one session by installing a
 * *second* plugin next to the first, and every one of them broke the
 * **incumbent** rather than the newcomer (issue #688 and the rows around it in
 * `docs/guides/development-practices.md`). They were all the same shape: a
 * shared namespace, or a template that had only ever had one occupant — one
 * `scripts` package, one set of test basenames, one generated Terraform block.
 *
 * None of them would have been found by testing the skeleton harder in
 * isolation, because in isolation nothing collides. The practices page names
 * the missing guard explicitly: *"a scaffolding test that generates two plugins
 * and runs them together would have caught every one — cheaply, and before
 * either reached an instance."* This is that guard.
 *
 * It runs against the **real** `_skeletons/plugin-template/`, not a fixture, so
 * it fails when the skeleton drifts rather than when a fixture does.
 */

let root: string

beforeEach(() => {
  root = makeTmpDir('two-plugins')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Every file in a tree, as paths relative to its root, using `/` separators. */
function walk(dir: string, base = dir): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    // Generated/vendored trees are not part of what gets vendored into an
    // instance, and .venv in particular is enormous.
    if (entry === '.venv' || entry === 'node_modules' || entry === '.git') continue
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) out.push(...walk(abs, base))
    else out.push(relative(base, abs).split(sep).join('/'))
  }
  return out
}

/**
 * Directories Python would treat as a **regular** package — one carrying an
 * `__init__.py`. Regular packages do not merge across `sys.path`: if two
 * vendored plugins both define one called `scripts`, the first shadows the
 * second and the second's imports resolve into the wrong plugin. That is
 * exactly #688.
 */
function regularPackages(files: string[]): string[] {
  return files
    .filter((f) => f.endsWith('/__init__.py') || f === '__init__.py')
    .map((f) => f.slice(0, -'/__init__.py'.length))
    .filter((p) => p !== '')
}

/**
 * Modules pytest would import by **bare basename**.
 *
 * With no `__init__.py` in `tests/`, pytest's default prepend import mode
 * inserts the directory on `sys.path` and imports each module under its own
 * basename. Two plugins shipping `tests/fakes.py` therefore both try to own the
 * top-level module `fakes`, and only one wins.
 *
 * `conftest.py` is excluded: pytest special-cases it per directory, so it does
 * not collide the same way.
 */
function bareImportedTestModules(files: string[]): string[] {
  const testsArePackage = files.some((f) => f === 'tests/__init__.py')
  if (testsArePackage) return []
  return files
    .filter((f) => f.startsWith('tests/') && f.endsWith('.py'))
    .filter((f) => !f.endsWith('/conftest.py'))
    .map((f) => f.slice('tests/'.length))
    .filter((f) => !f.includes('/'))
}

/** The real `_skeletons/plugin-template/`, resolved by walking up from here. */
function realSkeleton(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const found = findSkeletonRoot(here, 'plugin-template')
  if (!found) throw new Error('could not locate _skeletons/plugin-template from ' + here)
  return found
}

function scaffoldTwo(): { alpha: string[]; beta: string[] } {
  const skeleton = realSkeleton()
  const alphaDir = join(root, 'alpha')
  const betaDir = join(root, 'beta')
  scaffoldPlugin(skeleton, alphaDir, deriveNames('acme-crm'))
  scaffoldPlugin(skeleton, betaDir, deriveNames('zeta-billing'))
  return { alpha: walk(alphaDir), beta: walk(betaDir) }
}

describe('a second plugin alongside the first', () => {
  it('scaffolds both without either failing', () => {
    const { alpha, beta } = scaffoldTwo()
    expect(alpha.length).toBeGreaterThan(5)
    expect(beta.length).toBe(alpha.length)
  })

  /**
   * The #688 shape. Regular packages do not merge across sys.path, so a name
   * shared by two vendored plugins means one silently shadows the other — and
   * it breaks the plugin that was already working, not the new one.
   */
  it('does not give two plugins a regular package of the same name', () => {
    const { alpha, beta } = scaffoldTwo()
    const shared = regularPackages(alpha).filter((p) => regularPackages(beta).includes(p))
    expect(shared, `both plugins define regular package(s): ${shared.join(', ')}`).toEqual([])
  })

  /**
   * The other half of #688. `test_manifest.py`, `test_app.py`, `fakes.py` are
   * names *any* plugin picks; six collided at collection when a second plugin
   * was installed. `--import-mode=importlib` fixes it and breaks ten other
   * modules that rely on prepend, so the skeleton has to not create the
   * collision in the first place.
   */
  it('does not give two plugins a bare-imported test module of the same name', () => {
    const { alpha, beta } = scaffoldTwo()
    const shared = bareImportedTestModules(alpha).filter((m) =>
      bareImportedTestModules(beta).includes(m),
    )
    expect(shared, `both plugins import top-level module(s): ${shared.join(', ')}`).toEqual([])
  })

  /**
   * Table names are global in the instance's database. This one was already
   * fixed (the `example_widgets` substitution) — pinned so it cannot regress,
   * since the failure would only appear at migration time in an instance.
   */
  it('does not give two plugins the same database table name', () => {
    const skeleton = realSkeleton()
    const alphaDir = join(root, 'alpha')
    const betaDir = join(root, 'beta')
    scaffoldPlugin(skeleton, alphaDir, deriveNames('acme-crm'))
    scaffoldPlugin(skeleton, betaDir, deriveNames('zeta-billing'))

    const tablesIn = (dir: string): string[] => {
      const hits: string[] = []
      for (const rel of walk(dir)) {
        if (!rel.endsWith('.py') && !rel.endsWith('.json')) continue
        const text = readFileSync(join(dir, rel), 'utf8')
        for (const m of text.matchAll(/__tablename__\s*=\s*["']([^"']+)["']/g)) hits.push(m[1])
      }
      return [...new Set(hits)]
    }
    const shared = tablesIn(alphaDir).filter((t) => tablesIn(betaDir).includes(t))
    expect(shared, `both plugins declare table(s): ${shared.join(', ')}`).toEqual([])
  })

  it('runs against the real skeleton, not a fixture', () => {
    const skeleton = realSkeleton()
    expect(existsSync(join(skeleton, 'pyproject.toml'))).toBe(true)
    expect(existsSync(join(skeleton, 'biffo.plugin.json'))).toBe(true)
  })
})
