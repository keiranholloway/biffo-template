import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertBuildIsFresh,
  checkBuildFreshness,
  SKIP_ENV_VAR,
  type BuildFreshnessResult,
} from './build-freshness.js'
import { makeTmpDir } from '../test-utils/tmp.js'

let root: string

/** Set an mtime a whole number of seconds from a fixed epoch, so comparisons
 * never depend on filesystem timestamp granularity. */
const BASE = 1_700_000_000
function touch(path: string, offsetSeconds: number): void {
  const t = BASE + offsetSeconds
  utimesSync(path, t, t)
}

function writeFile(path: string, offsetSeconds: number, content = '// x\n'): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  touch(path, offsetSeconds)
}

/** A fake biffo package tree; the check runs as if invoked from dist/. */
function scaffoldPackage(options: { withSrc?: boolean; withDist?: boolean } = {}): void {
  const { withSrc = true, withDist = true } = options
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'biffo' }))
  if (withDist) writeFile(join(root, 'dist', 'index.js'), 100)
  if (withSrc) writeFile(join(root, 'src', 'index.ts'), 50)
}

function runFromDist(env: Record<string, string | undefined> = {}): BuildFreshnessResult {
  return checkBuildFreshness({
    moduleUrl: pathToFileURL(join(root, 'dist', 'index.js')).href,
    env,
  })
}

beforeEach(() => {
  root = makeTmpDir('biffo-freshness')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('checkBuildFreshness', () => {
  it('reports fresh when dist/index.js is newer than every source file', () => {
    scaffoldPackage()
    expect(runFromDist().status).toBe('fresh')
  })

  it('reports stale when a source file is newer than the build', () => {
    scaffoldPackage()
    writeFile(join(root, 'src', 'commands', 'init.ts'), 200)

    const result = runFromDist()
    expect(result.status).toBe('stale')
    expect(result.newerSources).toEqual([join('src', 'commands', 'init.ts')])
  })

  it('lists the newest changed sources first', () => {
    scaffoldPackage()
    writeFile(join(root, 'src', 'a.ts'), 150)
    writeFile(join(root, 'src', 'b.ts'), 300)

    expect(runFromDist().newerSources).toEqual([join('src', 'b.ts'), join('src', 'a.ts')])
  })

  it('ignores test files and the vitest setup file', () => {
    scaffoldPackage()
    writeFile(join(root, 'src', 'lib', 'thing.test.ts'), 500)
    writeFile(join(root, 'src', 'test-setup.ts'), 500)

    expect(runFromDist().status).toBe('fresh')
  })

  it('ignores node_modules nested under src', () => {
    scaffoldPackage()
    writeFile(join(root, 'src', 'node_modules', 'dep', 'index.ts'), 500)

    expect(runFromDist().status).toBe('fresh')
  })

  it('detects staleness in non-.ts assets that get bundled, such as JSON', () => {
    scaffoldPackage()
    writeFile(join(root, 'src', 'config', 'defaults.json'), 400, '{}')

    expect(runFromDist().status).toBe('stale')
  })

  // --- cases that must NOT false-positive -----------------------------------

  it('skips a shipped package that has dist but no src', () => {
    scaffoldPackage({ withSrc: false })

    const result = runFromDist()
    expect(result.status).toBe('skipped')
    expect(result.reason).toMatch(/shipped package/)
  })

  it('skips when running from source rather than the build', () => {
    scaffoldPackage()
    writeFile(join(root, 'src', 'newer.ts'), 900)

    const result = checkBuildFreshness({
      moduleUrl: pathToFileURL(join(root, 'src', 'lib', 'build-freshness.ts')).href,
      env: {},
    })
    expect(result.status).toBe('skipped')
    expect(result.reason).toMatch(/running from source/)
  })

  it('skips when dist/index.js is missing', () => {
    scaffoldPackage({ withDist: false })
    mkdirSync(join(root, 'dist'), { recursive: true })

    expect(runFromDist().status).toBe('skipped')
  })

  it('skips when no package.json can be found above the module', () => {
    const orphan = makeTmpDir('biffo-orphan')
    try {
      const result = checkBuildFreshness({
        moduleUrl: pathToFileURL(join(orphan, 'dist', 'index.js')).href,
        env: {},
      })
      // A temp dir has no package.json ancestor on any supported platform.
      expect(result.status).toBe('skipped')
    } finally {
      rmSync(orphan, { recursive: true, force: true })
    }
  })

  it('honours the explicit escape hatch', () => {
    scaffoldPackage()
    writeFile(join(root, 'src', 'newer.ts'), 900)

    for (const value of ['1', 'true']) {
      const result = runFromDist({ [SKIP_ENV_VAR]: value })
      expect(result.status).toBe('skipped')
      expect(result.reason).toContain(SKIP_ENV_VAR)
    }
  })

  it('does not treat an unset or unrelated escape-hatch value as an opt-out', () => {
    scaffoldPackage()
    writeFile(join(root, 'src', 'newer.ts'), 900)

    expect(runFromDist({ [SKIP_ENV_VAR]: '0' }).status).toBe('stale')
    expect(runFromDist({}).status).toBe('stale')
  })
})

describe('assertBuildIsFresh', () => {
  it('throws with rebuild instructions when the build is stale', () => {
    scaffoldPackage()
    writeFile(join(root, 'src', 'commands', 'init.ts'), 200)

    const call = () =>
      assertBuildIsFresh({
        moduleUrl: pathToFileURL(join(root, 'dist', 'index.js')).href,
        env: {},
      })

    expect(call).toThrow(/Refusing to run/)
    expect(call).toThrow(/pnpm --filter @biffo\/cli build/)
    expect(call).toThrow(/src[/\\]commands[/\\]init\.ts/)
  })

  it('is a no-op when fresh, shipped, or explicitly skipped', () => {
    scaffoldPackage()
    expect(() =>
      assertBuildIsFresh({
        moduleUrl: pathToFileURL(join(root, 'dist', 'index.js')).href,
        env: {},
      }),
    ).not.toThrow()

    writeFile(join(root, 'src', 'newer.ts'), 900)
    expect(() =>
      assertBuildIsFresh({
        moduleUrl: pathToFileURL(join(root, 'dist', 'index.js')).href,
        env: { [SKIP_ENV_VAR]: '1' },
      }),
    ).not.toThrow()
  })

  it('truncates a long list of changed files', () => {
    scaffoldPackage()
    for (let i = 0; i < 8; i++) writeFile(join(root, 'src', `f${i}.ts`), 200 + i)

    try {
      assertBuildIsFresh({
        moduleUrl: pathToFileURL(join(root, 'dist', 'index.js')).href,
        env: {},
      })
      throw new Error('expected assertBuildIsFresh to throw')
    } catch (err) {
      expect((err as Error).message).toContain('… and 3 more')
    }
  })
})
