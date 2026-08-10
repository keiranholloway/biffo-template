import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { anchorToOrigin, writeSatelliteBridge } from '../test-utils/shared-sync-template.js'
import { makeTmpDir } from '../test-utils/tmp.js'

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

interface SatelliteOpts {
  gateFails?: boolean
  /**
   * The flavour marker this repo carries, or `null` for a repo with none —
   * the runner repos, `tabsii-map` and `tabsii-data-model-design` are selected
   * by `applies()` for holding `scripts/verify.sh` alone.
   */
  marker?: 'biffo.sibling.json' | 'biffo.plugin.json' | null
  /** Extra files to commit before the run, as `path -> contents`. */
  seedFiles?: Record<string, string>
  /**
   * Write the CURRENT (candidate-matching) `scripts/verify.sh` and
   * `scripts/gate-coverage.sh` instead of the deliberately-stale default, so
   * this repo reports `current` on the `files` list. The mustBeUniform and
   * `--candidates` tests want a repo whose ONLY interesting property is the
   * unrelated path under test — leaving the default staleness in would fail
   * `--check` for a reason those tests are not about, which is exactly the
   * "names the wrong cause" defect AGENTS.md section 4 warns against.
   */
  filesUpToDate?: boolean
}

/** A bare origin plus a clone on `dev`, holding a stale copy of the shared set. */
function makeSatellite(estate: string, name: string, opts: SatelliteOpts = {}): string {
  const origin = join(estate, `${name}.git`)
  mkdirSync(origin, { recursive: true })
  execFileSync('git', ['init', '--bare', '--initial-branch=dev', origin], { stdio: 'pipe' })

  const dir = join(estate, name)
  execFileSync('git', ['clone', origin, dir], { stdio: 'pipe' })
  git(dir, 'config', 'user.email', 'fixture@example.com')
  git(dir, 'config', 'user.name', 'Fixture')
  git(dir, 'config', 'commit.gpgsign', 'false')

  // A sibling marker, so `applies()` selects it for the same reason a real
  // sibling is selected. `null` drops it, leaving the repo selected only by
  // `scripts/verify.sh` below — which is how four real estate repos qualify.
  const marker = opts.marker === undefined ? 'biffo.sibling.json' : opts.marker
  if (marker) writeFileSync(join(dir, marker), '{}\n')
  for (const [rel, contents] of Object.entries(opts.seedFiles ?? {})) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), contents)
  }
  writeFileSync(join(dir, '.gitignore'), '.worktrees/\n')
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  if (opts.filesUpToDate) {
    // Matches the template's candidate copies byte-for-byte, so this repo is
    // `current` on the `files` list and the only signal left in `--check`'s
    // output is whatever the test actually seeded.
    writeFileSync(join(dir, 'scripts/verify.sh'), candidateVerify)
    writeFileSync(join(dir, 'scripts/gate-coverage.sh'), candidateCoverage)
  } else {
    // Deliberately STALE — a previous generation of the shared file, so the
    // repo reads as drifted and becomes a target.
    writeFileSync(join(dir, 'scripts/verify.sh'), '#!/usr/bin/env bash\nexit 0\n')
    writeFileSync(join(dir, 'scripts/gate-coverage.sh'), '#!/usr/bin/env bash\nexit 0\n')
  }
  if (opts.gateFails) writeFileSync(join(dir, 'GATE-FAILS-HERE'), '')
  writeSatelliteBridge(dir)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'chore: fixture')
  git(dir, 'push', 'origin', 'dev')
  return dir
}

/**
 * A synthetic template: this repo's real `shared-sync.sh`, a manifest naming
 * only the fixture's own shared files, and the candidate copies of them.
 */
function makeTemplate(
  dir: string,
  opts: {
    withSkeletons?: boolean
    mustBeUniform?: Record<string, number>
    keyMustBeUniform?: Record<string, Record<string, number>>
    /**
     * Wires `overridesFloor`. The canonical copy lives at
     * `_skeletons/sibling-template/apps/frontend/package.json`, matching the
     * real manifest's shape, so `skeletonForMarker`/`skeletonDefault` do not
     * need to exist for this alone -- `overridesFloor`'s canonical path is a
     * plain repo-relative path, read directly, independent of `filesFromSkeleton`.
     */
    overridesCanonical?: string
  } = {},
): void {
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  const manifest: Record<string, unknown> = {
    version: 1,
    files: ['scripts/verify.sh', 'scripts/gate-coverage.sh'],
    appliesTo: ['biffo.sibling.json', 'biffo.plugin.json'],
  }
  if (opts.mustBeUniform) manifest.mustBeUniform = opts.mustBeUniform
  if (opts.keyMustBeUniform) manifest.keyMustBeUniform = opts.keyMustBeUniform
  if (opts.overridesCanonical) {
    const canonicalPath = '_skeletons/sibling-template/apps/frontend/package.json'
    mkdirSync(join(dir, dirname(canonicalPath)), { recursive: true })
    writeFileSync(join(dir, canonicalPath), opts.overridesCanonical)
    manifest.overridesFloor = { 'apps/frontend/package.json': canonicalPath }
  }
  if (opts.withSkeletons) {
    // The two skeleton rulesets differ ON PURPOSE — that is the whole reason
    // `filesFromSkeleton` resolves its source per repo instead of `files`
    // learning a single `target -> source` remap.
    for (const [skeleton, flavour] of [
      ['sibling-template', 'SIBLING'],
      ['plugin-template', 'PLUGIN'],
    ]) {
      mkdirSync(join(dir, '_skeletons', skeleton), { recursive: true })
      writeFileSync(join(dir, '_skeletons', skeleton, 'AGENTS.md'), `${flavour} RULES v2\n`)
      writeFileSync(
        join(dir, '_skeletons', skeleton, 'CLAUDE.md'),
        `# ${flavour} context\n\n@AGENTS.md\n`,
      )
    }
    manifest.filesFromSkeleton = { 'AGENTS.md': 'sync', 'CLAUDE.md': 'seed' }
    manifest.skeletonForMarker = {
      'biffo.sibling.json': 'sibling-template',
      'biffo.plugin.json': 'plugin-template',
    }
    manifest.skeletonDefault = 'sibling-template'
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
  // On `dev`, so shared-sync's staleness preflight applies to this fixture as
  // it does to a real template checkout. Anchoring it to its own origin gives
  // that check a defined answer the test controls, rather than one that depends
  // on how the preflight currently treats an unreachable remote (#1252).
  anchorToOrigin(dir)
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
  opts: {
    failingSatellite?: boolean
    fromWorktree?: boolean
    withSkeletons?: boolean
    mustBeUniform?: Record<string, number>
    keyMustBeUniform?: Record<string, Record<string, number>>
    overridesCanonical?: string
    satellites?: Array<[string, SatelliteOpts]>
  } = {},
): {
  run: Run
  estate: string
  template: string
  satellites: string[]
} {
  const base = makeTmpDir('shared-sync')
  made.push(base)
  const estate = join(base, 'estate')
  mkdirSync(estate, { recursive: true })

  // The template lives INSIDE the estate directory, exactly as biffo-template
  // does in ~/code. That is what makes the "do not target yourself" exclusion
  // load-bearing rather than incidental.
  const template = join(estate, 'biffo-template')
  makeTemplate(template, {
    withSkeletons: opts.withSkeletons,
    mustBeUniform: opts.mustBeUniform,
    keyMustBeUniform: opts.keyMustBeUniform,
    overridesCanonical: opts.overridesCanonical,
  })

  const satellites = (
    opts.satellites ?? [
      ['sat-alpha', {}],
      ['sat-beta', { gateFails: opts.failingSatellite }],
    ]
  ).map(([name, satOpts]) => makeSatellite(estate, name, satOpts))

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

  // `overridesFloor`'s canonical path is read relative to the process's own
  // working location (see the comment above the OVERRIDES_FLOOR block in the
  // script under test), matching every documented invocation. Omitting the
  // `cwd` below would resolve that path against the test runner's location
  // instead and misreport every canonical read as unparsable --
  // `shared-sync-deliver-overrides.test.ts`'s `runDeliver` hit exactly this
  // and documents it the same way.
  const res = spawnSync('sh', [join(scriptDir, scriptUnderTest), '--estate', estate, ...args], {
    encoding: 'utf8',
    cwd: scriptDir,
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

/** The content of a path on the satellite's PUSHED `chore/sync-shared` branch --
 * i.e. what actually reached the remote, not what a local worktree staged. The
 * satellite clone's own refs do not know about it until fetched: `ship_repo`
 * pushes from a SEPARATE staged worktree, not from this clone. */
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

/**
 * Strip ANSI colour codes so a multi-field report line can be matched with a
 * single `\s+`-joined regex. The mustBeUniform/--candidates report colours
 * only the verdict WORD (`WORSENED`, `at baseline`, ...), so an escape
 * sequence sits directly between it and the padding that follows -- `\s+`
 * does not span it, and a naive regex fails against real, correct output for
 * a reason that has nothing to do with what the test is asserting.
 */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex -- \x1b IS the control character being stripped.
  return s.replace(/\x1b\[[0-9;]*m/g, '')
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

  // #1160's second suggested fix: phase 2 stages a worktree per repo and used
  // to leave it behind once its PR was open, so `.worktrees/shared-sync`
  // persisted between rounds -- an AGENTS.md section 1 hygiene gap, and
  // unnecessary extra surface for the (still unexplained) disappearance the
  // guard in the previous describe block is named for. It does not explain
  // that disappearance; it only stops a worktree that survived BOTH phases
  // from lingering once shipped.
  it('reaps the staged worktree after a successful ship, so it does not persist between rounds', () => {
    const { run, satellites } = runSync([])

    expect(run.status).toBe(0)
    for (const s of satellites) {
      expect(existsSync(join(s, '.worktrees', 'shared-sync'))).toBe(false)
    }
    // The PR still went out -- reaping the worktree must not be mistaken for
    // reaping the work.
    expect(run.ghCalls.filter((c) => c.startsWith('pr create'))).toHaveLength(2)
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

  it('backfills a missing file, from the skeleton matching the repo, without clobbering a seeded one', () => {
    // #1150: eleven of seventeen estate repos held NEITHER `AGENTS.md` NOR
    // `CLAUDE.md` — not a stale copy, nothing — so an agent opening `tabsii-crm`
    // got no worktree discipline, no honest-push rule and no never-merge-red.
    // `files` creates but cannot remap a path; `filesIfPresent` remaps but never
    // creates. This asserts the third list does all four things at once, because
    // the whole point is that no single existing list could.
    const { estate } = runSync(['--rehearse'], {
      withSkeletons: true,
      satellites: [
        // A sibling with neither file — the six wave-1 repos.
        ['sat-sibling', {}],
        // A plugin repo, which must NOT receive the sibling ruleset.
        ['sat-plugin', { marker: 'biffo.plugin.json' }],
        // A repo with no marker at all, holding a stale ruleset and a CLAUDE.md
        // it has made its own. Selected only by `scripts/verify.sh`.
        [
          'sat-bare',
          {
            marker: null,
            seedFiles: {
              'AGENTS.md': 'ANCIENT RULES v1\n',
              'CLAUDE.md': '# This repo is a Terraform runner fleet\n\n@AGENTS.md\n',
            },
          },
        ],
      ],
    })
    const staged = (name: string, file: string) =>
      readFileSync(join(estate, name, '.worktrees', 'shared-sync', file), 'utf8')

    // Created where absent, from the flavour's own skeleton.
    expect(staged('sat-sibling', 'AGENTS.md')).toBe('SIBLING RULES v2\n')
    expect(staged('sat-sibling', 'CLAUDE.md')).toContain('@AGENTS.md')
    expect(staged('sat-plugin', 'AGENTS.md')).toBe('PLUGIN RULES v2\n')
    expect(staged('sat-plugin', 'CLAUDE.md')).toContain('# PLUGIN context')

    // `sync` overwrites a stale copy — AGENTS.md drifting 68 lines behind in
    // tabsii (#559) is the injury this mechanism exists for. A marker-less repo
    // resolves through `skeletonDefault`.
    expect(staged('sat-bare', 'AGENTS.md')).toBe('SIBLING RULES v2\n')

    // `seed` does not. Four of the repos being backfilled are not sibling apps,
    // so overwriting CLAUDE.md would assert in each of them that they are one.
    expect(staged('sat-bare', 'CLAUDE.md')).toBe(
      '# This repo is a Terraform runner fleet\n\n@AGENTS.md\n',
    )
  }, 120_000)

  it('reports a missing seeded file as drift, and a divergent one as the repo’s business', () => {
    const { run } = runSync(['--check'], {
      withSkeletons: true,
      satellites: [
        ['sat-missing', {}],
        [
          'sat-owned',
          {
            seedFiles: {
              'AGENTS.md': 'SIBLING RULES v2\n',
              'CLAUDE.md': '# Locally written context\n\n@AGENTS.md\n',
            },
          },
        ],
      ],
    })

    // Both fixtures hold a stale `scripts/verify.sh`, so both are DRIFTED; the
    // assertion is about WHICH paths each is reported behind on.
    const line = (name: string) =>
      // eslint-disable-next-line no-control-regex
      (run.out.split('\n').find((l) => l.startsWith(name)) ?? '').replace(/\[[0-9;]*m/g, '')

    expect(line('sat-missing')).toContain('AGENTS.md(missing)')
    expect(line('sat-missing')).toContain('CLAUDE.md(missing)')

    // The point of `seed`: a repo that wrote its own copy is not behind on
    // anything. Reporting it as drift would make --check permanently red in
    // exactly the repos that did the right thing.
    expect(line('sat-owned')).toContain('scripts/verify.sh')
    expect(line('sat-owned')).not.toContain('CLAUDE.md')
    expect(line('sat-owned')).not.toContain('AGENTS.md')
    expect(run.status).toBe(1)
  }, 120_000)

  it('--no-rehearse says so on the way past, rather than skipping quietly', () => {
    // AGENTS.md section 7: a gate may be loosened in the open, never silently.
    const { run } = runSync(['--no-rehearse'], { failingSatellite: true })

    expect(run.out).toMatch(/--no-rehearse: shipping 2 repos unproven/)
    expect(run.ghCalls.filter((c) => c.startsWith('pr create'))).toHaveLength(2)
  }, 120_000)

  // #1295's own symptom: `applies()` used to read the working tree instead of
  // the ref, so a fixture estate could survey every repo, exclude every one of
  // them, and still exit 0 with `run-start(rehearse)` immediately followed by
  // `run-end` and no staging events in between -- a well-formed empty pass
  // earned by reading nothing. That root cause is fixed (#1292), but the
  // failure MODE -- zero repos surveyed reported as a clean run -- is worth a
  // guard of its own, independent of what caused it: #1291 named exactly this
  // shape for the dependency audits ("this audit checked nothing. That is a
  // configuration error, not a pass.").
  it('fails loudly when the estate resolves to zero repos, in every mode', () => {
    // No satellites at all: the estate holds only the template, which is
    // always excluded, so the survey loop's `applies()`/`.git` filters never
    // let a single repo through -- this is what a fixture that failed to seed
    // any clones looks like, and it must not be silently indistinguishable
    // from "0 drifted".
    const zero = { satellites: [] as Array<[string, SatelliteOpts]> }

    const checkRun = runSync(['--check'], zero)
    expect(checkRun.run.status).not.toBe(0)
    expect(checkRun.run.out).toMatch(/surveyed zero repos/)

    const rehearseRun = runSync(['--rehearse'], zero)
    expect(rehearseRun.run.status).not.toBe(0)
    expect(rehearseRun.run.out).toMatch(/surveyed zero repos/)
    // Never reached Phase 1 -- nothing to rehearse and no PR to open.
    expect(rehearseRun.run.out).not.toMatch(/rehearsing/)

    const shipRun = runSync([], zero)
    expect(shipRun.run.status).not.toBe(0)
    expect(shipRun.run.out).toMatch(/surveyed zero repos/)
    expect(shipRun.run.ghCalls.filter((c) => c.startsWith('pr create'))).toEqual([])
  }, 120_000)
})

/**
 * `mustBeUniform` (#1108): the fourth list, and the only one that never
 * writes. It asserts that a path should read identically across every repo
 * that holds it, and `--check` fails a path only when its LIVE variant count
 * EXCEEDS the baseline recorded for it — the same posture
 * `biffo.orphan-baseline.json` established for the core-upgrade orphan
 * ratchet (`cli/src/lib/core-upgrade.ts`): pre-existing residue never
 * hard-blocks, only a NEW regression does.
 *
 * These fixtures use `filesUpToDate: true` so `scripts/verify.sh` /
 * `scripts/gate-coverage.sh` are current in every satellite — the ONLY signal
 * left in `--check`'s output is whatever each test seeds under
 * `mustBeUniform`, so a passing assertion here means the ratchet passed, not
 * that an unrelated `files` entry happened to as well.
 */
describe('mustBeUniform ratchet (#1108)', () => {
  it('reports a path at its recorded baseline, and does not fail --check', () => {
    const { run } = runSync(['--check'], {
      mustBeUniform: { 'shared/thing.txt': 2 },
      satellites: [
        ['sat-alpha', { filesUpToDate: true, seedFiles: { 'shared/thing.txt': 'content-A\n' } }],
        ['sat-beta', { filesUpToDate: true, seedFiles: { 'shared/thing.txt': 'content-B\n' } }],
      ],
    })

    expect(run.out).toMatch(
      /at baseline\s+shared\/thing\.txt\s+2 variants across 2 repos \(baseline 2\)/,
    )
    expect(run.status).toBe(0)
  }, 120_000)

  it('fails --check when a path is one variant worse than its baseline', () => {
    // This is the test that must fail against the UNMODIFIED script, and for
    // the right reason: not because of a crash or a missing flag, but because
    // nothing recognises `mustBeUniform` at all, so no WORSENED verdict is
    // ever printed and `--check` exits 0. Proven by hand before implementing
    // (see the PR body); this is the regression guard for that proof.
    const { run } = runSync(['--check'], {
      mustBeUniform: { 'shared/thing.txt': 2 },
      satellites: [
        ['sat-alpha', { filesUpToDate: true, seedFiles: { 'shared/thing.txt': 'content-A\n' } }],
        ['sat-beta', { filesUpToDate: true, seedFiles: { 'shared/thing.txt': 'content-B\n' } }],
        ['sat-gamma', { filesUpToDate: true, seedFiles: { 'shared/thing.txt': 'content-C\n' } }],
      ],
    })

    // stripAnsi: the verdict word alone is colour-wrapped, and the escape
    // sequence sits directly between it and the padding, which `\s+` cannot
    // span.
    expect(stripAnsi(run.out)).toMatch(
      /WORSENED\s+shared\/thing\.txt\s+3 variants across 3 repos \(baseline 2\)/,
    )
    expect(run.out).toMatch(/mustBeUniform path exceeded its baseline/)
    expect(run.status).toBe(1)
  }, 120_000)

  it('reports a path that converged, and says the baseline can be lowered', () => {
    // Baseline recorded at 3; the estate has since converged to a single
    // variant. A ratchet that only ever tightens on failure and never notices
    // improvement is a number nobody trusts enough to lower by hand.
    const { run } = runSync(['--check'], {
      mustBeUniform: { 'shared/thing.txt': 3 },
      satellites: [
        ['sat-alpha', { filesUpToDate: true, seedFiles: { 'shared/thing.txt': 'same-content\n' } }],
        ['sat-beta', { filesUpToDate: true, seedFiles: { 'shared/thing.txt': 'same-content\n' } }],
      ],
    })

    expect(run.out).toMatch(
      /uniform\s+shared\/thing\.txt\s+uniform across 2 repos \(baseline 3 -- lower it to 1\)/,
    )
    // Converging is not a failure — only EXCEEDING the baseline is.
    expect(run.status).toBe(0)
  }, 120_000)

  it('does not count a repo missing the path as a holder or a variant', () => {
    const { run } = runSync(['--check'], {
      mustBeUniform: { 'shared/thing.txt': 1 },
      satellites: [
        ['sat-alpha', { filesUpToDate: true, seedFiles: { 'shared/thing.txt': 'same-content\n' } }],
        ['sat-beta', { filesUpToDate: true, seedFiles: { 'shared/thing.txt': 'same-content\n' } }],
        // Holds neither the marker path's content nor is excluded from
        // `applies()` — it is a real applicable repo that simply never
        // received this particular file, exactly like a repo `files` has not
        // reached yet. It must not inflate the holder count to 3.
        ['sat-gamma', { filesUpToDate: true }],
      ],
    })

    expect(run.out).toMatch(/uniform\s+shared\/thing\.txt\s+uniform across 2 repos/)
    expect(run.out).not.toMatch(/across 3 repos/)
    expect(run.status).toBe(0)
  }, 120_000)
})

/**
 * `keyMustBeUniform` (#1352, #1367): the fifth list, and like `mustBeUniform`
 * the only other one that never writes. Unlike `mustBeUniform`, the unit
 * compared is not a whole file's blob SHA but the canonicalised JSON VALUE at
 * a dotted key path inside it — `apps/frontend/package.json` legitimately
 * differs per repo (`name`, `version`, `dependencies`) while its
 * `pnpm.overrides` (the estate's mechanism for pinning a transitive
 * dependency above a security advisory) must not.
 *
 * Two real occurrences drove this, and each fixture below targets the
 * specific symptom that motivated it:
 *
 *   - #1352: `nanoid` — the template held the fix while six siblings stayed
 *     vulnerable and red, because nothing distributed or even MEASURED the
 *     override.
 *   - #1367: `undici` — measured at several different upper bounds across the
 *     estate, one of which is outright ABSENCE. A plain `files`-style
 *     absence-detector reports every repo that HAS the key as "present",
 *     which is indistinguishable from correct — it cannot see two present
 *     values disagreeing. This mechanism has to catch both shapes: a key
 *     silently missing, and a key present but diverged.
 */
describe('keyMustBeUniform ratchet (#1352, #1367)', () => {
  it('reports a key path at its recorded baseline, and does not fail --check', () => {
    // Deliberately different `name`/`version`/override VALUE — the whole
    // point of a key-scoped ratchet is that the rest of the file (and even
    // this key, up to the declared baseline) is allowed to differ. If this
    // test needed identical files it would just be `mustBeUniform` again.
    const { run } = runSync(['--check'], {
      keyMustBeUniform: { 'apps/frontend/package.json': { 'pnpm.overrides': 2 } },
      satellites: [
        [
          'sat-alpha',
          {
            filesUpToDate: true,
            seedFiles: {
              'apps/frontend/package.json': JSON.stringify({
                name: '@tabsii/alpha',
                version: '1.4.0',
                pnpm: { overrides: { 'nanoid@<3.3.17': '>=3.3.17 <4' } },
              }),
            },
          },
        ],
        [
          'sat-beta',
          {
            filesUpToDate: true,
            seedFiles: {
              'apps/frontend/package.json': JSON.stringify({
                name: '@tabsii/beta',
                version: '0.9.2',
                pnpm: { overrides: { 'nanoid@<3.3.17': '>=3.3.16 <4' } },
              }),
            },
          },
        ],
      ],
    })

    expect(stripAnsi(run.out)).toMatch(
      /at baseline\s+apps\/frontend\/package\.json#pnpm\.overrides\s+2 variants across 2 repos \(baseline 2\)/,
    )
    expect(run.status).toBe(0)
  }, 120_000)

  it('treats object key ORDER as immaterial -- canonicalisation, not byte equality', () => {
    // Same logical override set, written in a different field order. A blob-SHA
    // comparison (mustBeUniform's mechanism) would call this 2 variants; a
    // subtree comparison that canonicalises before comparing must not.
    const { run } = runSync(['--check'], {
      keyMustBeUniform: { 'apps/frontend/package.json': { 'pnpm.overrides': 1 } },
      satellites: [
        [
          'sat-alpha',
          {
            filesUpToDate: true,
            seedFiles: {
              'apps/frontend/package.json': JSON.stringify({
                name: '@tabsii/alpha',
                pnpm: {
                  overrides: {
                    'nanoid@<3.3.17': '>=3.3.17 <4',
                    'undici@<7.29.0': '>=7.29.0 <8',
                  },
                },
              }),
            },
          },
        ],
        [
          'sat-beta',
          {
            filesUpToDate: true,
            seedFiles: {
              'apps/frontend/package.json': JSON.stringify({
                name: '@tabsii/beta',
                pnpm: {
                  // Same two entries, reverse order.
                  overrides: {
                    'undici@<7.29.0': '>=7.29.0 <8',
                    'nanoid@<3.3.17': '>=3.3.17 <4',
                  },
                },
              }),
            },
          },
        ],
      ],
    })

    expect(stripAnsi(run.out)).toMatch(
      /uniform\s+apps\/frontend\/package\.json#pnpm\.overrides\s+uniform across 2 repos/,
    )
    expect(run.status).toBe(0)
  }, 120_000)

  it('fails --check when a key path is one variant worse than its baseline', () => {
    // This is the test that must fail against the UNMODIFIED script, and for
    // the right reason: not a crash, but because nothing recognises
    // `keyMustBeUniform` at all, so no WORSENED verdict is ever printed and
    // `--check` exits 0. Proven by hand before implementing, the same
    // discipline the mustBeUniform regression guard above documents.
    const { run } = runSync(['--check'], {
      keyMustBeUniform: { 'apps/frontend/package.json': { 'pnpm.overrides': 1 } },
      satellites: [
        [
          'sat-alpha',
          {
            filesUpToDate: true,
            seedFiles: {
              'apps/frontend/package.json': JSON.stringify({
                name: '@tabsii/alpha',
                pnpm: { overrides: { 'undici@<7.29.0': '>=7.29.0 <8' } },
              }),
            },
          },
        ],
        [
          'sat-beta',
          {
            filesUpToDate: true,
            seedFiles: {
              'apps/frontend/package.json': JSON.stringify({
                name: '@tabsii/beta',
                // A DIFFERENT bound on the same override -- exactly the
                // #1367 shape, present in both repos but disagreeing.
                pnpm: { overrides: { 'undici@<7.29.0': '>=7.29.0 <9' } },
              }),
            },
          },
        ],
      ],
    })

    expect(stripAnsi(run.out)).toMatch(
      /WORSENED\s+apps\/frontend\/package\.json#pnpm\.overrides\s+2 variants across 2 repos \(baseline 1\)/,
    )
    expect(run.out).toMatch(/keyMustBeUniform key exceeded its baseline/)
    expect(run.status).toBe(1)
  }, 120_000)

  it('counts a key SILENTLY MISSING as its own variant, not a non-holder (#1352)', () => {
    // The #1352 shape exactly: a sibling that holds the FILE but not the
    // override inside it. A holder test keyed to the override itself would
    // skip this repo as "does not have it", which is indistinguishable from
    // "does not need it" -- the whole reason #1352 went undetected for 38
    // minutes. It must count as holding the FILE (so it is in scope) and as a
    // DISTINCT VALUE (absence), not be silently dropped.
    const { run } = runSync(['--check'], {
      keyMustBeUniform: { 'apps/frontend/package.json': { 'pnpm.overrides': 1 } },
      satellites: [
        [
          'sat-alpha',
          {
            filesUpToDate: true,
            seedFiles: {
              'apps/frontend/package.json': JSON.stringify({
                name: '@tabsii/alpha',
                pnpm: { overrides: { 'nanoid@<3.3.17': '>=3.3.17 <4' } },
              }),
            },
          },
        ],
        [
          'sat-beta',
          {
            filesUpToDate: true,
            seedFiles: {
              // Holds package.json, but the advisory pin never landed here --
              // no `pnpm` key at all, exactly like a sibling nobody patched.
              'apps/frontend/package.json': JSON.stringify({ name: '@tabsii/beta' }),
            },
          },
        ],
      ],
    })

    expect(stripAnsi(run.out)).toMatch(
      /WORSENED\s+apps\/frontend\/package\.json#pnpm\.overrides\s+2 variants across 2 repos \(baseline 1\)/,
    )
    expect(run.status).toBe(1)
  }, 120_000)

  it('reports FOUR divergent bounds on the same override, the exact #1367 shape', () => {
    // #1367 measured `undici`'s override at four different states across the
    // estate: unbounded, `<9`, `<8`, and absent entirely. A test that only
    // proves the two-way case leaves the actual reported defect unproven --
    // this reproduces all four in one run and asserts the report says 4.
    const { run } = runSync(['--check'], {
      keyMustBeUniform: { 'apps/frontend/package.json': { 'pnpm.overrides': 1 } },
      satellites: [
        [
          'sat-unbounded',
          {
            filesUpToDate: true,
            seedFiles: {
              'apps/frontend/package.json': JSON.stringify({
                pnpm: { overrides: { 'undici@<7.29.0': '>=7.29.0' } },
              }),
            },
          },
        ],
        [
          'sat-lt9',
          {
            filesUpToDate: true,
            seedFiles: {
              'apps/frontend/package.json': JSON.stringify({
                pnpm: { overrides: { 'undici@<7.29.0': '>=7.29.0 <9' } },
              }),
            },
          },
        ],
        [
          'sat-lt8',
          {
            filesUpToDate: true,
            seedFiles: {
              'apps/frontend/package.json': JSON.stringify({
                pnpm: { overrides: { 'undici@<7.29.0': '>=7.29.0 <8' } },
              }),
            },
          },
        ],
        [
          'sat-absent',
          {
            filesUpToDate: true,
            seedFiles: {
              // Holds the file and the `pnpm.overrides` object, just not this
              // particular entry -- tabsii-intake's actual shape in #1367.
              'apps/frontend/package.json': JSON.stringify({
                pnpm: { overrides: { 'postcss@<8.5.18': '>=8.5.18' } },
              }),
            },
          },
        ],
      ],
    })

    expect(stripAnsi(run.out)).toMatch(
      /WORSENED\s+apps\/frontend\/package\.json#pnpm\.overrides\s+4 variants across 4 repos \(baseline 1\)/,
    )
    expect(run.status).toBe(1)
  }, 120_000)

  it('reports a key path that converged, and says the baseline can be lowered', () => {
    const { run } = runSync(['--check'], {
      keyMustBeUniform: { 'apps/frontend/package.json': { 'pnpm.overrides': 3 } },
      satellites: [
        [
          'sat-alpha',
          {
            filesUpToDate: true,
            seedFiles: {
              'apps/frontend/package.json': JSON.stringify({
                pnpm: { overrides: { 'nanoid@<3.3.17': '>=3.3.17 <4' } },
              }),
            },
          },
        ],
        [
          'sat-beta',
          {
            filesUpToDate: true,
            seedFiles: {
              'apps/frontend/package.json': JSON.stringify({
                pnpm: { overrides: { 'nanoid@<3.3.17': '>=3.3.17 <4' } },
              }),
            },
          },
        ],
      ],
    })

    expect(stripAnsi(run.out)).toMatch(
      /uniform\s+apps\/frontend\/package\.json#pnpm\.overrides\s+uniform across 2 repos \(baseline 3 -- lower it to 1\)/,
    )
    // Converging is not a failure — only EXCEEDING the baseline is.
    expect(run.status).toBe(0)
  }, 120_000)

  it('does not count a repo missing the whole FILE as a holder or a variant', () => {
    const { run } = runSync(['--check'], {
      keyMustBeUniform: { 'apps/frontend/package.json': { 'pnpm.overrides': 1 } },
      satellites: [
        [
          'sat-alpha',
          {
            filesUpToDate: true,
            seedFiles: {
              'apps/frontend/package.json': JSON.stringify({
                pnpm: { overrides: { 'nanoid@<3.3.17': '>=3.3.17 <4' } },
              }),
            },
          },
        ],
        [
          'sat-beta',
          {
            filesUpToDate: true,
            seedFiles: {
              'apps/frontend/package.json': JSON.stringify({
                pnpm: { overrides: { 'nanoid@<3.3.17': '>=3.3.17 <4' } },
              }),
            },
          },
        ],
        // A plugin repo with no frontend at all -- never seeds
        // apps/frontend/package.json. Must not inflate the holder count.
        ['sat-gamma', { filesUpToDate: true }],
      ],
    })

    expect(stripAnsi(run.out)).toMatch(
      /uniform\s+apps\/frontend\/package\.json#pnpm\.overrides\s+uniform across 2 repos/,
    )
    expect(run.out).not.toMatch(/across 3 repos/)
    expect(run.status).toBe(0)
  }, 120_000)
})

/**
 * `--candidates` (#1108): advisory discovery, never the guard. It walks every
 * applicable repo's full tree — not just paths already in shared-files.json —
 * and reports unlisted paths held in >=5 repos, bucketed by variant count.
 * Unlike `--check`, it exits 0 unconditionally: it is a question for a human
 * to triage, not a build failure.
 */
describe('--candidates (#1108)', () => {
  it('reports an unlisted path present in >=5 repos, and exits 0 regardless', () => {
    const satellites: Array<[string, SatelliteOpts]> = Array.from({ length: 5 }, (_, i) => [
      `sat-${i}`,
      {
        filesUpToDate: true,
        seedFiles: { 'apps/frontend/src/lib/mystery.ts': 'export const mystery = 1\n' },
      },
    ])
    const { run } = runSync(['--candidates'], { satellites })

    expect(run.out).toMatch(/shared-set candidates/)
    expect(run.out).toMatch(/uniform but unlisted/)
    expect(run.out).toMatch(/apps\/frontend\/src\/lib\/mystery\.ts\s+1 variant\(s\) across 5 repos/)
    expect(run.out).toMatch(/advisory only/)
    // The mode's entire point: a candidate list outstanding must not fail
    // the build, or every estate would redden on the first run.
    expect(run.status).toBe(0)
  }, 120_000)

  it('does not report a path held in fewer than 5 repos', () => {
    const { run } = runSync(['--candidates'], {
      satellites: [
        [
          'sat-alpha',
          {
            filesUpToDate: true,
            seedFiles: { 'apps/frontend/src/lib/too-rare.ts': 'export const x = 1\n' },
          },
        ],
        [
          'sat-beta',
          {
            filesUpToDate: true,
            seedFiles: { 'apps/frontend/src/lib/too-rare.ts': 'export const x = 1\n' },
          },
        ],
      ],
    })

    expect(run.out).not.toMatch(/too-rare\.ts/)
    expect(run.status).toBe(0)
  }, 120_000)
})

/**
 * `overridesFloor` delivery, wired into the ordinary ship path (#1352's
 * remaining scope).
 *
 * `shared-sync-deliver-overrides.test.ts` and
 * `shared-sync-overrides-delivery.test.ts` already prove `--deliver-overrides`
 * and `apply_overrides_floor()` in isolation. What neither can prove is the
 * thing #1352 was actually left open for: that a MISSING override key rides
 * the SAME commit, push and PR as any other drifted shared file, through the
 * real `stage_repo`/`ship_repo` path this file already drives for `files` and
 * `filesFromSkeleton` -- rather than needing a second, racing round.
 */
describe('overridesFloor delivery, wired into the ship path (#1352)', () => {
  // `apply_overrides_floor` anchors its splice on a LINE matching
  // `"overrides": {`, so the fixture content -- like every real
  // `package.json` -- must be pretty-printed, not `JSON.stringify`'s default
  // single line. A minified fixture put the "line after the anchor" past the
  // end of the whole object, corrupting the JSON; caught by this suite before
  // being written down as a limitation here.
  const CANONICAL = JSON.stringify(
    {
      name: 'sibling-template-frontend',
      pnpm: {
        overrides: {
          'postcss@<8.5.18': '>=8.5.18',
          'nanoid@<3.3.17': '>=3.3.17 <4',
        },
      },
    },
    null,
    2,
  )

  it('delivers a missing override key in the SAME PR as an unrelated drifted file', () => {
    const { run, satellites } = runSync([], {
      overridesCanonical: CANONICAL,
      satellites: [
        [
          // Stale scripts/verify.sh (the default) makes this repo drifted on
          // `files` regardless of overridesFloor -- the case where a second,
          // unrelated change is already shipping and the override should ride
          // along rather than opening its own PR.
          'sat-alpha',
          {
            seedFiles: {
              'apps/frontend/package.json': JSON.stringify(
                {
                  name: 'sat-alpha',
                  pnpm: { overrides: { 'postcss@<8.5.18': '>=8.5.18' } },
                },
                null,
                2,
              ),
            },
          },
        ],
      ],
    })

    expect(run.status).toBe(0)
    // ONE PR for this repo, not two -- the assertion #1352 was left open for.
    expect(run.ghCalls.filter((c) => c.startsWith('pr create'))).toHaveLength(1)

    const written = JSON.parse(pushedFile(satellites[0], 'apps/frontend/package.json') ?? '{}')
    expect(written.pnpm.overrides['nanoid@<3.3.17']).toBe('>=3.3.17 <4')
    // The other drifted file rode the same branch/commit.
    expect(pushedFile(satellites[0], 'scripts/verify.sh')).toContain('verify passed')
  }, 120_000)

  it('ships a repo whose ONLY drift is a missing overridesFloor key', () => {
    // filesUpToDate: true means `files` reports this repo current -- the only
    // reason `diff_files` calls it drifted at all is the missing override key.
    // Without that counting as drift, this repo would never reach stage_repo
    // in the first place, and the splice would never run.
    const { run, satellites } = runSync([], {
      overridesCanonical: CANONICAL,
      satellites: [
        [
          'sat-only-overrides',
          {
            filesUpToDate: true,
            seedFiles: {
              'apps/frontend/package.json': JSON.stringify(
                {
                  name: 'sat-only-overrides',
                  pnpm: { overrides: { 'postcss@<8.5.18': '>=8.5.18' } },
                },
                null,
                2,
              ),
            },
          },
        ],
      ],
    })

    expect(run.out).toMatch(/sat-only-overrides.*drifted/)
    expect(run.status).toBe(0)
    expect(run.ghCalls.filter((c) => c.startsWith('pr create'))).toHaveLength(1)
    const written = JSON.parse(pushedFile(satellites[0], 'apps/frontend/package.json') ?? '{}')
    expect(written.pnpm.overrides['nanoid@<3.3.17']).toBe('>=3.3.17 <4')
  }, 120_000)

  it('never rewrites a key the repo already has, even if the value disagrees', () => {
    // Deliberately NOT `filesUpToDate` -- this repo already holds BOTH
    // canonical override keys (one disputed), so overridesFloor alone gives
    // it nothing to stage. Leaving the stale scripts/verify.sh in place means
    // it is still staged and shipped for an UNRELATED reason, which is the
    // real risk: does going through the real stage/ship path for something
    // else ever touch a present, disputed override key along the way?
    const { run, satellites } = runSync([], {
      overridesCanonical: CANONICAL,
      satellites: [
        [
          'sat-diverged',
          {
            seedFiles: {
              'apps/frontend/package.json': JSON.stringify(
                {
                  name: 'sat-diverged',
                  pnpm: {
                    overrides: {
                      'postcss@<8.5.18': '>=8.5.18',
                      // Present, disputed value -- the `sharp` shape. Must
                      // survive untouched; only a truly ABSENT key may be
                      // added, and this repo has none (both canonical keys
                      // are present already).
                      'nanoid@<3.3.17': '>=3.3.16',
                    },
                  },
                },
                null,
                2,
              ),
            },
          },
        ],
      ],
    })

    expect(run.status).toBe(0)
    expect(run.ghCalls.filter((c) => c.startsWith('pr create'))).toHaveLength(1)
    const written = JSON.parse(pushedFile(satellites[0], 'apps/frontend/package.json') ?? '{}')
    expect(written.pnpm.overrides['nanoid@<3.3.17']).toBe('>=3.3.16')
    // And the PR body must not falsely claim an overrides delivery that
    // never happened -- `ship_repo` only lists a path it actually diffed.
    expect(run.ghCalls.join('\n')).not.toContain('pnpm.overrides floor')
  }, 120_000)

  it('does not fail a repo with no apps/frontend/package.json to splice into', () => {
    // A plugin repo has no frontend at all. overridesFloor must be a no-op
    // for it, not a crash that takes down an otherwise-clean round.
    const { run, satellites } = runSync([], {
      overridesCanonical: CANONICAL,
      satellites: [['sat-no-frontend', { marker: 'biffo.plugin.json' }]],
    })

    expect(run.status).toBe(0)
    expect(run.ghCalls.filter((c) => c.startsWith('pr create'))).toHaveLength(1)
    expect(originHasSyncBranch(satellites[0])).toBe(true)
    expect(pushedFile(satellites[0], 'apps/frontend/package.json')).toBeNull()
  }, 120_000)

  it('reports the delivered key in the PR body', () => {
    const { run } = runSync([], {
      overridesCanonical: CANONICAL,
      satellites: [
        [
          'sat-alpha',
          {
            seedFiles: {
              'apps/frontend/package.json': JSON.stringify(
                {
                  name: 'sat-alpha',
                  pnpm: { overrides: { 'postcss@<8.5.18': '>=8.5.18' } },
                },
                null,
                2,
              ),
            },
          },
        ],
      ],
    })

    // `ghCalls` is the gh-invocation log split on EVERY newline, and the real
    // `--body` argument is itself multi-line -- so the PR body's file list
    // lands in later array entries, not on the `pr create ...` line itself.
    // Search the whole log rather than one entry.
    const log = run.ghCalls.join('\n')
    expect(log).toContain('apps/frontend/package.json')
    expect(log).toContain('pnpm.overrides floor')
  }, 120_000)

  it('leaves the floor untouched, and reports no PR, when every holder already meets it', () => {
    const { run } = runSync(['--check'], {
      overridesCanonical: CANONICAL,
      satellites: [
        [
          'sat-current',
          {
            filesUpToDate: true,
            seedFiles: {
              'apps/frontend/package.json': JSON.stringify(
                {
                  name: 'sat-current',
                  pnpm: {
                    overrides: {
                      'postcss@<8.5.18': '>=8.5.18',
                      'nanoid@<3.3.17': '>=3.3.17 <4',
                    },
                  },
                },
                null,
                2,
              ),
            },
          },
        ],
      ],
    })

    expect(run.out).toMatch(/floor met|ok\s+sat-current/)
    expect(run.status).toBe(0)
  }, 120_000)
})
