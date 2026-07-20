import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error -- plain .mjs inventory, shared with the prepack script so
// there is exactly one source of truth for what the tarball must carry.
import {
  PACKAGED_ROOT_ASSETS,
  RESOLVER_SITES,
  UNPACKAGED_ROOT_ASSETS,
} from '../../scripts/packaged-root-assets.mjs'
import { findCoreVersionUpward, getLatestCoreVersion } from './core-version.js'
import { restorePackagedDotfiles } from './skeleton-dotfiles.js'

/**
 * Drift guard for the packaging of every repo-root asset the CLI resolves by
 * walking UP from its own module location.
 *
 * That walk reaches the repo root inside a template checkout, so in-repo tests
 * pass whether or not the asset is actually shipped. A published package has
 * nothing above `node_modules/@biffo/cli/dist/`, so each asset must be BOTH
 * copied in by `prepack` AND listed in package.json `files`. Drop either half
 * and the break is invisible until a real npm install.
 *
 * It has bitten twice: #259 (`core.version` — `biffo core status` failed for
 * every npm user) and #315 (`_skeletons/` — `biffo init` created both repos then
 * died at step 6/6 with an empty app sibling). The first was guarded per-asset;
 * the second slipped through because the guard only knew about the first. So
 * this file is driven by the shared inventory and additionally asserts that no
 * NEW resolver appears without its asset being classified.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const repoRoot = resolve(packageRoot, '..')

interface PackageJson {
  name: string
  bin: Record<string, string>
  files: string[]
  scripts: Record<string, string>
  publishConfig?: { access?: string }
}

interface Asset {
  path: string
  kind: 'file' | 'dir'
  sentinel: string
  why: string
}

const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as PackageJson
const assets = PACKAGED_ROOT_ASSETS as Asset[]
const resolverSites = RESOLVER_SITES as { file: string; asset: string | null; packaged: boolean }[]
const unpackaged = UNPACKAGED_ROOT_ASSETS as { path: string; why: string }[]

describe('published package manifest', () => {
  /**
   * Scoped, not bare `biffo`: npm rejects the unscoped name as "too similar to
   * existing package diff" under its typosquatting protection, which a registry
   * 404 does not reveal — only an actual publish attempt does. The bin stays
   * `biffo`, so `npx @biffo/cli init` still gives the user `biffo`.
   */
  it('is the scoped `@biffo/cli` package with a `biffo` bin', () => {
    expect(pkg.name).toBe('@biffo/cli')
    expect(pkg.bin.biffo).toBe('./dist/index.js')
  })

  it('publishes the scope publicly, or a scoped package defaults to private', () => {
    expect(pkg.publishConfig?.access).toBe('public')
  })

  it('runs the asset sync on prepack and undoes it on postpack', () => {
    expect(pkg.scripts.prepack).toContain('sync-packaged-assets')
    // Left behind, the copies would shadow the repo-root originals and serve
    // stale content to developers who edit them without repacking.
    expect(pkg.scripts.postpack).toContain('sync-packaged-assets')
    expect(pkg.scripts.postpack).toContain('--clean')
  })

  it.each(assets)('ships $path, so the upward walk resolves outside a checkout', (asset) => {
    expect(pkg.files).toContain(asset.path)
  })

  it.each(assets)('does not leave a committed $path inside the package', (asset) => {
    expect(existsSync(join(packageRoot, asset.path))).toBe(false)
  })

  it('every asset exists at the repo root to be copied from', () => {
    for (const asset of assets) {
      expect(existsSync(join(repoRoot, asset.path)), `${asset.path} missing from repo root`).toBe(
        true,
      )
      expect(existsSync(join(repoRoot, asset.sentinel)), `${asset.sentinel} missing`).toBe(true)
    }
  })
})

/**
 * The generalisation. Anything that walks up from `import.meta.url` is resolving
 * a companion asset and is therefore exposed to this bug class. Every such
 * module must be declared in RESOLVER_SITES with the asset it seeks, and that
 * asset must be classified as packaged or deliberately unpackaged. A new
 * resolver added without that classification fails here — by test, rather than
 * by a failed production deploy.
 */
describe('resolver registry covers every upward-walking module', () => {
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) return sourceFiles(full)
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return []
      return [full]
    })

  it('matches the modules that actually reference import.meta.url', () => {
    const found = sourceFiles(join(packageRoot, 'src'))
      .filter((file) => readFileSync(file, 'utf8').includes('import.meta.url'))
      .map((file) => relative(packageRoot, file).replaceAll('\\', '/'))
      .sort()

    expect(
      found,
      'A module resolves an asset by walking up from import.meta.url but is not declared in ' +
        'cli/scripts/packaged-root-assets.mjs. Declare it, and classify the asset it resolves ' +
        'as packaged (add it to PACKAGED_ROOT_ASSETS and package.json "files") or deliberately ' +
        'unpackaged (UNPACKAGED_ROOT_ASSETS, with the reason). See #315.',
    ).toEqual(resolverSites.map((site) => site.file).sort())
  })

  it('classifies every resolved asset as packaged or deliberately unpackaged', () => {
    const packaged = new Set(assets.map((a) => a.path))
    const excluded = new Set(unpackaged.map((a) => a.path))
    for (const site of resolverSites) {
      if (site.asset === null) continue
      expect(
        packaged.has(site.asset) || excluded.has(site.asset),
        `${site.file} resolves ${site.asset}, which is in neither inventory`,
      ).toBe(true)
      expect(packaged.has(site.asset), `${site.asset} packaged flag disagrees`).toBe(site.packaged)
    }
  })

  it('documents why each unpackaged asset is excluded', () => {
    for (const asset of unpackaged) {
      expect(asset.why.length, `${asset.path} needs a reason`).toBeGreaterThan(40)
    }
  })
})

describe('sync-packaged-assets.mjs', () => {
  let dest: string
  beforeEach(() => {
    dest = mkdtempSync(join(tmpdir(), 'biffo-pack-'))
  })
  afterEach(() => {
    rmSync(dest, { recursive: true, force: true })
  })

  const run = (...args: string[]): void => {
    execFileSync(
      process.execPath,
      [join(packageRoot, 'scripts', 'sync-packaged-assets.mjs'), ...args],
      { stdio: 'pipe' },
    )
  }

  it.each(assets)('copies the repo-root $path into the package', (asset) => {
    run(dest)
    const copied = join(dest, asset.path)
    expect(existsSync(copied)).toBe(true)
    expect(statSync(copied).isDirectory()).toBe(asset.kind === 'dir')
    // Present is not enough — an empty directory would ship, satisfy a naive
    // "is it in the tarball" check, and still fail at use.
    expect(existsSync(join(dest, asset.sentinel)), `${asset.sentinel} missing from copy`).toBe(true)
    if (asset.kind === 'dir') {
      expect(readdirSync(copied).length).toBeGreaterThan(0)
    }
  })

  it('copies core.version verbatim', () => {
    run(dest)
    expect(readFileSync(join(dest, 'core.version'), 'utf8')).toBe(
      readFileSync(join(repoRoot, 'core.version'), 'utf8'),
    )
  })

  it('copies the sibling skeleton the way biffo init consumes it', () => {
    run(dest)
    const skeleton = join(dest, '_skeletons', 'sibling-template')
    expect(existsSync(join(skeleton, 'biffo.sibling.json'))).toBe(true)
    // Nested trees must survive the recursive copy — this is what step 6/6
    // rewrites into the new app sibling repo.
    expect(existsSync(join(skeleton, 'apps'))).toBe(true)
    expect(existsSync(join(skeleton, 'infra'))).toBe(true)
  })

  /**
   * npm strips `.gitignore` from tarballs unconditionally. Verified by
   * `npm pack`: adding `_skeletons/**‍/.gitignore` to `files` does not override
   * it. The skeleton's .gitignore is shipped content, so it travels as
   * `_gitignore` and is renamed back at scaffold time.
   */
  it('renames skeleton .gitignore files to a name npm will actually ship', () => {
    run(dest)
    const skeleton = join(dest, '_skeletons', 'sibling-template')
    expect(existsSync(join(skeleton, '_gitignore'))).toBe(true)
    expect(existsSync(join(skeleton, '.gitignore'))).toBe(false)
    // Content must survive the rename intact — this becomes the scaffolded
    // repo's .gitignore, and a truncated one silently commits secrets/state.
    expect(readFileSync(join(skeleton, '_gitignore'), 'utf8')).toBe(
      readFileSync(join(repoRoot, '_skeletons', 'sibling-template', '.gitignore'), 'utf8'),
    )
  })

  it('restorePackagedDotfiles turns the packaged copy back into a real .gitignore', () => {
    run(dest)
    const skeleton = join(dest, '_skeletons', 'sibling-template')
    const restored = restorePackagedDotfiles(skeleton)

    expect(restored).toContain(join(skeleton, '.gitignore'))
    expect(existsSync(join(skeleton, '.gitignore'))).toBe(true)
    expect(existsSync(join(skeleton, '_gitignore'))).toBe(false)
    // Full round trip: what a scaffolded repo ends up with must equal the source.
    expect(readFileSync(join(skeleton, '.gitignore'), 'utf8')).toBe(
      readFileSync(join(repoRoot, '_skeletons', 'sibling-template', '.gitignore'), 'utf8'),
    )
    // The ignore rules that keep a scaffolded repo from committing junk.
    const rules = readFileSync(join(skeleton, '.gitignore'), 'utf8')
    for (const rule of ['node_modules', '.terraform', '.env']) {
      expect(rules, `${rule} must be ignored in scaffolded repos`).toContain(rule)
    }
  })

  it('restorePackagedDotfiles is a no-op on a template checkout', () => {
    // Scaffolding from a checkout copies an already-correct `.gitignore`; the
    // restore must not disturb it.
    expect(restorePackagedDotfiles(join(repoRoot, '_skeletons'))).toEqual([])
    expect(existsSync(join(repoRoot, '_skeletons', 'sibling-template', '.gitignore'))).toBe(true)
  })

  it('--clean removes every copy again', () => {
    run(dest)
    run('--clean', dest)
    for (const asset of assets) {
      expect(existsSync(join(dest, asset.path)), `${asset.path} survived --clean`).toBe(false)
    }
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

  it('without the copies, resolution from that same tree fails', () => {
    // The bug this guards: the tarball ships dist/ only, and nothing above it in
    // node_modules carries the asset.
    expect(findCoreVersionUpward(join(dest, 'dist'))).toBeNull()
    expect(() => getLatestCoreVersion(join(dest, 'dist'))).toThrow(/missing its core version/)
    expect(existsSync(join(dest, '_skeletons', 'sibling-template'))).toBe(false)
  })
})
