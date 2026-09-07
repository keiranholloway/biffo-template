import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTemplateCheckout, sharedSyncIn } from '../test-utils/shared-sync-template.js'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * `shared-sync.sh --check`'s generic `scripts/*.test.sh` self-test-wiring
 * detector (#1909).
 *
 * ## Why this exists
 *
 * `guard-self-test-wiring.sh` (#1705) answers "does every guard this repo
 * holds actually get executed by this repo's own CI?" for the repo it runs
 * IN. It was never itself distributed, so it only ever answered that
 * question about biffo-template. `_skeletons/sibling-template/.github/
 * workflows/ci.yml` gained an equivalent inline check (#1710), but a
 * skeleton improvement only ever helps a repo scaffolded AFTERWARDS — it
 * never reaches an already-live sibling that only receives files
 * retroactively through a `shared-sync.sh` PR (the case that gated
 * tabsii-com/tabsii-geo#84).
 *
 * This is the fix at the distribution point: `--check` globs
 * `scripts/*.test.sh` in every applicable repo's own tree and checks every
 * workflow file in that SAME repo, so it catches any future guard shipped
 * unwired without biffo-template needing to know its name in advance —
 * proven live against the real estate while building this: it found real,
 * currently-unwired guards in both tabsii-crm and tabsii-geo.
 *
 * ## Why a template fixture rather than this repo's own checkout
 *
 * See `shared-sync-template.ts`'s own doc comment: running the real script
 * out of THIS repo's tree makes this repo's own git state part of what the
 * test depends on. `shared-sync-fixture-isolation.test.ts` fails any test in
 * this family that does not go through these helpers.
 */

function makeSatellite(
  estate: string,
  name: string,
  opts: { guards?: Record<string, string>; workflows?: Record<string, string> } = {},
): { dir: string; origin: string } {
  const origin = join(estate, `${name}.git`)
  execFileSync('git', ['init', '-q', '--bare', '-b', 'dev', origin], { stdio: 'pipe' })

  const dir = join(estate, name)
  execFileSync('git', ['clone', '-q', origin, dir], { stdio: 'pipe' })

  writeFileSync(join(dir, 'biffo.sibling.json'), '{}\n')
  // Matches the template fixture's own default shared file exactly, so a
  // satellite under test is never ALSO reported DRIFTED for an unrelated
  // reason — these tests isolate the self-test-wiring section specifically.
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'scripts', 'verify.sh'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(dir, 'scripts', 'verify.sh'), 0o755)

  for (const [rel, contents] of Object.entries(opts.guards ?? {})) {
    const p = join(dir, 'scripts', rel)
    writeFileSync(p, contents)
    chmodSync(p, 0o755)
  }
  for (const [rel, contents] of Object.entries(opts.workflows ?? {})) {
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(dir, '.github', 'workflows', rel), contents)
  }

  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'pipe' })
  execFileSync(
    'git',
    [
      '-C',
      dir,
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'user.name=Fixture',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'chore: fixture satellite',
    ],
    { stdio: 'pipe' },
  )
  execFileSync('git', ['-C', dir, 'push', '-q', '-u', 'origin', 'dev'], { stdio: 'pipe' })
  return { dir, origin }
}

function runCheck(templateDir: string, estate: string, repo: string) {
  try {
    const stdout = execFileSync(
      'bash',
      [sharedSyncIn(templateDir), '--check', '--estate', estate, '--repo', repo],
      { encoding: 'utf8' },
    )
    return { code: 0, out: stdout }
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string }
    return { code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

function fixture(root: string) {
  const estate = join(root, 'estate')
  mkdirSync(estate, { recursive: true })
  const template = makeTemplateCheckout(root)
  return { estate, template }
}

describe('shared-sync.sh --check: scripts/*.test.sh self-test-wiring (#1909)', () => {
  it('flags a guard with no caller anywhere in the repo’s own workflows', () => {
    const { estate, template } = fixture(makeTmpDir('self-test-wiring'))
    makeSatellite(estate, 'orphan-guard', {
      guards: { 'lonely.test.sh': '#!/bin/sh\nexit 0\n' },
      workflows: {
        'ci.yml':
          'name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n',
      },
    })

    const { code, out } = runCheck(template, estate, 'orphan-guard')

    expect(out).toContain('self-test wiring')
    expect(out).toContain('UNWIRED')
    expect(out).toContain('orphan-guard')
    expect(out).toContain('lonely.test.sh')
    expect(code).not.toBe(0)
  })

  it('does not flag a guard that a workflow actually calls', () => {
    const { estate, template } = fixture(makeTmpDir('self-test-wiring'))
    makeSatellite(estate, 'wired-guard', {
      guards: { 'covered.test.sh': '#!/bin/sh\nexit 0\n' },
      workflows: {
        'ci.yml':
          'name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: sh scripts/covered.test.sh\n',
      },
    })

    const { code, out } = runCheck(template, estate, 'wired-guard')

    expect(out).toContain('self-test wiring')
    expect(out).not.toContain('UNWIRED')
    expect(out).toMatch(/ok\s+wired-guard\s+1 guard\(s\), all wired/)
    expect(code).toBe(0)
  })

  it('does not flag a repo holding zero scripts/*.test.sh files — absence is not a finding', () => {
    const { estate, template } = fixture(makeTmpDir('self-test-wiring'))
    makeSatellite(estate, 'no-guards', {
      workflows: {
        'ci.yml':
          'name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n',
      },
    })

    const { code, out } = runCheck(template, estate, 'no-guards')

    expect(out).toContain('self-test wiring')
    expect(out).not.toContain('UNWIRED')
    // The section itself must report nothing for this repo — no "ok" line
    // either — since holding zero guards is not a finding either way.
    const section = out.slice(out.indexOf('self-test wiring'))
    expect(section).not.toContain('no-guards')
    expect(code).toBe(0)
  })

  it('does not count a comment-only mention of the guard’s filename as wiring it', () => {
    const { estate, template } = fixture(makeTmpDir('self-test-wiring'))
    makeSatellite(estate, 'commented-only', {
      guards: { 'mentioned.test.sh': '#!/bin/sh\nexit 0\n' },
      workflows: {
        'ci.yml':
          'name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      # sh scripts/mentioned.test.sh (documented here, never actually run)\n      - run: echo hi\n',
      },
    })

    const { code, out } = runCheck(template, estate, 'commented-only')

    expect(out).toContain('UNWIRED')
    expect(out).toContain('mentioned.test.sh')
    expect(code).not.toBe(0)
  })

  it('counts a caller wrapped inside a multi-line run block, the same shape guard-self-test-wiring.sh itself accepts', () => {
    const { estate, template } = fixture(makeTmpDir('self-test-wiring'))
    makeSatellite(estate, 'wrapped-guard', {
      guards: { 'wrapped.test.sh': '#!/bin/sh\nexit 0\n' },
      workflows: {
        // Mirrors release-guards.yml's real docker-wrapped self-test shape:
        // the filename is not the first token on its line, but it IS a real,
        // non-comment reference.
        'release-guards.yml':
          'name: Release Guards\non: push\njobs:\n  guard:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          docker run --rm -v "$PWD":/repo debian:bookworm-slim sh /repo/scripts/wrapped.test.sh\n',
      },
    })

    const { code, out } = runCheck(template, estate, 'wrapped-guard')

    expect(out).not.toContain('UNWIRED')
    expect(out).toMatch(/ok\s+wrapped-guard\s+1 guard\(s\), all wired/)
    expect(code).toBe(0)
  })
})
