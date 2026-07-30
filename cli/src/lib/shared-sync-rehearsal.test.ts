import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * `scripts/shared-sync.sh` must prove a candidate shared file against every
 * target repo BEFORE it opens a PR in any of them.
 *
 * ## Why
 *
 * Measured 2026-07-29: **84 `chore(shared): sync template-shared files` PRs
 * merged across 12 satellites in one day**, in 7 rounds where one would have
 * done — 33.5% of the estate's entire merge volume, every one of them counted as
 * toil (60.2% that day). Six of the seven rounds carried `scripts/verify.sh`
 * alone, because the gate was being iterated *downstream*: each defect that only
 * exists in a repo that is not the template (a check list tuned to the
 * template's layout, a pytest-cov flag a plugin repo rejects, a `package.json`
 * that is not at the root) cost a full estate-wide lap to find.
 *
 * The script used to be one pass — stage, push, PR, per repo in turn — so a
 * defect found in repo 7 left six PRs already open and the fix meant another
 * round. Now phase 1 rehearses every target and phase 2 ships only if phase 1
 * was clean everywhere.
 *
 * ## Why this drives the real script instead of reading it
 *
 * Because the assertion that matters is *"no PR was opened"*, and no amount of
 * grepping the source establishes that. Every collaborator is faked — `gh` is a
 * stub on `PATH` that logs its argv, the template is a synthetic one carrying
 * this repo's real `shared-sync.sh`, and the satellites are real local git
 * clones — so the thing under test is the actual control flow.
 *
 * A stub that made every gate pass would leave the refusal path unproven and
 * green, which is the exact shape of the defects above. So one fixture satellite
 * is deliberately arranged to fail its gate, and the test asserts the *absence*
 * of a push and of a `pr create`.
 */

const scriptUnderTest = 'scripts/shared-sync.sh'

/** The repo root — the directory holding `shared-files.json`. */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, 'shared-files.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // A walk that overshoots would resolve to a directory with no script in it and
  // every assertion below would pass against nothing — the defect
  // skeleton-drift-guard.test.ts's own root resolution had once (#744).
  throw new Error(`could not locate shared-files.json above ${fileURLToPath(import.meta.url)}`)
}

const root = repoRoot()

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

/**
 * A candidate gate. `--list` prints nothing (the installer greps it for nested
 * package directories); a run passes unless the repo holds `GATE-FAILS-HERE`,
 * which is how a fixture repo is made to fail the way a real one does — the
 * candidate file is fine in the template and wrong *there*.
 */
const candidateVerify = `#!/usr/bin/env bash
# set -u only. This stub is executed through \`sh\` by the script under test, and
# writing \`set -uo pipefail\` here reproduced, inside the fixture, the exact
# defect the fixture had just caught in the real script: the runner's sh rejects
# it and every rehearsal reported FAIL for the wrong reason.
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

/** A bare origin plus a clone on `dev`, holding a stale copy of the shared set. */
function makeSatellite(estate: string, name: string, opts: { gateFails?: boolean } = {}): string {
  const origin = join(estate, `${name}.git`)
  mkdirSync(origin, { recursive: true })
  execFileSync('git', ['init', '--bare', '--initial-branch=dev', origin], { stdio: 'pipe' })

  const dir = join(estate, name)
  execFileSync('git', ['clone', origin, dir], { stdio: 'pipe' })
  git(dir, 'config', 'user.email', 'fixture@example.com')
  git(dir, 'config', 'user.name', 'Fixture')
  git(dir, 'config', 'commit.gpgsign', 'false')

  // A sibling marker, so `applies()` selects it for the same reason a real
  // sibling is selected.
  writeFileSync(join(dir, 'biffo.sibling.json'), '{}\n')
  writeFileSync(join(dir, '.gitignore'), '.worktrees/\n')
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  // Deliberately STALE — a previous generation of the shared file, so the repo
  // reads as drifted and becomes a target.
  writeFileSync(join(dir, 'scripts/verify.sh'), '#!/usr/bin/env bash\nexit 0\n')
  writeFileSync(join(dir, 'scripts/gate-coverage.sh'), '#!/usr/bin/env bash\nexit 0\n')
  if (opts.gateFails) writeFileSync(join(dir, 'GATE-FAILS-HERE'), '')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'chore: fixture')
  git(dir, 'push', 'origin', 'dev')
  return dir
}

/**
 * A synthetic template: this repo's real `shared-sync.sh`, a manifest naming
 * only the fixture's own shared files, and the candidate copies of them.
 */
function makeTemplate(dir: string): void {
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(
    join(dir, 'shared-files.json'),
    JSON.stringify(
      {
        version: 1,
        files: ['scripts/verify.sh', 'scripts/gate-coverage.sh'],
        appliesTo: ['biffo.sibling.json', 'biffo.plugin.json'],
      },
      null,
      2,
    ),
  )
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
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'chore: fixture template')
}

/** A `gh` that answers `repo view` and logs every call, so PR creation is observable. */
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

interface Run {
  status: number | null
  out: string
  ghCalls: string[]
}

const made: string[] = []
afterEach(() => {
  // Worktrees the script staged inside fixture clones hold no state worth
  // keeping, but they DO hold git locks; remove the trees wholesale.
  for (const dir of made.splice(0)) spawnSync('rm', ['-rf', dir], { stdio: 'ignore' })
})

function runSync(
  args: string[],
  opts: { failingSatellite?: boolean; fromWorktree?: boolean } = {},
): {
  run: Run
  estate: string
  template: string
  satellites: string[]
} {
  const base = mkdtempSync(join(tmpdir(), 'shared-sync-'))
  made.push(base)
  const estate = join(base, 'estate')
  mkdirSync(estate, { recursive: true })

  // The template lives INSIDE the estate directory, exactly as biffo-template
  // does in ~/code. That is what makes the "do not target yourself" exclusion
  // load-bearing rather than incidental.
  const template = join(estate, 'biffo-template')
  makeTemplate(template)

  const satellites = [
    makeSatellite(estate, 'sat-alpha'),
    makeSatellite(estate, 'sat-beta', { gateFails: opts.failingSatellite }),
  ]

  const logFile = join(base, 'gh-calls.log')
  writeFileSync(logFile, '')
  const binDir = join(base, 'bin')
  makeFakeGh(binDir, logFile)

  let scriptDir = template
  if (opts.fromWorktree) {
    // AGENTS.md section 1 mandates that all work happens in a linked worktree,
    // so this is the ONLY way the script is ever legitimately invoked while a
    // shared file is being iterated on.
    const wt = join(template, '.worktrees', 'candidate')
    git(template, 'worktree', 'add', '-q', wt, '-b', 'feat/candidate')
    scriptDir = wt
  }

  const res = spawnSync('sh', [join(scriptDir, scriptUnderTest), '--estate', estate, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    timeout: 120_000,
  })

  const ghCalls = readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
  return {
    run: { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}`, ghCalls },
    estate,
    template,
    satellites,
  }
}

/** Does the satellite's origin carry the sync branch? i.e. did anything get pushed? */
function originHasSyncBranch(satellite: string): boolean {
  const res = spawnSync(
    'git',
    ['-C', satellite, 'ls-remote', '--heads', 'origin', 'chore/sync-shared'],
    {
      encoding: 'utf8',
    },
  )
  return (res.stdout ?? '').trim().length > 0
}

describe('shared-sync rehearsal', () => {
  it('rehearses every target and reports the gate it ran, without opening a PR', () => {
    const { run } = runSync(['--rehearse'])

    expect(run.out).toMatch(/rehearsing 2 repos/)
    expect(run.out).toMatch(/sat-alpha\s+.*PASS/)
    expect(run.out).toMatch(/sat-beta\s+.*PASS/)
    // The coverage number comes from the candidate gate-coverage.sh, proving the
    // rehearsal ran the CANDIDATE files rather than the repo's stale copies.
    expect(run.out).toMatch(/covers 3\/3/)
    expect(run.status).toBe(0)
    expect(run.ghCalls.filter((c) => c.startsWith('pr create'))).toEqual([])
  }, 120_000)

  it('runs under a /bin/sh without pipefail, which is how it is invoked', () => {
    // CI caught this the first time anything executed the script off the
    // workstation. It opened `set -uo pipefail` under a `#!/usr/bin/env bash`
    // shebang while every documented invocation — AGENTS.md section 9,
    // docs/practices/standards/local-gates.md, scripts/practices-daily.sh — is
    // `sh scripts/shared-sync.sh`. The workstation's dash is 0.5.12, which
    // accepts `-o pipefail`; the runner's sh is older and exits at that line
    // with `set: Illegal option -o pipefail` before parsing an argument.
    //
    // The behavioural half of this guard is every other test in this file: they
    // invoke the real script through `sh`, so on a machine with a strict sh they
    // all fail. That is exactly what happened, and it is also why they cannot be
    // relied on alone — on a machine whose dash tolerates pipefail they stay
    // green. Hence the textual assertion, which fails everywhere.
    const src = readFileSync(join(root, scriptUnderTest), 'utf8')
    const setLines = src.split('\n').filter((l) => /^\s*set\s+-/.test(l))
    expect(setLines.length).toBeGreaterThan(0)
    for (const line of setLines) {
      expect(
        line,
        `${scriptUnderTest} is run as \`sh <script>\`; pipefail must be probed, not assumed`,
      ).not.toMatch(/pipefail/)
    }
    expect(src, 'enable pipefail only where the shell has it').toMatch(
      /\(set -o pipefail\) 2>\/dev\/null && set -o pipefail/,
    )
  })

  it('opens no PR in ANY repo when the candidate fails its gate in ONE', () => {
    const { run, satellites } = runSync([], { failingSatellite: true })

    expect(run.out).toMatch(/rehearsal failed in 1 repo\(s\)/)
    expect(run.out).toMatch(/sat-beta\s+.*FAIL/)
    expect(run.out).toMatch(/verify failed: typecheck/)
    expect(run.status).toBe(1)

    // The assertion this test exists for: sat-alpha rehearsed clean and is
    // listed FIRST, so a per-repo loop would already have shipped it. Nothing
    // was pushed and no PR was created anywhere.
    expect(run.ghCalls.filter((c) => c.startsWith('pr create'))).toEqual([])
    for (const s of satellites) expect(originHasSyncBranch(s)).toBe(false)
  }, 120_000)

  it('ships every repo once the rehearsal is clean', () => {
    const { run, satellites } = runSync([])

    expect(run.out).toMatch(/rehearsal clean in every repo/)
    expect(run.ghCalls.filter((c) => c.startsWith('pr create'))).toHaveLength(2)
    expect(run.status).toBe(0)
    for (const s of satellites) expect(originHasSyncBranch(s)).toBe(true)
  }, 120_000)

  it('leaves the failing repo staged to look at, and reaps the ones that passed', () => {
    const { run, estate } = runSync([], { failingSatellite: true })

    expect(run.status).toBe(1)
    expect(existsSync(join(estate, 'sat-beta', '.worktrees', 'shared-sync'))).toBe(true)
    expect(existsSync(join(estate, 'sat-alpha', '.worktrees', 'shared-sync'))).toBe(false)
  }, 120_000)

  it('never targets the template itself, even when run from one of its worktrees', () => {
    // The exclusion used to be `[ "$d" = "$TEMPLATE_ROOT" ]`, an identity on the
    // working-tree PATH. From a worktree, TEMPLATE_ROOT is
    // `.worktrees/<name>` and the primary checkout beside it looks like any
    // other repo carrying scripts/verify.sh — it has no biffo.core.json and no
    // sibling marker, so nothing else excluded it. It stayed invisible only
    // because a primary checkout is normally byte-identical to origin/dev and so
    // reported `current`; the moment a candidate differs — the only reason to
    // run this at all — the template became a target of its own distribution.
    const { run } = runSync(['--rehearse'], { fromWorktree: true })

    expect(run.out).not.toMatch(/biffo-template/)
    expect(run.out).toMatch(/rehearsing 2 repos/)
    expect(run.status).toBe(0)
  }, 120_000)

  it('--no-rehearse says so on the way past, rather than skipping quietly', () => {
    // AGENTS.md section 7: a gate may be loosened in the open, never silently.
    const { run } = runSync(['--no-rehearse'], { failingSatellite: true })

    expect(run.out).toMatch(/--no-rehearse: shipping 2 repos unproven/)
    expect(run.ghCalls.filter((c) => c.startsWith('pr create'))).toHaveLength(2)
  }, 120_000)
})
