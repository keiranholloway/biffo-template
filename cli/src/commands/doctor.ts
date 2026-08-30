import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import { GithubCliAdapter } from '../adapters/github-cli/index.js'
import { GitAdapter } from '../adapters/git/index.js'
import { CORE_VERSION_FILE, INSTANCE_CORE_FILE } from '../lib/core-version.js'
import { type DoctorFinding, type RepoFacts, runDoctorChecks } from '../lib/doctor.js'
import { type KeepReason, type ReapOutcome, reapAll } from '../lib/doctor-reaper.js'
import { log } from '../lib/logger.js'

/** The integration branch in every Biffo repo (AGENTS.md §2). */
const INTEGRATION_BRANCH = 'dev'

export const doctorCommand = new Command('doctor')
  .description(
    'Report repo-state conditions that make everything read from this checkout unreliable',
  )
  .option('--cwd <path>', 'Repo root to inspect (defaults to the current directory)')
  .option('--no-fetch', 'Skip the fetch; report against refs as they already are locally')
  .option(
    '--fix',
    "Also remove any worktree PROVEN safe: one whose branch's PR merged, verified via GitHub " +
      '(never local commit reachability — a squash merge rewrites every SHA). Everything else ' +
      '(no PR, PR open, PR closed unmerged, detached HEAD, uncommitted changes) is reported, ' +
      'never touched. Branch deletion is not yet automated here — that is #1682 milestone 2.',
  )
  .action(async (options: { cwd?: string; fetch?: boolean; fix?: boolean }) => {
    const cwd = options.cwd ? resolve(options.cwd) : process.cwd()
    const git = new GitAdapter()
    try {
      const facts = await gatherRepoFacts({ cwd, fetch: options.fetch !== false }, { git })
      const findings = runDoctorChecks(facts)
      printFindings(findings)

      if (options.fix === true) {
        const outcomes = await runDoctorFix(cwd, facts, { git, github: new GithubCliAdapter() })
        printReapOutcomes(outcomes)
      }

      // Non-zero on findings so CI can use this. Warnings alone do not fail:
      // a stale branch is worth reporting and is nobody's blocker.
      if (findings.some((f) => f.severity === 'error')) process.exit(1)
    } catch (err) {
      log.error((err as Error).message)
      process.exit(1)
    }
  })

export interface DoctorOptions {
  cwd: string
  fetch: boolean
}

export interface DoctorDeps {
  git: Pick<
    GitAdapter,
    | 'isGitRepo'
    | 'currentBranch'
    | 'isPrimaryWorktree'
    | 'hasUncommittedChanges'
    | 'fetchPrune'
    | 'aheadBehind'
    | 'listBranchRefs'
    | 'listWorktrees'
    | 'countBehind'
    | 'showFileAtRef'
  >
}

/** What `runDoctorFix` needs beyond `DoctorDeps` — the destructive worktree removal and the GitHub PR lookup that proves it safe. Kept separate from `DoctorDeps` so every plain `runDoctor` caller is unaffected by this milestone (#1682). */
export interface DoctorFixDeps {
  git: Pick<GitAdapter, 'hasUncommittedChanges' | 'currentBranch' | 'removeWorktree'>
  github: Pick<GithubCliAdapter, 'prVerdictForBranch'>
}

/**
 * Gather the facts, then judge them (#797).
 *
 * Deliberately split: `lib/doctor.ts` holds every judgement and takes plain
 * data, so the conditions are testable without a repository in a given state —
 * several of which (a checkout 114 versions stale, a worktree 30 core versions
 * old) are impractical to construct on demand.
 *
 * Read-only throughout. The one non-read is `fetch --prune`, without which a
 * merged branch's upstream never reports as gone and the branch and worktree
 * checks silently find nothing. `--no-fetch` opts out for offline use, at the
 * cost of those two checks being blind.
 *
 * Split out from `runDoctor` (#1682) so `--fix` can reuse the exact same
 * facts the report was printed from, rather than re-fetching and re-listing
 * everything a second time immediately after.
 */
export async function gatherRepoFacts(
  options: DoctorOptions,
  deps: DoctorDeps,
): Promise<RepoFacts> {
  const { git } = deps

  if (!(await git.isGitRepo(options.cwd))) {
    throw new Error(`${options.cwd} is not a git repository.`)
  }

  if (options.fetch) await git.fetchPrune(options.cwd)

  const currentBranch = await git.currentBranch(options.cwd)
  const isPrimary = await git.isPrimaryWorktree(options.cwd)
  const isDirty = await git.hasUncommittedChanges(options.cwd)
  const { ahead, behind, hasUpstream } = await git.aheadBehind(options.cwd)
  const branches = await git.listBranchRefs(options.cwd)

  const worktreePaths = await git.listWorktrees(options.cwd)
  const worktrees = await Promise.all(
    worktreePaths.map(async (w) => ({
      ...w,
      behind: await git.countBehind(options.cwd, w.branch, `origin/${INTEGRATION_BRANCH}`),
    })),
  )

  return {
    currentBranch,
    isPrimary,
    integrationBranch: INTEGRATION_BRANCH,
    ahead,
    behind,
    hasUpstream,
    isDirty,
    // localCoreVersion and remoteCoreVersion are deliberately decoded through
    // DIFFERENT code (#1544) — see readLocalCoreVersion's doc comment for why
    // a shared decode step here would make checkCoreVersionCurrency blind to
    // a fault in it.
    localCoreVersion: readLocalCoreVersion(options.cwd),
    remoteCoreVersion: parseCoreRecord(
      await git.showFileAtRef(options.cwd, `origin/${INTEGRATION_BRANCH}`, INSTANCE_CORE_FILE),
    ),
    fossilCoreVersion: readFossil(options.cwd),
    branches,
    worktrees,
  }
}

/** Back-compat entry point: gather, then report. `--fix` needs the facts too, hence the split above. */
export async function runDoctor(
  options: DoctorOptions,
  deps: DoctorDeps = { git: new GitAdapter() },
): Promise<DoctorFinding[]> {
  const facts = await gatherRepoFacts(options, deps)
  return runDoctorChecks(facts)
}

/**
 * `--fix` (#1682, milestone 1): remove any worktree `gatherRepoFacts` already
 * proved has a `[gone]` upstream, restricted further to what
 * `classifyReapCandidate` can prove safe from GitHub's own verdict on its
 * branch's PR. See `lib/doctor-reaper.ts` for the full table and why a naive
 * commit-reachability check is wrong. Never deletes a branch — that is
 * milestone 2, and nothing calls `--fix` yet — that is milestone 3.
 */
export async function runDoctorFix(
  cwd: string,
  facts: Pick<RepoFacts, 'branches' | 'worktrees' | 'currentBranch'>,
  deps: DoctorFixDeps = { git: new GitAdapter(), github: new GithubCliAdapter() },
): Promise<ReapOutcome[]> {
  return reapAll(cwd, facts.branches, facts.worktrees, facts.currentBranch, deps)
}

/**
 * `biffo.core.json`'s version, or null.
 *
 * Read directly rather than via `readInstanceCoreVersion`, which falls back to
 * `core.version` when the record is absent — exactly the conflation `doctor`
 * exists to surface. Using it here would make the fossil check compare a value
 * against itself.
 *
 * Decoded via `extractVersionField`, NOT `parseCoreRecord` (#1544). Before
 * this, `checkCoreVersionCurrency` compared this value against
 * `remoteCoreVersion` — but both were decoded through the identical
 * `parseCoreRecord()` JSON.parse helper, so a fault in that one function
 * would mangle both reads the same way and the comparison would agree over
 * data it never actually verified (class #1362, instance 11 shape — the same
 * mechanism that let `core-upgrade-target-fidelity.ts` re-read its own lossy
 * output and report it clean). Concretely reproducible with today's real
 * JSON.parse: a `biffo.core.json` corrupted with a duplicate `version` key
 * resolves, per spec, to whichever occurs LAST — silently discarding a
 * genuinely different earlier value. Using a structurally different parser
 * for this side (a regex scan over raw text, matching the FIRST occurrence,
 * no JSON.parse involved) means a fault specific to either decode step
 * cannot mangle both reads into false agreement; see
 * `commands/doctor.test.ts`'s "notices real drift a shared decoder would
 * paper over" test.
 */
function readLocalCoreVersion(cwd: string): string | null {
  const path = join(cwd, INSTANCE_CORE_FILE)
  if (!existsSync(path)) return null
  try {
    return extractVersionField(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function parseCoreRecord(contents: string | null): string | null {
  if (contents === null) return null
  try {
    const parsed = JSON.parse(contents) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

/**
 * A second, structurally independent way to read a `version` field: a plain
 * regex scan over raw text, with no JSON.parse involved at all (#1544).
 *
 * Deliberately not "`parseCoreRecord` under another name" — it shares no
 * helper, no parsing library call, and no error-handling path with it.
 * Matches the FIRST `"version": "…"` occurrence in the text, which is what
 * makes it disagree with JSON.parse's spec-mandated LAST-wins resolution of
 * a duplicate key — the concrete divergence this function exists to catch.
 * Core versions are plain `major.minor.patch` semver with no pre-release or
 * build metadata (see `core-version.ts`'s `SEMVER`), so the pattern does not
 * need to handle either.
 */
function extractVersionField(contents: string | null): string | null {
  if (contents === null) return null
  const match = /"version"\s*:\s*"(\d+\.\d+\.\d+)"/.exec(contents)
  return match?.[1] ?? null
}

function readFossil(cwd: string): string | null {
  const path = join(cwd, CORE_VERSION_FILE)
  if (!existsSync(path)) return null
  try {
    const value = readFileSync(path, 'utf8').trim()
    return value === '' ? null : value
  } catch {
    return null
  }
}

function printFindings(findings: DoctorFinding[]): void {
  if (findings.length === 0) {
    log.success('No findings — this checkout can be trusted.')
    return
  }

  const errors = findings.filter((f) => f.severity === 'error')
  const warnings = findings.filter((f) => f.severity === 'warn')

  console.log('')
  for (const f of findings) {
    const tag = f.severity === 'error' ? chalk.red('error') : chalk.yellow(' warn')
    console.log(`  ${tag}  ${chalk.bold(f.check)}`)
    console.log(`         ${f.detail}`)
    console.log(chalk.dim(`         fix: ${f.remedy}`))
    console.log('')
  }
  console.log(
    chalk.dim(
      `  ${String(errors.length)} error(s), ${String(warnings.length)} warning(s). ` +
        `Errors mean values read from this checkout may be wrong.\n`,
    ),
  )
}

const KEEP_REASON_TEXT: Record<KeepReason, string> = {
  'detached-head': 'worktree HEAD is detached',
  'uncommitted-changes': 'worktree has uncommitted changes',
  'pr-open': 'PR is still open',
  'pr-closed': 'PR closed unmerged',
  'no-pr': 'no PR was ever opened from this branch',
  'unknown-pr-verdict': "could not read this branch's PR state from GitHub",
}

/**
 * Reports what `--fix` removed and, per #1413's denominator rule, exactly
 * what it left alone and why — a reaper that only ever announces successes
 * is as misleading as a check that silently narrows its own scope.
 */
function printReapOutcomes(outcomes: ReapOutcome[]): void {
  if (outcomes.length === 0) {
    console.log(chalk.dim('  --fix: no worktree with a gone upstream to consider.\n'))
    return
  }

  const reaped = outcomes.filter((o) => o.verdict.action === 'reap')
  const kept = outcomes.filter((o) => o.verdict.action === 'keep')

  console.log('')
  for (const o of reaped) {
    if (o.worktreeRemoved === true) {
      console.log(chalk.green(`  removed  ${o.candidate.worktreePath} (${o.candidate.branch})`))
    } else {
      console.log(
        chalk.red(
          `  FAILED   ${o.candidate.worktreePath} (${o.candidate.branch}) — judged safe to ` +
            `remove but 'git worktree remove' did not succeed; left as-is`,
        ),
      )
    }
  }
  for (const o of kept) {
    const reason = o.verdict.reason === undefined ? 'unknown' : KEEP_REASON_TEXT[o.verdict.reason]
    console.log(
      chalk.dim(`  kept     ${o.candidate.worktreePath} (${o.candidate.branch}) — ${reason}`),
    )
  }
  console.log(
    chalk.dim(
      `\n  --fix: ${String(reaped.length)} removed, ${String(kept.length)} kept, of ` +
        `${String(outcomes.length)} worktree(s) considered.\n`,
    ),
  )
}
