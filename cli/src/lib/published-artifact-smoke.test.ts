import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'
// @ts-expect-error -- plain .mjs inventory, same source root-asset-packaging.test.ts reads;
// see that file for why this is the one source of truth rather than a second list here.
import { PACKAGED_ROOT_ASSETS } from '../../scripts/packaged-root-assets.mjs'

/**
 * Run the ACTUAL published artifact as a separate process.
 *
 * ## The incident
 *
 * Every published `@biffo/cli` from 0.286.0 through 0.287.1 — three releases
 * — crashed on startup for every user, every command, with:
 *
 *   Error: Dynamic require of "fs" is not supported
 *     at getNodeSystem (…/dist/index.js:8579)
 *
 * #1580 wired `shared-file-reduction-guard.ts` (a top-level `import ts from
 * 'typescript'`) into `check.ts`, which `src/index.ts` imports unconditionally
 * to register every subcommand. `typescript` is a devDependency — tsup
 * externalises `dependencies` but BUNDLES `devDependencies` — so the whole
 * TypeScript compiler got inlined into the ESM bundle, and TypeScript's CJS
 * internals do a dynamic `require('fs')` that an ESM bundle cannot satisfy.
 * `dist/index.js` grew from ~580KB to 10.05MB and could not start.
 *
 * ## Why nothing caught it
 *
 * `pnpm --filter @biffo/cli test` — the only thing CI ever ran — is `vitest
 * run`, which executes SOURCE through Vite/esbuild's own transform, never
 * `tsup`'s bundle. A static `import` that eagerly crashes an ESM bundle at
 * load time is invisible to a test runner that never produces or loads that
 * bundle. `pnpm run typecheck` and `pnpm run lint` don't build either. Three
 * releases shipped a CLI that could not run for anyone, and every gate that
 * ran on them was green.
 *
 * ## What this file actually exercises
 *
 * Two levels, because they catch different things:
 *
 *   1. **The built bundle, run in place** (`dist/index.js`, freshly built by
 *      `beforeAll` from the current source tree) — this alone reproduces the
 *      0.286.0-0.287.1 crash, since it happens at module load, before any
 *      command logic runs. It also pins a bundle-size ceiling, so the next heavy
 *      transitive import that should have been external is caught by a
 *      number instead of a support ticket.
 *   2. **The `npm pack` tarball, installed fresh into an isolated temp
 *      directory, run as the installed `biffo` bin** — the stronger form,
 *      because it is the only one of the two with nothing above it. Run from
 *      inside this checkout, `dist/index.js` still finds `_skeletons/` and
 *      `core.version` by walking up to the real repo root whether or not
 *      `prepack`'s copy step or package.json `files` actually shipped them —
 *      which is exactly how #259 (`core.version` missing from every npm
 *      install) and #315 (`_skeletons/` missing, `biffo init` died at step
 *      6/6) reached users undetected. A real install has no repo root above
 *      it to fall back on.
 *
 * ## Why `npm pack` runs against a MIRROR, not this checkout's real `cli/`
 *
 * `prepack`/`postpack` (`scripts/sync-packaged-assets.mjs`) copy `_skeletons/`
 * and the packaged `scripts/*` files INTO the package directory being packed,
 * then remove them once the tarball is written. That is fine for a real
 * release, where nothing else touches the tree meanwhile — but this suite runs
 * many test files concurrently, and `root-asset-packaging.test.ts` asserts, in
 * the SAME `cli/` directory, that those paths are NOT committed there. Packing
 * this checkout's real `cli/` in place raced that assertion: it observed the
 * transient copies mid-pack and failed on a component this change never
 * touched. Packing an isolated MIRROR — the same repo-root assets, copied once
 * into a throwaway directory, packed from there — gets a real `npm pack` /
 * `prepack` / `postpack` cycle without mutating anything another test file can
 * see.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const repoRoot = resolve(packageRoot, '..')
const distEntry = join(packageRoot, 'dist', 'index.js')

interface Asset {
  path: string
  kind: 'file' | 'dir'
}
const rootAssets = PACKAGED_ROOT_ASSETS as Asset[]

/**
 * A healthy build sits at ~580KB (measured after this fix). The broken
 * 0.286.0-0.287.1 build was 10.05MB, all of it one wrongly-inlined
 * devDependency. 3MB gives real headroom for legitimate growth while still
 * catching an accidental bundle of anything typescript-compiler-sized. Raise
 * this deliberately, with a reason, if a real dependency needs the room —
 * don't silence the test that would otherwise catch the next one by accident.
 */
const MAX_BUNDLE_BYTES = 3 * 1024 * 1024

let installDir: string
let installedBin: string
let installedPackageRoot: string

beforeAll(() => {
  // Build FRESH from current source — this test's whole point is to catch
  // what the tree as it stands right now would ship, not a stale dist/ left
  // over from a previous run or a developer's last manual build. Writes only
  // to this checkout's real dist/, which nothing else in the suite asserts on
  // mid-build, so this part is safe to run in place.
  execFileSync('pnpm', ['run', 'build'], { cwd: packageRoot, stdio: 'pipe' })

  // Assemble the mirror: a throwaway copy of exactly the repo-root layout
  // `sync-packaged-assets.mjs` expects — <mirror>/_skeletons, <mirror>/scripts/*
  // (its real source assets) and <mirror>/cli/{package.json,dist,schemas,
  // scripts/sync-packaged-assets.mjs,scripts/packaged-root-assets.mjs} (the
  // minimum `prepack` and `npm pack` need). It resolves repoRoot as
  // `resolve(packageRoot, '..')` from ITS OWN copied script location, so as
  // long as the mirror preserves that one-level-below relationship, it finds
  // its (copied) source assets correctly without ever touching the real ones.
  const mirrorRoot = makeTmpDir('biffo-cli-pack-mirror')
  const mirrorCli = join(mirrorRoot, 'cli')
  mkdirSync(mirrorCli, { recursive: true })

  for (const asset of rootAssets) {
    cpSync(join(repoRoot, asset.path), join(mirrorRoot, asset.path), {
      recursive: asset.kind === 'dir',
    })
  }
  cpSync(join(packageRoot, 'package.json'), join(mirrorCli, 'package.json'))
  cpSync(join(packageRoot, 'dist'), join(mirrorCli, 'dist'), { recursive: true })
  cpSync(join(packageRoot, 'schemas'), join(mirrorCli, 'schemas'), { recursive: true })
  mkdirSync(join(mirrorCli, 'scripts'), { recursive: true })
  cpSync(
    join(packageRoot, 'scripts', 'sync-packaged-assets.mjs'),
    join(mirrorCli, 'scripts', 'sync-packaged-assets.mjs'),
  )
  cpSync(
    join(packageRoot, 'scripts', 'packaged-root-assets.mjs'),
    join(mirrorCli, 'scripts', 'packaged-root-assets.mjs'),
  )

  const tarballDir = makeTmpDir('biffo-cli-pack-smoke')
  const tarballName = execFileSync('npm', ['pack', '--silent', '--pack-destination', tarballDir], {
    cwd: mirrorCli,
    encoding: 'utf8',
  }).trim()
  const tarballPath = join(tarballDir, tarballName)
  expect(
    existsSync(tarballPath),
    `npm pack reported ${tarballName} but it is not at ${tarballPath}`,
  ).toBe(true)

  installDir = makeTmpDir('biffo-cli-install-smoke')
  // A bare directory with no package.json is not a valid npm install target.
  execFileSync('npm', ['init', '--yes'], { cwd: installDir, stdio: 'pipe' })
  // Install the TARBALL, not the workspace — this is what a real user's
  // `npx @biffo/cli` resolves, with none of this monorepo's hoisting or
  // workspace symlinks able to paper over a packaging gap.
  execFileSync('npm', ['install', '--no-audit', '--no-fund', tarballPath], {
    cwd: installDir,
    stdio: 'pipe',
  })
  installedBin = join(installDir, 'node_modules', '.bin', 'biffo')
  installedPackageRoot = join(installDir, 'node_modules', '@biffo', 'cli')
  // Build + mirror + pack + a real npm install of every runtime dependency
  // comfortably clears the suite's default 10s hook timeout; give this one
  // real headroom.
}, 120_000)

describe('the built bundle, run in place', () => {
  it('stays under a 3MB ceiling', () => {
    const size = statSync(distEntry).size
    expect(
      size,
      `dist/index.js is ${(size / 1024 / 1024).toFixed(2)}MB — something new is being bundled ` +
        'that should be marked --external instead. 0.286.0-0.287.1 shipped three broken ' +
        'releases exactly this way (a devDependency, `typescript`, got inlined). If this growth ' +
        'is legitimate, raise MAX_BUNDLE_BYTES deliberately with a reason rather than deleting ' +
        'this assertion.',
    ).toBeLessThan(MAX_BUNDLE_BYTES)
  })

  it('starts and reports --version without crashing', () => {
    const output = execFileSync(process.execPath, [distEntry, '--version'], {
      cwd: packageRoot,
      encoding: 'utf8',
    })
    expect(output.trim().length).toBeGreaterThan(0)
    // The literal 0.286.0-0.287.1 failure signature — belt-and-braces alongside
    // the exit-code check execFileSync already gives us (a non-zero exit throws).
    expect(output).not.toMatch(/Dynamic require|is not supported/)
  })

  it('starts and reports --help without crashing', () => {
    const output = execFileSync(process.execPath, [distEntry, '--help'], {
      cwd: packageRoot,
      encoding: 'utf8',
    })
    expect(output).toContain('Usage: biffo')
  })
})

describe('the tarball, installed fresh into an isolated directory, run standalone', () => {
  it('the installed binary starts — this is what 0.286.0-0.287.1 could not do for anyone', () => {
    expect(existsSync(installedBin), 'npm install did not produce a biffo bin').toBe(true)
    const output = execFileSync(process.execPath, [installedBin, '--version'], {
      cwd: installDir,
      encoding: 'utf8',
    })
    expect(output.trim().length).toBeGreaterThan(0)
    expect(output).not.toMatch(/Dynamic require|is not supported/)
  })

  it('the installed binary starts a subcommand too, not just --version', () => {
    const output = execFileSync(process.execPath, [installedBin, '--help'], {
      cwd: installDir,
      encoding: 'utf8',
    })
    expect(output).toContain('Usage: biffo')
  })

  /**
   * The #259/#315 shape specifically: an asset `prepack` copies in must be
   * reachable from INSIDE the installed package. Running dist/index.js
   * in-repo (the describe block above) cannot catch this — the upward walk
   * from `node_modules/@biffo/cli/dist/` in a checkout still finds the real
   * repo root's `_skeletons/`, so a packaging gap is invisible there and
   * visible only here.
   */
  it('root assets prepack copies in are reachable from the installed package', () => {
    expect(
      existsSync(
        join(installedPackageRoot, '_skeletons', 'sibling-template', 'biffo.sibling.json'),
      ),
    ).toBe(true)
  })
})
