import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findCoreVersionUpward, getLatestCoreVersion } from './core-version.js'

/**
 * Drift guard for the packaging half of ADR-0006's version resolution.
 *
 * `getLatestCoreVersion()` walks UP from the running module to find
 * `core.version`. Inside the template checkout that reaches the repo root. A
 * globally installed `biffo` has nothing above it, so the published tarball
 * must carry its own copy beside `dist/` — which requires BOTH the `prepack`
 * hook that writes it and the package.json `files` entry that ships it.
 *
 * Dropping either one breaks `biffo core status` for every npm user while every
 * test that runs inside this repo keeps passing (the upward walk still finds the
 * repo root). Hence this file.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const repoRoot = resolve(packageRoot, '..')

interface PackageJson {
  name: string
  bin: Record<string, string>
  files: string[]
  scripts: Record<string, string>
}

const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as PackageJson

describe('published package manifest', () => {
  it('is the unscoped `biffo` package with a `biffo` bin', () => {
    expect(pkg.name).toBe('biffo')
    expect(pkg.bin.biffo).toBe('./dist/index.js')
  })

  it('ships core.version, so the upward walk resolves outside a template checkout', () => {
    expect(pkg.files).toContain('core.version')
  })

  it('writes core.version on prepack and removes it again on postpack', () => {
    expect(pkg.scripts.prepack).toContain('sync-core-version')
    // Left behind, the copy would shadow the repo-root file and report a stale
    // "latest" version to developers who bump core.version without repacking.
    expect(pkg.scripts.postpack).toContain('core.version')
  })

  it('does not leave a committed core.version inside the package', () => {
    expect(existsSync(join(packageRoot, 'core.version'))).toBe(false)
  })
})

describe('sync-core-version.mjs', () => {
  let dest: string
  beforeEach(() => {
    dest = mkdtempSync(join(tmpdir(), 'biffo-pack-'))
  })
  afterEach(() => {
    rmSync(dest, { recursive: true, force: true })
  })

  const run = (target: string): void => {
    execFileSync(
      process.execPath,
      [join(packageRoot, 'scripts', 'sync-core-version.mjs'), target],
      {
        stdio: 'pipe',
      },
    )
  }

  it('copies the repo-root core.version verbatim', () => {
    run(dest)
    const expected = readFileSync(join(repoRoot, 'core.version'), 'utf8')
    expect(readFileSync(join(dest, 'core.version'), 'utf8')).toBe(expected)
  })

  it('makes version resolution succeed from a tree with no core.version above it', () => {
    // Simulate the installed layout: <pkg>/core.version with <pkg>/dist beside
    // it, rooted in a temp dir that has no core.version anywhere above.
    run(dest)
    const distLike = join(dest, 'dist')
    expect(findCoreVersionUpward(distLike)).toBe(join(dest, 'core.version'))
    expect(getLatestCoreVersion(distLike)).toBe(
      readFileSync(join(repoRoot, 'core.version'), 'utf8').trim(),
    )
  })

  it('without the copy, resolution from that same tree fails', () => {
    // The bug this guards: the tarball ships dist/ only, and nothing above it
    // in node_modules carries a core version.
    expect(findCoreVersionUpward(join(dest, 'dist'))).toBeNull()
    expect(() => getLatestCoreVersion(join(dest, 'dist'))).toThrow(/missing its core version/)
  })
})
