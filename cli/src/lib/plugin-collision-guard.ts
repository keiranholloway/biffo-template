import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Detect namespace collisions between plugins vendored into one instance
 * (issue #688).
 *
 * ## Why a second guard
 *
 * `plugin-skeleton-second-occupant.test.ts` scaffolds two plugins and asserts
 * they can coexist — but it only sees what the *skeleton* produces. Plugins add
 * files after scaffolding, and that is where the original defect came from:
 * `biffo-plugin-ideation` introduced a root `conftest.py` plus a regular
 * `scripts/` package, a convention no skeleton ever shipped. Installing a second
 * plugin next to it broke **ideation's** tests, not the newcomer's.
 *
 * So the skeleton guard prevents plugins being *born* colliding; this one
 * catches them colliding once they are actually installed together, which is
 * the only configuration that ships.
 *
 * ## The two collision shapes, both real
 *
 * 1. **Regular packages do not merge across `sys.path`.** Two plugins each
 *    defining `scripts/__init__.py` means the first found wins and shadows the
 *    other outright:
 *
 *    ```
 *    ModuleNotFoundError: No module named 'scripts.seed_chat_agents'
 *    ```
 *
 * 2. **pytest's prepend import mode gives every test module its bare
 *    basename.** `test_manifest.py`, `test_app.py` and `test_service.py` are
 *    names any plugin picks; six collided at collection:
 *
 *    ```
 *    import file mismatch: imported module 'test_manifest' has this __file__ …
 *    ```
 *
 * `--import-mode=importlib` fixes both cleanly and breaks ten other modules that
 * rely on prepend, so it is a deliberate decision rather than a drive-by fix
 * (#688). Until it is taken, this guard is what stops the next plugin
 * rediscovering the problem in an instance's CI.
 */

/** A directory that Python treats as a package because it carries `__init__.py`. */
export interface Collision {
  kind: 'regular-package' | 'test-module'
  /** The shared name both plugins claim. */
  name: string
  /** Plugin directory names that claim it, sorted. */
  plugins: string[]
}

/**
 * `conftest.py` is excluded from the test-module check: pytest special-cases it
 * per directory, so two plugins each shipping one do not collide.
 */
const PYTEST_SPECIAL = new Set(['conftest.py'])

/** Directories that are never part of a plugin's importable surface. */
const IGNORED_DIRS = new Set(['.venv', 'node_modules', '__pycache__', '.git', 'dist', 'build'])

function subdirectories(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((entry) => {
    if (IGNORED_DIRS.has(entry) || entry.startsWith('.')) return false
    try {
      return statSync(join(dir, entry)).isDirectory()
    } catch {
      return false
    }
  })
}

/**
 * Top-level directories in a plugin that Python would import as a **regular**
 * package.
 *
 * Only the top level matters: a nested `src/thing/__init__.py` is reached
 * through its parent, so it cannot be claimed by another plugin unless the
 * parent is — and the parent is what this returns.
 */
export function regularPackagesOf(pluginDir: string): string[] {
  return subdirectories(pluginDir)
    .filter((name) => existsSync(join(pluginDir, name, '__init__.py')))
    .sort()
}

/**
 * Test modules pytest would import under their bare basename.
 *
 * A `tests/` directory carrying `__init__.py` is a package, so its modules are
 * addressed as `tests.foo` and do not collide by basename — but the package name
 * `tests` then collides instead, which `regularPackagesOf` already reports. Both
 * paths are covered; neither is silently ignored.
 */
export function bareTestModulesOf(pluginDir: string): string[] {
  const testsDir = join(pluginDir, 'tests')
  if (!existsSync(testsDir)) return []
  if (existsSync(join(testsDir, '__init__.py'))) return []
  return readdirSync(testsDir)
    .filter((f) => f.endsWith('.py') && !PYTEST_SPECIAL.has(f))
    .sort()
}

/**
 * Find every name claimed by more than one plugin.
 *
 * @param servicesDir directory holding the vendored plugins (an instance's `services/`)
 * @param pluginDirs plugin directory names to compare; defaults to every subdirectory
 *   that is not an underscore-prefixed platform tree (`_plugin-host`, `_template`, …)
 */
export function findCollisions(servicesDir: string, pluginDirs?: string[]): Collision[] {
  const plugins = (pluginDirs ?? subdirectories(servicesDir))
    .filter((name) => !name.startsWith('_'))
    // The Core API is not a plugin and legitimately owns names a plugin must not.
    .filter((name) => name !== 'api')
    .sort()

  const collisions: Collision[] = []

  const gather = (kind: Collision['kind'], namesOf: (dir: string) => string[]): void => {
    const claims = new Map<string, string[]>()
    for (const plugin of plugins) {
      for (const name of namesOf(join(servicesDir, plugin))) {
        claims.set(name, [...(claims.get(name) ?? []), plugin])
      }
    }
    for (const [name, owners] of [...claims.entries()].sort()) {
      if (owners.length > 1) collisions.push({ kind, name, plugins: owners.sort() })
    }
  }

  gather('regular-package', regularPackagesOf)
  gather('test-module', bareTestModulesOf)

  return collisions
}

/** Human-readable report, with the remedy for each shape. */
export function formatCollisions(collisions: Collision[]): string {
  const lines: string[] = []
  for (const c of collisions) {
    if (c.kind === 'regular-package') {
      lines.push(
        `  regular package '${c.name}' is defined by: ${c.plugins.join(', ')}`,
        `    Regular packages do not merge across sys.path — the first found shadows`,
        `    the rest, and the plugin that breaks is whichever loaded second.`,
        `    Fix: load these modules by file path instead of making '${c.name}' a`,
        `    package (drop its __init__.py), or give it a plugin-scoped name.`,
      )
    } else {
      lines.push(
        `  test module '${c.name}' is shipped by: ${c.plugins.join(', ')}`,
        `    pytest's prepend import mode imports test modules by bare basename, so`,
        `    only one of these can be collected.`,
        `    Fix: prefix it with the plugin name, e.g. '${c.plugins[0]}_${c.name}'.`,
      )
    }
  }
  return lines.join('\n')
}
