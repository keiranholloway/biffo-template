import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { anchorToOrigin, writeSatelliteBridge } from '../test-utils/shared-sync-template.js'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * biffo-template#2004 defect 2: `scripts/shared-sync.sh` opens one PR per
 * drifted satellite and never touches the branch again once it exists. Its
 * own comment above `ship_repo`'s push said the reuse was deliberate --
 * "a second day's push updates the still-open PR from the first rather than
 * opening a new one" -- and that IS what happens when a repo's rehearsal
 * passes: `stage_repo`/`ship_repo` rebuild the branch from the CURRENT base
 * every time. It is not what happens when rehearsal FAILS: phase 2 skipped
 * the repo entirely, leaving whatever it last pushed sitting there. Measured
 * live 2026-09-09 (the issue's own evidence): two satellites whose rehearsal
 * had been failing for days had their sync PRs fall BEHIND their base and
 * then go DIRTY -- a real merge conflict needing hand work to recover from,
 * on the one channel that distributes every template-owned fix to every
 * instance.
 *
 * These tests drive the real script exactly as `shared-sync-rehearsal.test.ts`
 * does: `gh` is a stub on `PATH` that logs its argv and answers `pr view` for
 * one repo as though it already carries a DIRTY open PR, the template is a
 * synthetic checkout carrying this repo's real `shared-sync.sh`, and the
 * satellites are real local git clones. The assertion that matters is
 * observable behaviour -- a push actually reaching the remote, a report line
 * actually printed -- not a theory about the control flow.
 */

const scriptUnderTest = 'scripts/shared-sync.sh'

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, 'shared-files.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`could not locate shared-files.json above ${fileURLToPath(import.meta.url)}`)
}

const root = repoRoot()

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

/** Passes unless the repo holds `GATE-FAILS-HERE` -- how a fixture repo is
 * made to fail its own gate the way a real one does. */
const candidateVerify = `#!/usr/bin/env bash
set -u
[ "\${1:-}" = "--list" ] && exit 0
if [ -f GATE-FAILS-HERE ]; then
  printf 'verify failed: typecheck\\n'
  exit 1
fi
printf 'verify passed - lint typecheck test\\n'
exit 0
`

const candidateCoverage = `#!/usr/bin/env bash
printf 'gate coverage\\n\\nfixture 3/3\\n'
exit 0
`

interface SatelliteOpts {
  gateFails?: boolean
}

function makeSatellite(estate: string, name: string, opts: SatelliteOpts = {}): string {
  const origin = join(estate, `${name}.git`)
  mkdirSync(origin, { recursive: true })
  execFileSync('git', ['init', '--bare', '--initial-branch=dev', origin], { stdio: 'pipe' })

  const dir = join(estate, name)
  execFileSync('git', ['clone', origin, dir], { stdio: 'pipe' })
  git(dir, 'config', 'user.email', 'fixture@example.com')
  git(dir, 'config', 'user.name', 'Fixture')
  git(dir, 'config', 'commit.gpgsign', 'false')

  writeFileSync(join(dir, 'biffo.sibling.json'), '{}\n')
  writeFileSync(join(dir, '.gitignore'), '.worktrees/\n')
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  // Deliberately STALE, so diff_files reports this repo drifted and it
  // becomes a round target.
  writeFileSync(join(dir, 'scripts/verify.sh'), '#!/usr/bin/env bash\nexit 0\n')
  writeFileSync(join(dir, 'scripts/gate-coverage.sh'), '#!/usr/bin/env bash\nexit 0\n')
  if (opts.gateFails) writeFileSync(join(dir, 'GATE-FAILS-HERE'), '')
  writeSatelliteBridge(dir)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'chore: fixture')
  git(dir, 'push', 'origin', 'dev')
  return dir
}

function makeTemplate(dir: string): void {
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  const manifest = {
    version: 1,
    files: ['scripts/verify.sh', 'scripts/gate-coverage.sh'],
    appliesTo: ['biffo.sibling.json', 'biffo.plugin.json'],
  }
  writeFileSync(join(dir, 'shared-files.json'), JSON.stringify(manifest, null, 2))
  writeFileSync(join(dir, 'scripts/shared-sync.sh'), readFileSync(join(root, scriptUnderTest)))
  chmodSync(join(dir, 'scripts/shared-sync.sh'), 0o755)
  writeFileSync(join(dir, 'scripts/verify.sh'), candidateVerify)
  chmodSync(join(dir, 'scripts/verify.sh'), 0o755)
  writeFileSync(join(dir, 'scripts/gate-coverage.sh'), candidateCoverage)
  chmodSync(join(dir, 'scripts/gate-coverage.sh'), 0o755)

  execFileSync('git', ['init', '--initial-branch=dev', dir], { stdio: 'pipe' })
  git(dir, 'config', 'user.email', 'fixture@example.com')
  git(dir, 'config', 'user.name', 'Fixture')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeSatelliteBridge(dir)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'chore: fixture template')
  anchorToOrigin(dir)
}

/**
 * A `gh` stub that also answers `pr view chore/sync-shared -R <slug>` --
 * real `gh` would report the actual state of an already-open PR; this
 * reproduces that for exactly ONE repo (matched by a substring of its `-R`
 * slug), as though `sat-rotten`'s round-25-days-ago PR has since gone DIRTY
 * against a base that has moved past it. Every other repo gets `gh`'s real
 * behaviour for a branch with no open PR: a non-zero exit and nothing on
 * stdout.
 */
function makeFakeGh(binDir: string, logFile: string, dirtySlugSubstring: string): void {
  mkdirSync(binDir, { recursive: true })
  const gh = join(binDir, 'gh')
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(logFile)}
if [ "\${1:-}" = "repo" ] && [ "\${2:-}" = "view" ]; then echo dev; exit 0; fi
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "create" ]; then echo https://example.invalid/pr/1; exit 0; fi
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "view" ]; then
  slug=""
  prev=""
  for a in "$@"; do
    if [ "$prev" = "-R" ]; then slug="$a"; fi
    prev="$a"
  done
  case "$slug" in
    *${dirtySlugSubstring}*)
      printf '126\\tDIRTY\\thttps://example.invalid/pr/126\\n'
      exit 0
      ;;
    *)
      exit 1
      ;;
  esac
fi
exit 0
`,
  )
  chmodSync(gh, 0o755)
}

interface Run {
  status: number | null
  out: string
  ghCalls: string[]
}

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) spawnSync('rm', ['-rf', dir], { stdio: 'ignore' })
})

function runSync(scriptPath: string): {
  run: Run
  estate: string
  satellites: { rotten: string; clean: string }
} {
  const base = makeTmpDir('shared-sync-rotting')
  made.push(base)
  const estate = join(base, 'estate')
  mkdirSync(estate, { recursive: true })

  const template = join(estate, 'biffo-template')
  makeTemplate(template)
  // The real script under test is copied in from wherever the caller points
  // us (the unmodified `origin/dev` copy for the "fails first" proof, the
  // working tree's fixed copy for the regression check) rather than always
  // reading `root`'s current on-disk state -- see the two `it`s below.
  writeFileSync(join(template, 'scripts/shared-sync.sh'), readFileSync(scriptPath))
  chmodSync(join(template, 'scripts/shared-sync.sh'), 0o755)

  // sat-rotten: rehearsal fails AND already has a DIRTY open PR.
  // sat-clean-fail: rehearsal fails, no open PR yet -- the control that
  // proves the discriminator is "already has a PR", not merely "gateFails".
  const rotten = makeSatellite(estate, 'sat-rotten', { gateFails: true })
  const clean = makeSatellite(estate, 'sat-clean-fail', { gateFails: true })

  const logFile = join(base, 'gh-calls.log')
  writeFileSync(logFile, '')
  const binDir = join(base, 'bin')
  makeFakeGh(binDir, logFile, 'sat-rotten')

  const res = spawnSync('sh', [join(template, scriptUnderTest), '--estate', estate], {
    encoding: 'utf8',
    cwd: template,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    timeout: 120_000,
  })

  const ghCalls = readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
  return {
    run: { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}`, ghCalls },
    estate,
    satellites: { rotten, clean },
  }
}

function originHasSyncBranch(satellite: string): boolean {
  const res = spawnSync(
    'git',
    ['-C', satellite, 'ls-remote', '--heads', 'origin', 'chore/sync-shared'],
    { encoding: 'utf8' },
  )
  return (res.stdout ?? '').trim().length > 0
}

describe('a rotting sync PR is refreshed onto its base and reported distinctly (biffo-template#2004)', () => {
  it("refreshes the DIRTY repo's branch despite its rehearsal failing, and leaves the PR-less repo untouched", () => {
    const { run, satellites, estate } = runSync(join(root, scriptUnderTest))

    // Both repos still fail their own gate -- this fix does not paper over
    // that, and the round still reports it and still exits non-zero.
    expect(run.out).toMatch(/sat-rotten\s+.*FAIL/)
    expect(run.out).toMatch(/sat-clean-fail\s+.*FAIL/)
    expect(run.status).toBe(1)

    // The distinct condition (goal B): a rotting PR is called out separately
    // from the generic drifted count, by name, with the state GitHub reports.
    expect(run.out).toMatch(/sat-rotten[\s\S]*its open sync PR is DIRTY/)
    expect(run.out).toMatch(/1 already-open sync PR\(s\) were BEHIND or DIRTY/)
    expect(run.out).toMatch(/1 refreshed onto the current base/)

    // The actual behaviour (goal A): sat-rotten's branch got pushed even
    // though its rehearsal failed -- a branch rebuilt from the current base
    // every time it is touched can never be BEHIND or DIRTY. sat-clean-fail
    // has no open PR to protect, so nothing pushed for it -- the pre-existing,
    // correct "leave it staged for a human" behaviour is unchanged.
    expect(originHasSyncBranch(satellites.rotten)).toBe(true)
    expect(originHasSyncBranch(satellites.clean)).toBe(false)
    expect(existsSync(join(estate, 'sat-rotten', '.worktrees', 'shared-sync'))).toBe(false)
    expect(existsSync(join(estate, 'sat-clean-fail', '.worktrees', 'shared-sync'))).toBe(true)

    // No new PR was opened for either -- this is a refresh of an existing
    // channel, never the brand-new distribution rehearsal still gates.
    expect(run.ghCalls.filter((c) => c.startsWith('pr create'))).toEqual([])
  }, 120_000)

  it('counts a rotting PR as refreshed when rehearsal PASSES too, via the ordinary ship path', () => {
    // A repo whose rehearsal is clean was never the broken case -- ship_repo
    // already rebuilds the branch from the current base on every push, so a
    // BEHIND/DIRTY PR here gets fixed by the pre-existing code path. This
    // proves the SUMMARY correctly attributes that fix to `rotting_refreshed`
    // rather than reporting "0 refreshed" for a repo that, in fact, is fine.
    const base = makeTmpDir('shared-sync-rotting-pass')
    made.push(base)
    const estate = join(base, 'estate')
    mkdirSync(estate, { recursive: true })

    const template = join(estate, 'biffo-template')
    makeTemplate(template)
    writeFileSync(
      join(template, 'scripts/shared-sync.sh'),
      readFileSync(join(root, scriptUnderTest)),
    )
    chmodSync(join(template, 'scripts/shared-sync.sh'), 0o755)

    const passing = makeSatellite(estate, 'sat-behind-passing', {})

    const logFile = join(base, 'gh-calls.log')
    writeFileSync(logFile, '')
    const binDir = join(base, 'bin')
    makeFakeGh(binDir, logFile, 'sat-behind-passing')

    const res = spawnSync('sh', [join(template, scriptUnderTest), '--estate', estate], {
      encoding: 'utf8',
      cwd: template,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
      timeout: 120_000,
    })
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`

    expect(res.status).toBe(0)
    expect(out).toMatch(/sat-behind-passing\s+.*PASS/)
    expect(out).toMatch(/its open sync PR is DIRTY/)
    expect(out).toMatch(/1 already-open sync PR\(s\) were BEHIND or DIRTY/)
    expect(out).toMatch(/1 refreshed onto the current base/)
    expect(originHasSyncBranch(passing)).toBe(true)
  }, 120_000)
})
