import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bareTestModulesOf,
  findCollisions,
  formatCollisions,
  regularPackagesOf,
} from './plugin-collision-guard.js'

let services: string

beforeEach(() => {
  services = mkdtempSync(join(tmpdir(), 'plugin-collisions-'))
})

afterEach(() => {
  rmSync(services, { recursive: true, force: true })
})

/** Create `services/<plugin>/<relPath>` with trivial contents. */
function file(plugin: string, relPath: string): void {
  const abs = join(services, plugin, relPath)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, '')
}

describe('regularPackagesOf', () => {
  it('reports a top-level directory carrying __init__.py', () => {
    file('ideation', 'scripts/__init__.py')
    file('ideation', 'scripts/seed_chat_agents.py')
    expect(regularPackagesOf(join(services, 'ideation'))).toEqual(['scripts'])
  })

  it('ignores a directory with no __init__.py', () => {
    file('idea-scout', 'scripts/seed_build_types.py')
    expect(regularPackagesOf(join(services, 'idea-scout'))).toEqual([])
  })
})

describe('bareTestModulesOf', () => {
  it('reports test modules pytest would import by basename', () => {
    file('alpha', 'tests/test_manifest.py')
    file('alpha', 'tests/fakes.py')
    expect(bareTestModulesOf(join(services, 'alpha'))).toEqual(['fakes.py', 'test_manifest.py'])
  })

  /** pytest special-cases conftest per directory, so it does not collide. */
  it('excludes conftest.py', () => {
    file('alpha', 'tests/conftest.py')
    expect(bareTestModulesOf(join(services, 'alpha'))).toEqual([])
  })

  /**
   * With `__init__.py` the modules are addressed as `tests.foo` and stop
   * colliding by basename — but the package name `tests` then collides instead,
   * which regularPackagesOf reports. Neither path is silently ignored.
   */
  it('reports nothing when tests/ is a package, because the package name collides instead', () => {
    file('alpha', 'tests/__init__.py')
    file('alpha', 'tests/test_manifest.py')
    expect(bareTestModulesOf(join(services, 'alpha'))).toEqual([])
    expect(regularPackagesOf(join(services, 'alpha'))).toEqual(['tests'])
  })
})

describe('findCollisions', () => {
  /**
   * The exact defect from #688, reconstructed. Installing `idea-scout` next to
   * `ideation` produced:
   *
   *   ModuleNotFoundError: No module named 'scripts.seed_chat_agents'
   *
   * in **ideation's** tests, which the install never touched. Regular packages
   * do not merge across sys.path, so the first found shadows the other.
   */
  it('catches the scripts-package collision that broke the incumbent', () => {
    file('ideation', 'scripts/__init__.py')
    file('ideation', 'scripts/seed_chat_agents.py')
    file('idea-scout', 'scripts/__init__.py')
    file('idea-scout', 'scripts/seed_build_types.py')

    const collisions = findCollisions(services)
    expect(collisions).toHaveLength(1)
    expect(collisions[0]).toEqual({
      kind: 'regular-package',
      name: 'scripts',
      plugins: ['idea-scout', 'ideation'],
    })
  })

  /**
   * The other half of #688:
   *
   *   import file mismatch: imported module 'test_manifest' has this __file__ …
   *
   * `test_manifest.py` is a name any plugin would pick; six collided at
   * collection.
   */
  it('catches same-named test modules across plugins', () => {
    file('ideation', 'tests/test_manifest.py')
    file('idea-scout', 'tests/test_manifest.py')

    const collisions = findCollisions(services)
    expect(collisions).toHaveLength(1)
    expect(collisions[0].kind).toBe('test-module')
    expect(collisions[0].name).toBe('test_manifest.py')
  })

  /**
   * The state that actually shipped: idea-scout absorbed the cost by
   * path-loading its scripts and prefixing its test modules. The guard must be
   * green here, or it would block the workaround that is currently holding.
   */
  it('passes on the shipped arrangement, where the newcomer worked around it', () => {
    file('ideation', 'scripts/__init__.py')
    file('ideation', 'tests/test_manifest.py')
    file('idea-scout', 'scripts/seed_build_types.py') // no __init__.py
    file('idea-scout', 'tests/test_idea_scout_manifest.py')

    expect(findCollisions(services)).toEqual([])
  })

  it('ignores platform trees and the Core API, which are not plugins', () => {
    file('_plugin-host', 'scripts/__init__.py')
    file('_template', 'scripts/__init__.py')
    file('api', 'scripts/__init__.py')
    file('ideation', 'scripts/__init__.py')

    expect(findCollisions(services)).toEqual([])
  })

  it('is a no-op with a single plugin, because a collision needs two', () => {
    file('ideation', 'scripts/__init__.py')
    file('ideation', 'tests/test_manifest.py')
    expect(findCollisions(services)).toEqual([])
  })

  it('reports every plugin claiming a name, not just the first two', () => {
    for (const p of ['alpha', 'beta', 'gamma']) file(p, 'scripts/__init__.py')
    const collisions = findCollisions(services)
    expect(collisions[0].plugins).toEqual(['alpha', 'beta', 'gamma'])
  })
})

describe('formatCollisions', () => {
  it('names the remedy for a package collision', () => {
    const text = formatCollisions([
      { kind: 'regular-package', name: 'scripts', plugins: ['idea-scout', 'ideation'] },
    ])
    expect(text).toContain("regular package 'scripts'")
    expect(text).toContain('do not merge across sys.path')
    expect(text).toContain('by file path')
  })

  it('suggests a plugin-scoped name for a test-module collision', () => {
    const text = formatCollisions([
      { kind: 'test-module', name: 'test_manifest.py', plugins: ['idea-scout', 'ideation'] },
    ])
    expect(text).toContain('idea-scout_test_manifest.py')
  })
})
