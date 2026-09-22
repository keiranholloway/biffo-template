import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  anchorToOrigin,
  realSharedSync,
  writeSatelliteBridge,
} from '../test-utils/shared-sync-template.js'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * `filesFromSkeleton`'s `exceptions` field (#2051): a `sync` entry may name a
 * repo that keeps its own diverged copy forever, instead of that repo's
 * legitimate per-repo content being silently deleted by the next round.
 *
 * ## Why
 *
 * `.github/workflows/release-guards.yml` was unconditional `sync` on the
 * premise that it is pure governance plumbing with no legitimate per-repo
 * content. `biffo-plugin-ideation` broke that premise: it folds a
 * `pnpm/action-setup` step and a JS dependency audit step into Release
 * Guards (ideation#160), because that workflow is one of its three REQUIRED
 * status checks and the fleet's token cannot add a new required context via
 * branch protection. An ordinary sync round (ideation PR #167) correctly
 * treated the divergence as drift and deleted both steps, reproduced live and
 * confirmed against `origin/dev` of both repos.
 *
 * This proves the fix two ways: `in_skeleton_exceptions` in isolation (the
 * matcher itself, including the boundary case a comma-list containment check
 * can get wrong -- a repo name that is a superstring of, or substring of, a
 * declared exception must not match), and a real end-to-end sync round with a
 * fake `gh` and two real satellite clones, proving the NAMED repo's diverged
 * copy survives a round that still corrects the UNNAMED repo's identical
 * divergence -- the exact shape of the incident this issue reports.
 */

// ---------------------------------------------------------------------------
// Part 1: in_skeleton_exceptions() in isolation.
// ---------------------------------------------------------------------------

/** The `in_skeleton_exceptions` definition, lifted out of the script -- same
 * extraction idiom as `shared-sync-has-python-fail-closed.test.ts`'s
 * `has_python` and `shared-sync-ship-guard.test.ts`'s
 * `require_staged_worktree`: the function takes only its own arguments, so it
 * can be evaluated without the rest of the script's state. */
function guardSource(): string {
  const lines = readFileSync(realSharedSync, 'utf8').split('\n')
  const start = lines.findIndex((l) => l === 'in_skeleton_exceptions() {')
  expect(start, 'in_skeleton_exceptions() not found -- has it been renamed?').toBeGreaterThan(-1)
  const end = lines.findIndex((l, i) => i > start && l === '}')
  expect(end, 'no closing brace for in_skeleton_exceptions()').toBeGreaterThan(start)
  return lines.slice(start, end + 1).join('\n')
}

function callGuard(dir: string, exceptions: string): { code: number; out: string } {
  const program = `${guardSource()}\nin_skeleton_exceptions ${JSON.stringify(dir)} ${JSON.stringify(exceptions)}\n`
  try {
    execFileSync('bash', ['-c', program], { encoding: 'utf8' })
    return { code: 0, out: '' }
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string }
    return { code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

describe('in_skeleton_exceptions', () => {
  it('matches a repo named alone', () => {
    expect(callGuard('/some/path/biffo-plugin-ideation', 'biffo-plugin-ideation').code).toBe(0)
  })

  it('matches a repo named among several, comma-separated', () => {
    expect(callGuard('/x/biffo-plugin-ideation', 'foo,biffo-plugin-ideation,bar').code).toBe(0)
  })

  it('does not match a repo not named at all', () => {
    expect(callGuard('/x/biffo-plugin-marketing', 'biffo-plugin-ideation').code).toBe(1)
  })

  it("does not match on the '-' sentinel for 'no exceptions declared'", () => {
    expect(callGuard('/x/biffo-plugin-ideation', '-').code).toBe(1)
  })

  // Boundary safety: a comma-delimited containment check implemented as a
  // glob-style `case` pattern can accidentally match a SUPERSTRING or
  // SUBSTRING of a declared name rather than the whole path segment. Both
  // directions are must-NOT-catch cases -- a real Biffo repo name
  // (`biffo-plugin-ideation`) really does sit as a substring of a plausible
  // sibling name (`biffo-plugin-ideation-preview`), so this is not a
  // hypothetical shape.
  it('does not match a repo whose name is a superstring of the declared exception', () => {
    expect(callGuard('/x/biffo-plugin-ideation-preview', 'biffo-plugin-ideation').code).toBe(1)
  })

  it('does not match a repo whose name is a substring of the declared exception', () => {
    expect(callGuard('/x/biffo-plugin-ideation', 'biffo-plugin-ideation-preview').code).toBe(1)
  })

  it('matches by basename only, ignoring the rest of the path', () => {
    // The identifier is the directory basename -- the same one `excludes`
    // already uses -- so a differently-laid-out clone (a worktree, a
    // different parent directory) still matches.
    expect(
      callGuard('/home/agent/.worktrees/biffo-plugin-ideation', 'biffo-plugin-ideation').code,
    ).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Part 2: a real end-to-end sync round.
// ---------------------------------------------------------------------------

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

const CANONICAL_RELEASE_GUARDS =
  'name: Release Guards\njobs:\n  guard:\n    steps:\n      - run: echo canonical\n'

/** The satellite-side divergence #2051 reports: an extra step folded into the
 * workflow because it is one of the repo's REQUIRED status checks. */
const DIVERGED_RELEASE_GUARDS =
  'name: Release Guards\njobs:\n  guard:\n    steps:\n      - run: echo canonical\n' +
  '      - uses: pnpm/action-setup@v4\n' +
  '      - name: JS dependency audit\n        run: sh scripts/js-dependency-audit.sh\n'

/**
 * A template checkout carrying the real script, a manifest with a single
 * `filesFromSkeleton` `sync` entry naming `exceptionRepo` in `exceptions`,
 * and the canonical skeleton copy of `release-guards.yml`.
 */
function makeTemplate(dir: string, exceptionRepo: string): void {
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  const manifest = {
    version: 1,
    files: [] as string[],
    appliesTo: ['biffo.sibling.json'],
    filesFromSkeleton: {
      '.github/workflows/release-guards.yml': {
        policy: 'sync',
        exceptions: { [exceptionRepo]: 'fixture: repo-specific required-check step (#2051)' },
      },
    },
    skeletonForMarker: { 'biffo.sibling.json': 'sibling-template' },
    skeletonDefault: 'sibling-template',
  }
  writeFileSync(join(dir, 'shared-files.json'), JSON.stringify(manifest, null, 2))

  const skelPath = join(dir, '_skeletons', 'sibling-template', '.github', 'workflows')
  mkdirSync(skelPath, { recursive: true })
  writeFileSync(join(skelPath, 'release-guards.yml'), CANONICAL_RELEASE_GUARDS)

  writeFileSync(join(dir, 'scripts', 'shared-sync.sh'), readFileSync(realSharedSync))
  chmodSync(join(dir, 'scripts', 'shared-sync.sh'), 0o755)

  // The reduction guard bridge `stage_repo` calls from $TEMPLATE_ROOT before
  // writing anything (`sh scripts/biffo.sh check shared-file-reduction`).
  // Stubbed to pass unconditionally, the same way
  // `makeTemplateCheckout`'s `templateBridge` does -- what that guard reports
  // is `shared-file-reduction-guard.test.ts`'s subject, not this file's, and
  // a YAML workflow file is `not analysable` to it regardless (see #2051's
  // own PR body for why that guard does not cover this class at all).
  const bridge = join(dir, 'scripts', 'biffo.sh')
  writeFileSync(bridge, '#!/bin/sh\nexit 0\n')
  chmodSync(bridge, 0o755)

  execFileSync('git', ['init', '-q', '-b', 'dev', dir], { stdio: 'pipe' })
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'chore: fixture template')
  anchorToOrigin(dir)
}

/** A real satellite clone, on `dev`, carrying a DIVERGED `release-guards.yml`
 * and the `biffo.sibling.json` marker that puts it in scope. */
function makeSatellite(estate: string, name: string): string {
  const origin = join(estate, `${name}.git`)
  mkdirSync(origin, { recursive: true })
  execFileSync('git', ['init', '-q', '--bare', '-b', 'dev', origin], { stdio: 'pipe' })

  const dir = join(estate, name)
  execFileSync('git', ['clone', '-q', origin, dir], { stdio: 'pipe' })
  writeFileSync(join(dir, 'biffo.sibling.json'), '{}\n')
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(dir, '.github', 'workflows', 'release-guards.yml'), DIVERGED_RELEASE_GUARDS)
  // The gate the satellite bridge dispatches `verify` to. Trivial and
  // passing: what it reports is not this test's subject.
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'scripts', 'verify.sh'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(dir, 'scripts', 'verify.sh'), 0o755)
  writeSatelliteBridge(dir)
  writeFileSync(join(dir, '.gitignore'), '.worktrees/\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'chore: fixture satellite')
  git(dir, 'push', '-q', 'origin', 'dev')
  return dir
}

/** A `gh` stub that answers `repo view` and logs every call, so PR creation
 * is observable without a real GitHub round-trip. */
function makeFakeGh(binDir: string, logFile: string): void {
  mkdirSync(binDir, { recursive: true })
  const gh = join(binDir, 'gh')
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(logFile)}
if [ "\${1:-}" = "repo" ] && [ "\${2:-}" = "view" ]; then echo dev; exit 0; fi
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "create" ]; then echo https://example.invalid/pr/1; exit 0; fi
exit 0
`,
  )
  chmodSync(gh, 0o755)
}

/** What actually reached the remote on the satellite's pushed
 * `chore/sync-shared` branch -- never the working tree, which the satellite
 * clone's own refs know nothing about until fetched. `null` if no such
 * branch was ever pushed, i.e. the repo was never a ship target at all. */
function pushedFile(satellite: string, path: string): string | null {
  const fetch = spawnSync('git', ['-C', satellite, 'fetch', '-q', 'origin', 'chore/sync-shared'], {
    encoding: 'utf8',
  })
  if (fetch.status !== 0) return null
  const res = spawnSync('git', ['-C', satellite, 'show', `FETCH_HEAD:${path}`], {
    encoding: 'utf8',
  })
  return res.status === 0 ? res.stdout : null
}

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) spawnSync('rm', ['-rf', dir], { stdio: 'ignore' })
})

describe('a real sync round with a declared release-guards.yml exception', () => {
  it("leaves the named repo's diverged copy untouched while correcting the unnamed one", () => {
    const base = makeTmpDir('shared-sync-exceptions')
    made.push(base)
    const estate = join(base, 'estate')
    mkdirSync(estate, { recursive: true })

    const template = join(estate, 'biffo-template')
    makeTemplate(template, 'sat-exempt')

    const exempt = makeSatellite(estate, 'sat-exempt')
    const plain = makeSatellite(estate, 'sat-plain')

    const logFile = join(base, 'gh-calls.log')
    writeFileSync(logFile, '')
    const binDir = join(base, 'bin')
    makeFakeGh(binDir, logFile)

    const res = spawnSync('sh', [join(template, 'scripts', 'shared-sync.sh'), '--estate', estate], {
      encoding: 'utf8',
      cwd: template,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
      timeout: 120_000,
    })
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`

    // The unnamed repo is ordinary drift: a sync PR opens, and it carries the
    // CANONICAL content -- the pre-existing, correct behaviour for every repo
    // with no declared exception.
    expect(pushedFile(plain, '.github/workflows/release-guards.yml'), out).toBe(
      CANONICAL_RELEASE_GUARDS,
    )

    // The named repo is the fix under test: nothing was pushed for it at all,
    // because with only this one filesFromSkeleton entry in the manifest, a
    // repo excepted from it has nothing left to sync. Before this change, the
    // round would have opened a PR here too and overwritten the diverged copy
    // with $CANONICAL_RELEASE_GUARDS -- reproducing biffo-plugin-ideation's
    // PR #167 exactly.
    expect(pushedFile(exempt, '.github/workflows/release-guards.yml'), out).toBeNull()

    expect(res.status, out).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Part 3: the write-path regression (#2066) -- staged for an UNRELATED reason.
// ---------------------------------------------------------------------------

/**
 * `stage_repo()`'s write loop iterates every `filesFromSkeleton` entry once
 * the repo has been staged for ANY reason, not only when the excepted entry
 * itself is what triggered staging. Part 2 above cannot reach that code path:
 * with only one `filesFromSkeleton` entry in its manifest and no other drift,
 * `diff_files()` (the read half, which already matches on the real repo dir)
 * correctly reports the excepted repo as `current`, so it is never selected
 * as a staging candidate at all -- the write-path bug never runs.
 *
 * biffo-plugin-ideation is staged on every real round regardless, because it
 * also carries ordinary `files`-list drift (`scripts/js-dependency-audit.sh`
 * and friends, confirmed live against `origin/dev` in #2066's own repro).
 * This fixture reproduces that shape with a second, unrelated `files` entry
 * so the excepted repo is staged for a reason that has nothing to do with
 * `release-guards.yml`, and only then checks whether the write loop still
 * respects the exception on the file the entry actually names.
 */
function makeTemplateWithOtherDrift(dir: string, exceptionRepo: string): void {
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  const manifest = {
    version: 1,
    files: ['scripts/other-shared-tool.sh'],
    appliesTo: ['biffo.sibling.json'],
    filesFromSkeleton: {
      '.github/workflows/release-guards.yml': {
        policy: 'sync',
        exceptions: { [exceptionRepo]: 'fixture: repo-specific required-check step (#2051)' },
      },
    },
    skeletonForMarker: { 'biffo.sibling.json': 'sibling-template' },
    skeletonDefault: 'sibling-template',
  }
  writeFileSync(join(dir, 'shared-files.json'), JSON.stringify(manifest, null, 2))

  const skelPath = join(dir, '_skeletons', 'sibling-template', '.github', 'workflows')
  mkdirSync(skelPath, { recursive: true })
  writeFileSync(join(skelPath, 'release-guards.yml'), CANONICAL_RELEASE_GUARDS)

  // The unrelated `files` entry every repo (exempt or not) is drifted on, so
  // every repo in this fixture is a staging candidate for a reason that has
  // nothing to do with the exception under test.
  writeFileSync(join(dir, 'scripts', 'other-shared-tool.sh'), '#!/bin/sh\n# canonical\nexit 0\n')

  writeFileSync(join(dir, 'scripts', 'shared-sync.sh'), readFileSync(realSharedSync))
  chmodSync(join(dir, 'scripts', 'shared-sync.sh'), 0o755)

  const bridge = join(dir, 'scripts', 'biffo.sh')
  writeFileSync(bridge, '#!/bin/sh\nexit 0\n')
  chmodSync(bridge, 0o755)

  execFileSync('git', ['init', '-q', '-b', 'dev', dir], { stdio: 'pipe' })
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'chore: fixture template')
  anchorToOrigin(dir)
}

/** A satellite carrying the unrelated `files`-list drift (an old copy of
 * `scripts/other-shared-tool.sh`, distinct from the template's canonical one
 * so it is reported as drifted) alongside a diverged `release-guards.yml`. */
function makeSatelliteWithOtherDrift(estate: string, name: string): string {
  const origin = join(estate, `${name}.git`)
  mkdirSync(origin, { recursive: true })
  execFileSync('git', ['init', '-q', '--bare', '-b', 'dev', origin], { stdio: 'pipe' })

  const dir = join(estate, name)
  execFileSync('git', ['clone', '-q', origin, dir], { stdio: 'pipe' })
  writeFileSync(join(dir, 'biffo.sibling.json'), '{}\n')
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(dir, '.github', 'workflows', 'release-guards.yml'), DIVERGED_RELEASE_GUARDS)
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  // Deliberately NOT the canonical content -- this is the unrelated drift
  // that forces staging regardless of the release-guards.yml exception.
  writeFileSync(join(dir, 'scripts', 'other-shared-tool.sh'), '#!/bin/sh\n# stale\nexit 0\n')
  chmodSync(join(dir, 'scripts', 'other-shared-tool.sh'), 0o755)
  writeFileSync(join(dir, 'scripts', 'verify.sh'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(dir, 'scripts', 'verify.sh'), 0o755)
  writeSatelliteBridge(dir)
  writeFileSync(join(dir, '.gitignore'), '.worktrees/\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'chore: fixture satellite')
  git(dir, 'push', '-q', 'origin', 'dev')
  return dir
}

describe('the write path when the excepted repo is staged for an unrelated reason (#2066)', () => {
  it("still leaves the named repo's diverged release-guards.yml untouched", () => {
    const base = makeTmpDir('shared-sync-exceptions-other-drift')
    made.push(base)
    const estate = join(base, 'estate')
    mkdirSync(estate, { recursive: true })

    const template = join(estate, 'biffo-template')
    makeTemplateWithOtherDrift(template, 'sat-exempt')

    const exempt = makeSatelliteWithOtherDrift(estate, 'sat-exempt')

    const logFile = join(base, 'gh-calls.log')
    writeFileSync(logFile, '')
    const binDir = join(base, 'bin')
    makeFakeGh(binDir, logFile)

    const res = spawnSync('sh', [join(template, 'scripts', 'shared-sync.sh'), '--estate', estate], {
      encoding: 'utf8',
      cwd: template,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
      timeout: 120_000,
    })
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`

    // The repo IS a ship target -- staged and pushed for the unrelated
    // `other-shared-tool.sh` drift, proving this fixture actually reaches the
    // write loop rather than being screened out like Part 2's fixture.
    expect(pushedFile(exempt, 'scripts/other-shared-tool.sh'), out).toBe(
      '#!/bin/sh\n# canonical\nexit 0\n',
    )

    // The excepted file must survive untouched even though the repo WAS
    // staged. Before the fix, `stage_repo()`'s write loop checked the
    // exception against `basename("$wt")` -- always the literal string
    // `shared-sync` -- so it never matched any repo name and the excepted
    // file was overwritten with the canonical content here too.
    expect(pushedFile(exempt, '.github/workflows/release-guards.yml'), out).toBe(
      DIVERGED_RELEASE_GUARDS,
    )

    expect(res.status, out).toBe(0)
  })
})
