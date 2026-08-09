import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  makeTemplateCheckout,
  sharedSyncIn,
  writeSatelliteBridge,
} from '../test-utils/shared-sync-template.js'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * `scripts/shared-sync.sh --deliver-overrides` — the additive-only writer
 * half of `overridesFloor` (#1352), and the mode this drives end to end.
 *
 * ## Why the full script, not the extracted function
 *
 * `shared-sync-overrides-delivery.test.ts` proves `apply_overrides_floor`
 * itself in isolation — the merge is additive-only, format-preserving,
 * fails closed on anything it cannot be sure of. What that file CANNOT
 * prove is the thing this issue is actually about: that the mode wired
 * around it finds the right repos, stages them, calls the function, reports
 * correctly, and — the property that matters most given this pass was told
 * not to open PRs in any satellite — never pushes and never mutates the
 * satellite's own `origin/dev`. Only driving the real script proves that.
 *
 * ## Why a template fixture rather than this repo's own checkout
 *
 * See `shared-sync-template.ts`'s own doc comment: running the real script
 * out of THIS repo's tree makes this repo's own git state (behind/ahead of
 * `origin/dev`, uncommitted changes) part of what the test depends on.
 * `shared-sync-fixture-isolation.test.ts` fails any test in this family that
 * does not go through these helpers.
 */

const GIT_ID = [
  '-c',
  'user.email=fixture@example.invalid',
  '-c',
  'user.name=Fixture',
  '-c',
  'commit.gpgsign=false',
]

function git(dir: string, ...args: string[]): void {
  execFileSync('git', ['-C', dir, ...GIT_ID, ...args], { stdio: 'pipe' })
}

const CANONICAL_PACKAGE_JSON = `{
  "name": "sibling-template-frontend",
  "pnpm": {
    "overrides": {
      "postcss@<8.5.18": ">=8.5.18",
      "sharp@<0.35.0": ">=0.35.0",
      "nanoid@<3.3.17": ">=3.3.17 <4"
    }
  }
}
`

/** A minimal satellite: a bare origin plus a clone on `dev`. */
function makeSatellite(
  estate: string,
  name: string,
  frontendPackageJson: string,
): { dir: string; origin: string } {
  const origin = join(estate, `${name}.git`)
  mkdirSync(origin, { recursive: true })
  execFileSync('git', ['init', '--bare', '--initial-branch=dev', origin], { stdio: 'pipe' })

  const dir = join(estate, name)
  execFileSync('git', ['clone', origin, dir], { stdio: 'pipe' })
  git(dir, 'config', 'user.email', 'fixture@example.invalid')
  git(dir, 'config', 'user.name', 'Fixture')
  git(dir, 'config', 'commit.gpgsign', 'false')

  writeFileSync(join(dir, 'biffo.sibling.json'), '{}\n')
  writeFileSync(join(dir, '.gitignore'), '.worktrees/\n')
  mkdirSync(join(dir, 'apps', 'frontend'), { recursive: true })
  writeFileSync(join(dir, 'apps', 'frontend', 'package.json'), frontendPackageJson)
  writeSatelliteBridge(dir)
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'scripts', 'verify.sh'), '#!/bin/sh\nexit 0\n')

  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'chore: fixture satellite')
  git(dir, 'push', '-q', '-u', 'origin', 'dev')
  return { dir, origin }
}

function runDeliver(templateDir: string, estate: string): { code: number; out: string } {
  // `overridesFloor`'s canonical path is read relative to cwd (see its
  // comment in the script: "read from THIS repo's working tree"), the same
  // way AGENTS.md's own documented usage always invokes the script from the
  // template's own root (`sh scripts/shared-sync.sh --check --estate ~/code`).
  // Omitting `cwd` here would resolve `_skeletons/...` against the test
  // runner's own directory instead and misreport every canonical read as
  // unparsable — caught by this test failing that way before `cwd` was added.
  const result = spawnSync(
    'sh',
    [sharedSyncIn(templateDir), '--deliver-overrides', '--estate', estate],
    {
      encoding: 'utf8',
      cwd: templateDir,
    },
  )
  return { code: result.status ?? -1, out: (result.stdout ?? '') + (result.stderr ?? '') }
}

describe('shared-sync.sh --deliver-overrides', () => {
  it('reports WOULD DELIVER for a repo missing a canonical override key, and writes nothing durable', () => {
    const root = makeTmpDir('deliver-overrides')
    const estate = join(root, 'estate')
    mkdirSync(estate, { recursive: true })

    const template = makeTemplateCheckout(estate, {
      manifest: {
        overridesFloor: {
          'apps/frontend/package.json': '_skeletons/sibling-template/apps/frontend/package.json',
        },
      },
      files: {
        '_skeletons/sibling-template/apps/frontend/package.json': CANONICAL_PACKAGE_JSON,
      },
    })

    const missingNanoid = `{
  "name": "tabsii-fixture",
  "pnpm": {
    "overrides": {
      "postcss@<8.5.18": ">=8.5.18",
      "sharp@<0.35.0": ">=0.35.0"
    }
  }
}
`
    const { dir: satelliteDir, origin: satelliteOrigin } = makeSatellite(
      estate,
      'tabsii-fixture',
      missingNanoid,
    )
    const beforeSha = execFileSync('git', ['-C', satelliteOrigin, 'rev-parse', 'dev'], {
      encoding: 'utf8',
    }).trim()

    const { code, out } = runDeliver(template, estate)

    expect(out).toContain('WOULD DELIVER')
    expect(out).toContain('tabsii-fixture')
    expect(out).toContain('nanoid@<3.3.17')
    expect(out).toContain('1 repo(s) would receive a delivery, 0 failure(s)')
    expect(out).toContain('Nothing pushed, no PR opened')
    expect(code).toBe(0)

    // The core safety property for this pass: nothing pushed, no PR opened.
    // The satellite's bare origin -- the only thing another machine could
    // see -- must be bit-for-bit where it started.
    const afterSha = execFileSync('git', ['-C', satelliteOrigin, 'rev-parse', 'dev'], {
      encoding: 'utf8',
    }).trim()
    expect(afterSha).toBe(beforeSha)

    // And the local scratch branch/worktree this mode uses must be cleaned
    // up rather than left behind — same hygiene `stage_repo` observes.
    const branches = execFileSync(
      'git',
      ['-C', satelliteDir, 'branch', '--list', 'chore/deliver-overrides'],
      {
        encoding: 'utf8',
      },
    )
    expect(branches.trim()).toBe('')
  })

  it('reports "floor already met" and delivers nothing when the satellite already matches', () => {
    const root = makeTmpDir('deliver-overrides')
    const estate = join(root, 'estate')
    mkdirSync(estate, { recursive: true })

    const template = makeTemplateCheckout(estate, {
      manifest: {
        overridesFloor: {
          'apps/frontend/package.json': '_skeletons/sibling-template/apps/frontend/package.json',
        },
      },
      files: {
        '_skeletons/sibling-template/apps/frontend/package.json': CANONICAL_PACKAGE_JSON,
      },
    })

    makeSatellite(estate, 'tabsii-fixture-current', CANONICAL_PACKAGE_JSON)

    const { code, out } = runDeliver(template, estate)

    expect(out).toContain('floor already met')
    expect(out).not.toContain('WOULD DELIVER')
    expect(out).toContain('0 repo(s) would receive a delivery, 0 failure(s)')
    expect(code).toBe(0)
  })

  it('exits 0 with a clear message when no overridesFloor entries are declared', () => {
    const root = makeTmpDir('deliver-overrides')
    const estate = join(root, 'estate')
    mkdirSync(estate, { recursive: true })
    const template = makeTemplateCheckout(estate)

    const { code, out } = runDeliver(template, estate)

    expect(code).toBe(0)
    expect(out).toContain('nothing to deliver')
  })
})
