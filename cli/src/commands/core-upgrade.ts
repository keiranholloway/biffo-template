import { execSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import chalk from 'chalk'
import { execa } from '../lib/exec.js'
import { Command } from 'commander'
import { GitAdapter } from '../adapters/git/index.js'
import { GitHubAdapter } from '../adapters/source-control/github/index.js'
import { readCoreManifest, resolveTemplateRoot } from '../lib/core-manifest.js'
import {
  CORE_VERSION_FILE,
  type CoreVersionCleanup,
  latestCoreVersionFromTags,
  planCoreVersionCleanup,
  readCoreVersionFile,
  readDeclinedMigrations,
  readInstanceCoreVersion,
  writeInstanceCoreVersion,
} from '../lib/core-version.js'
import {
  type MigrationCarryPlan,
  type MigrationTestPairing,
  applyMigrationCarry,
  findMigrationTestPairings,
  planMigrationCarry,
} from '../lib/core-migrations.js'
import {
  type ApplyResult,
  type MergeEntry,
  type OrphanRatchet,
  type UpgradePlan,
  ORPHAN_BASELINE_FILE,
  applyUpgradePlan,
  checkOrphanRatchet,
  parseGitHubRepo,
  planCoreUpgrade,
  readOrphanBaseline,
  upgradeBranchName,
  writeOrphanBaseline,
} from '../lib/core-upgrade.js'
import {
  type MaterializedTree,
  materializeTemplateAtTag,
  workingTreeMatchesTag,
} from '../lib/core-template-trees.js'
import {
  type FidelityReport,
  assertTargetFidelity,
  fidelityFailure,
} from '../lib/core-upgrade-target-fidelity.js'
import { type InstanceSeam, findNewUndeclaredSeams } from '../lib/instance-seams.js'
import {
  type AdoptionFinding,
  type AdoptionReport,
  checkInstanceAdoption,
} from '../lib/instance-adoption.js'
import {
  type BreakingChange,
  UPGRADE_GUIDE_PATH,
  breakingChangesBetween,
  readBreakingChanges,
} from '../lib/breaking-changes.js'
import { GLOBAL_DISPATCH_REF, GLOBAL_DISPATCH_WORKFLOW_PATHS } from '../lib/global-workflows.js'
import { classifyUpgradeBranches, type BranchRef } from '../lib/upgrade-branch-reaper.js'
import { staleFirstPartyCopies } from '../lib/plugin-terraform-wiring.js'
import {
  type LockfileRefreshOutcome,
  type RunCommandFn,
  describeFailures,
  lockfilesNeedingRefresh,
  refreshLockfiles,
} from '../lib/lockfile-refresh.js'
import {
  describeInstallFailures,
  installInstanceDependencies,
} from '../lib/instance-dependency-install.js'
import { log } from '../lib/logger.js'

/**
 * Guidance shown when `core upgrade` cannot find a template root — which is the
 * normal case from a published CLI, since `core-manifest.json` is excluded from
 * the npm package (issue #315). It names the fully-descriptive, canonical flag
 * this command exposes (`--template-repo` — it says what it actually is, a git
 * checkout whose tags matter, not just a directory) and shows a complete
 * invocation, because that flag is always required on this path. `--template`
 * works too as an alias (#1138, see `resolveTemplateRepoFlag` below), but the
 * guidance keeps naming the longer, more descriptive spelling. Every `--flag`
 * it names must be a real option on `coreUpgradeCommand`; `error-flag-
 * consistency.test.ts` enforces that (#324).
 */
export const MISSING_TEMPLATE_ROOT_GUIDANCE =
  'Pass --template-repo <path> to a biffo-template git checkout, e.g. ' +
  '`biffo core upgrade --template-repo /path/to/biffo-template`.'

/**
 * Merge `--template-repo` and its alias `--template` (#1138) into the single
 * path `runCoreUpgrade` wants.
 *
 * `core diff` and `core upgrade` used to name this argument differently
 * (`--template` vs `--template-repo`), so the natural preview-then-apply
 * workflow failed on the second command with the flag that had just worked on
 * the first — and commander's own "did you mean" suggestion made it worse,
 * pointing at `--to-template`, a flag with different semantics (an override
 * for the TARGET tree, not the tag source) that silently changes what the
 * command does rather than failing loudly. `--template-repo` stays the
 * documented, canonical name; `--template` is now accepted here too so the
 * flag that just worked on `core diff` keeps working on `core upgrade`.
 *
 * Throws when both are given and disagree: silently preferring one over the
 * other would change what the command does without saying so, which is a
 * worse failure than an error naming both values.
 */
export function resolveTemplateRepoFlag(
  templateRepo: string | undefined,
  template: string | undefined,
): string | undefined {
  if (
    templateRepo !== undefined &&
    template !== undefined &&
    resolve(templateRepo) !== resolve(template)
  ) {
    throw new Error(
      `Both --template-repo (${templateRepo}) and --template (${template}) were given, with ` +
        'different paths. They are the same argument — --template is an alias for ' +
        '--template-repo (#1138) — so pass only one.',
    )
  }
  return templateRepo ?? template
}

export const coreUpgradeCommand = new Command('upgrade')
  .description('Three-way-merge template-owned files for a core upgrade; preview it or open a PR')
  .option('--cwd <path>', 'Instance repo root to upgrade (defaults to the current directory)')
  .option(
    '--template-repo <path>',
    'Path to a biffo-template git checkout whose core-v* tags supply the base/target trees (defaults to the template this CLI ships with)',
  )
  .option(
    '--template <path>',
    'Alias for --template-repo, so the flag that works on `core diff` also works here (#1138). Errors if both are given with different paths.',
  )
  .option('--to <version>', 'Target core version (defaults to the template’s latest core.version)')
  .option(
    '--from-template <path>',
    'Override: path to a template checkout at the instance’s CURRENT version (the merge base). Normally auto-resolved from the core-v<version> tag.',
  )
  .option(
    '--to-template <path>',
    'Override: path to a template checkout at the TARGET version. Normally auto-resolved.',
  )
  .option('--apply', 'Apply the plan on a new branch and open a PR (default: dry run)')
  .option('--allow-conflicts', 'With --apply, open the PR even if some files conflict')
  .option(
    '--acknowledge-breaking',
    'With --apply, proceed even though this upgrade crosses a documented breaking change',
  )
  .option(
    '--allow-dirty',
    'Compute the plan even with uncommitted changes in the instance tree (they become part of the merge)',
  )
  .option('--base <branch>', 'Base branch for the PR (defaults to the repo’s default branch)')
  .option('--remote <name>', 'Git remote to push to and open the PR on (default: origin)')
  .option(
    '--reap',
    'Delete local branches previous upgrade runs left behind, once their PR has merged (#758)',
  )
  .action(
    async (options: {
      cwd?: string
      templateRepo?: string
      template?: string
      to?: string
      fromTemplate?: string
      toTemplate?: string
      apply?: boolean
      allowConflicts?: boolean
      acknowledgeBreaking?: boolean
      allowDirty?: boolean
      base?: string
      remote?: string
      reap?: boolean
    }) => {
      try {
        const cwd = options.cwd ? resolve(options.cwd) : process.cwd()
        const runOptions: CoreUpgradeOptions = {
          cwd,
          apply: options.apply ?? false,
          allowConflicts: options.allowConflicts ?? false,
          acknowledgeBreaking: options.acknowledgeBreaking ?? false,
          allowDirty: options.allowDirty ?? false,
        }
        // Can throw (--template-repo and --template both given, disagreeing) —
        // inside the try so it reports the same way as any other user-facing
        // error, not an uncaught stack trace (#1138).
        const templateRepoFlag = resolveTemplateRepoFlag(options.templateRepo, options.template)
        if (templateRepoFlag) runOptions.templateRepo = resolve(templateRepoFlag)
        if (options.to) runOptions.toVersion = options.to
        if (options.fromTemplate) runOptions.baseDir = resolve(options.fromTemplate)
        if (options.toTemplate) runOptions.theirsDir = resolve(options.toTemplate)
        if (options.base) runOptions.base = options.base
        if (options.remote) runOptions.remote = options.remote
        if (options.reap) runOptions.reap = true
        await runCoreUpgrade(runOptions)
      } catch (err) {
        log.error((err as Error).message)
        process.exit(1)
      }
    },
  )

export interface CoreUpgradeOptions {
  cwd: string
  /** Explicit merge-base template checkout. When omitted, the base tree is
   * auto-resolved from the `core-v<instance version>` tag in `templateRepo`. */
  baseDir?: string
  /** Explicit target template checkout. When omitted, resolved from the target
   * version's tag (or the template working tree when the target is its version). */
  theirsDir?: string
  /** Git repo (a biffo-template clone) whose `core-v*` tags the base/target
   * trees are materialized from. Defaults to the template this CLI ships with. */
  templateRepo?: string
  /** Target core version. Defaults to the template's latest `core.version`. */
  toVersion?: string
  apply?: boolean
  allowConflicts?: boolean
  /** Compute the plan despite uncommitted changes in the instance tree (#394). */
  allowDirty?: boolean
  /** Proceed with --apply even though the upgrade crosses a documented
   * breaking change. Deliberate keystroke, not a default. */
  acknowledgeBreaking?: boolean
  base?: string
  remote?: string
  /** Delete previous upgrade branches this tool left behind (#758). */
  reap?: boolean
}

// Minimal adapter interfaces so the apply path is unit-testable with fakes.
export interface CoreUpgradeGit {
  isGitRepo(cwd: string): Promise<boolean>
  hasUncommittedChanges(cwd: string): Promise<boolean>
  /** Checked-out branch name; git reports the literal "HEAD" when detached. */
  currentBranch(cwd: string): Promise<string>
  /** Best-effort fetch of the tracking remote (never throws on offline). */
  fetch(cwd: string, remote?: string): Promise<void>
  /** HEAD vs its upstream; hasUpstream is false when nothing is tracked. */
  aheadBehind(cwd: string): Promise<{ ahead: number; behind: number; hasUpstream: boolean }>
  getRemoteUrl(cwd: string, remote?: string): Promise<string>
  createBranch(cwd: string, branch: string): Promise<void>
  /** Switch to an existing branch — the undo of `createBranch` (#984). */
  switchBranch(cwd: string, branch: string): Promise<void>
  add(cwd: string, paths: string[]): Promise<void>
  commit(cwd: string, message: string): Promise<void>
  push(cwd: string, branch: string, opts?: { remote?: string; token?: string }): Promise<void>
  /**
   * Branch hygiene (#758). Optional so the many existing fakes in the test
   * suite — which implement this interface literally — keep compiling; the
   * reaper simply reports nothing when a fake omits them.
   */
  fetchPrune?(cwd: string, remote?: string): Promise<void>
  listBranchRefs?(cwd: string): Promise<BranchRef[]>
  deleteBranch?(cwd: string, branch: string): Promise<boolean>
}
export interface CoreUpgradeGitHub {
  /** The repo's default branch, as GitHub reports it. */
  defaultBranch(args: { owner: string; repo: string }): Promise<string>
  createPullRequest(args: {
    owner: string
    repo: string
    head: string
    base: string
    title: string
    body: string
  }): Promise<{ url: string; number: number }>
}
export interface CoreUpgradeDeps {
  git: CoreUpgradeGit
  makeGitHub: (token: string) => CoreUpgradeGitHub
  resolveToken: () => string
  /** Materialize the template tree at a core version's tag. Injectable so the
   * auto-resolution path is testable without a real tagged repo. */
  materialize?: (repo: string, version: string) => MaterializedTree
  /** Whether the template checkout's working tree faithfully equals a version's
   * tag. Gates the working-tree fast path (#471). Injectable so the fallback is
   * testable without a real tagged repo. */
  workingTreeMatchesTag?: (repo: string, version: string) => boolean
  /** Runs a lockfile-regeneration command in the instance. Injectable so the
   * refresh is testable without pnpm or uv on the machine. */
  runCommand?: RunCommandFn
}

function defaultDeps(): CoreUpgradeDeps {
  return {
    git: new GitAdapter(),
    makeGitHub: (token) => new GitHubAdapter(token),
    resolveToken: resolveGitHubToken,
    materialize: materializeTemplateAtTag,
    workingTreeMatchesTag,
  }
}

function resolveGitHubToken(): string {
  const env = process.env['GITHUB_TOKEN']
  if (env) return env
  try {
    const token = execSync('gh auth token', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (token) return token
  } catch {
    /* fall through to the error below */
  }
  throw new Error('No GitHub credentials found. Set GITHUB_TOKEN or run `gh auth login`.')
}

/**
 * ADR-0006 Phase 3 `biffo core upgrade`.
 *
 * Without --apply: compute and print the three-way-merge plan (Phase 3a).
 * With --apply (Phase 3b): create a branch, write the merged files (bumping
 * biffo.core.json), commit, push, and open a PR on the instance repo — never a
 * direct push to a protected branch. Only template-owned paths are touched.
 */
export async function runCoreUpgrade(
  options: CoreUpgradeOptions,
  deps: CoreUpgradeDeps = defaultDeps(),
): Promise<void> {
  const cleanups: Array<() => void> = []
  try {
    await runCoreUpgradeResolved(options, deps, cleanups)
    // After the run, so the branch this run just created is never a candidate
    // (its upstream is live, and it is the current branch besides).
    await reportUpgradeBranches(options, deps)
  } finally {
    for (const c of cleanups) c()
  }
}

/**
 * Report — and with `--reap`, delete — the local branches previous upgrade runs
 * left behind (#758).
 *
 * Every `--apply` creates a branch whose PR is squash-merged and whose remote
 * copy `--delete-branch` then removes, so the local one is dead but provable by
 * neither `git branch --merged` (squash) nor `git branch -d` (not an ancestor).
 * 190 accumulated across three repos with nothing ever looking wrong. #761
 * made them detectable by recording an upstream; this closes the loop.
 *
 * Runs on the dry-run path too: noticing the mess costs nothing and does not
 * require committing to an upgrade.
 *
 * Best-effort throughout. This is hygiene reporting appended to a run that has
 * already done its real work — an upgrade that opened a PR must not report
 * failure because a branch listing did.
 */
async function reportUpgradeBranches(
  options: CoreUpgradeOptions,
  deps: CoreUpgradeDeps,
): Promise<void> {
  const git = deps.git
  if (git.listBranchRefs === undefined || git.fetchPrune === undefined) return

  try {
    if (!(await git.isGitRepo(options.cwd))) return

    // Without a prune, a branch whose remote copy was deleted still looks
    // alive, and nothing is ever reapable.
    await git.fetchPrune(options.cwd, options.remote)
    const refs = await git.listBranchRefs(options.cwd)
    const current = await git.currentBranch(options.cwd)
    const { reapable, unverifiable } = classifyUpgradeBranches(refs, current)

    if (reapable.length === 0 && unverifiable.length === 0) return

    if (reapable.length > 0 && options.reap === true && git.deleteBranch !== undefined) {
      let deleted = 0
      for (const branch of reapable) {
        if (await git.deleteBranch(options.cwd, branch)) deleted++
      }
      log.success(`Reaped ${String(deleted)} merged upgrade branch(es).`)
    } else if (reapable.length > 0) {
      console.log(
        chalk.dim(
          `\n  ${String(reapable.length)} previous upgrade branch(es) are merged and their remote ` +
            `copies are gone. Re-run with --reap to delete them.`,
        ),
      )
    }

    if (unverifiable.length > 0) {
      // Deliberately never deleted: with no upstream recorded these are
      // indistinguishable from local work that was never pushed.
      console.log(
        chalk.dim(
          `  ${String(unverifiable.length)} older upgrade branch(es) have no upstream recorded ` +
            `(created before #761), so they cannot be proven merged and are left alone.`,
        ),
      )
    }
  } catch {
    // Hygiene only — never fail an upgrade that landed.
  }
}

/**
 * Refuse to compute a plan against an instance tree whose identity is not
 * established (#394). The instance tree is the merge's "ours" side, so a stale,
 * diverged, dirty or detached checkout silently produces a wrong three-way merge
 * and a PR that looks authoritative. Same principle as the migration carry's
 * fail-closed `validateChain` (#366), one level up: establish the tree first.
 */
async function checkInstanceCurrency(
  git: CoreUpgradeGit,
  cwd: string,
  allowDirty: boolean,
): Promise<void> {
  // Not a git repo: identity cannot be established from history. The apply path
  // already refuses a non-repo; a dry run against loose files stays allowed.
  if (!(await git.isGitRepo(cwd))) return

  const branch = await git.currentBranch(cwd)
  if (branch === 'HEAD' || branch === '') {
    throw new Error(
      `${cwd} has a detached HEAD, so the tree the plan would merge as "ours" has no branch ` +
        `identity. Check out the integration branch first (#394).`,
    )
  }

  await git.fetch(cwd)
  const { ahead, behind, hasUpstream } = await git.aheadBehind(cwd)
  if (hasUpstream && behind > 0) {
    const diverged = ahead > 0 ? ` and ${ahead} ahead (diverged)` : ''
    throw new Error(
      `${cwd} is ${behind} commit(s) behind its upstream${diverged}. The plan would merge onto a ` +
        `stale tree and propose reintroducing superseded content. Run \`git pull\` first, or fix the ` +
        `divergence, then re-run (#394).`,
    )
  }

  if (!allowDirty && (await git.hasUncommittedChanges(cwd))) {
    throw new Error(
      `${cwd} has uncommitted changes, which would silently become part of the merge's "ours" side. ` +
        `Commit or stash them, or pass --allow-dirty to accept them deliberately (#394).`,
    )
  }
}

async function runCoreUpgradeResolved(
  options: CoreUpgradeOptions,
  deps: CoreUpgradeDeps,
  cleanups: Array<() => void>,
): Promise<void> {
  await checkInstanceCurrency(deps.git, options.cwd, options.allowDirty ?? false)

  const materialize = deps.materialize ?? materializeTemplateAtTag
  const treeMatchesTag = deps.workingTreeMatchesTag ?? workingTreeMatchesTag
  const templateRepo = options.templateRepo
    ? resolve(options.templateRepo)
    : resolveTemplateRoot({ guidance: MISSING_TEMPLATE_ROOT_GUIDANCE })
  const instanceVersion = readInstanceCoreVersion(options.cwd)

  // Target tree (theirs): explicit checkout > template working tree (when the
  // target is its own version) > the target version's tag. `toVersion` is read
  // from whichever tree is used, so display and branch naming stay consistent.
  let theirsDir: string
  let toVersion: string
  if (options.theirsDir) {
    theirsDir = options.theirsDir
    // An explicitly supplied tree is an arbitrary checkout, not a tag, so its
    // version can only come from a file it may not have. Older tags still carry
    // one; for anything newer the caller passes --to.
    toVersion = versionOfCheckout(theirsDir, options.toVersion)
  } else {
    // The template's current version is its highest core-v* tag, not a file
    // (#423). A tag needs no push to a protected branch and cannot conflict
    // between concurrent PRs, which is what made the file churn.
    const workingVersion = latestCoreVersion(templateRepo)
    toVersion = options.toVersion ?? workingVersion
    if (toVersion === workingVersion && treeMatchesTag(templateRepo, toVersion)) {
      // Fast path: the checkout is exactly the target tag's commit with a clean
      // tracked tree, so its working files ARE the tagged tree — use them
      // directly and skip the extract.
      //
      // "Tracked" is load-bearing and used not to be true: the planner walked
      // the directory, so gitignored build output in the operator's checkout
      // rode along as files to commit into the instance (#1006). It now reads
      // this tree through the git index, which is what makes the fast path
      // equivalent to the extract rather than merely faster than it.
      theirsDir = templateRepo
    } else {
      // The target isn't the latest, OR the checkout has drifted from the tag
      // (behind/ahead/dirty/detached — e.g. release PRs merged on the remote but
      // not pulled locally). Extract the tag's canonical tree so a stale working
      // tree can't silently ship an incomplete upgrade that still reports the
      // right version number (#471).
      const t = materialize(templateRepo, toVersion)
      cleanups.push(t.cleanup)
      theirsDir = t.dir
    }
  }

  // Base tree (merge base): explicit checkout > the instance version's tag.
  let baseDir: string
  let fromVersion: string
  if (options.baseDir) {
    baseDir = options.baseDir
    fromVersion = versionOfCheckout(baseDir, undefined)
  } else {
    if (instanceVersion === null) {
      throw new Error(
        `Cannot determine this instance's current core version (no biffo.core.json or ` +
          `core.version in ${options.cwd}). Pass --from-template to supply the merge base ` +
          `explicitly.`,
      )
    }
    fromVersion = instanceVersion
    const b = materialize(templateRepo, fromVersion)
    cleanups.push(b.cleanup)
    baseDir = b.dir
  }

  const manifest = readCoreManifest(theirsDir)

  const plan = await planCoreUpgrade({
    baseDir,
    oursDir: options.cwd,
    theirsDir,
    manifest,
  })

  // #1026: computed before anything else can short-circuit (e.g. "nothing to
  // upgrade" below), so a regression here is reported and enforced on every
  // invocation, not just the ones that also carry a template-owned change.
  const orphanRatchet = checkOrphanRatchet(plan.orphaned.length, readOrphanBaseline(options.cwd))

  // #1188: same reasoning as the orphan ratchet above — computed and printed
  // before anything can short-circuit, so a new undeclared seam is visible on
  // every run (dry run included), not only the ones that also change something
  // else. See instance-seams.ts for why "new relative to base" and "derived
  // from tsconfig.json" are both load-bearing.
  const newSeams = findNewUndeclaredSeams(baseDir, theirsDir, options.cwd)

  // #1538/#1570: same "before anything can short-circuit" reasoning as the two
  // checks above — an adoption gap that already exists must be visible on
  // every run, not only the run that happens to also touch something else.
  // `theirsDir` is the upgrade TARGET (does it ship the channel?), `options.cwd`
  // is this instance's own tree (has it consumed it?). See instance-adoption.ts
  // for why this lives here rather than as a shipped .test.ts.
  const adoption = checkInstanceAdoption(theirsDir, options.cwd)

  // Core migrations are carried separately from the merge (issue #198): the
  // versions/ directory is user-owned and must never be merged, but new core
  // migrations still have to reach the instance or a table-adding core feature
  // arrives with no schema. Planned here — ahead of its own output further
  // down — because the target-fidelity check right below needs its entries:
  // this carry reads the same theirsDir the merge plan does, and is a second,
  // separate way #1399-shaped content reaches an instance (see that module's
  // docstring). A broken/ambiguous instance chain also aborts loudly here,
  // before anything is printed, rather than producing a half-described plan.
  const migrations = planMigrationCarry({
    templateDir: theirsDir,
    instanceDir: options.cwd,
    declined: readDeclinedMigrations(options.cwd),
  })

  // #1399: hold the plan to the tag it claims to be. Same "before anything can
  // short-circuit" reasoning as the two above, and for the strongest version of
  // it — a dry run is where an operator decides whether to trust the upgrade, so
  // the verdict has to be on that screen, not only on `--apply`. Reads the tag
  // object independently of the tree the planner walked; see the module
  // docstring for why that independence is the whole mechanism. Covers the
  // migration carry too (migrations.entries), not only the merge plan.
  const fidelity = assertTargetFidelity({
    entries: plan.entries,
    migrations: migrations.entries,
    templateRepo,
    toVersion,
    theirsDir,
    explicitTargetTree: options.theirsDir !== undefined,
  })

  const heading = options.apply ? 'Biffo core upgrade' : 'Biffo core upgrade (dry run)'
  console.log(chalk.bold(`\n  ${heading}\n`))
  console.log(`  instance core:   ${instanceVersion ?? chalk.dim('(unrecorded)')}`)
  console.log(`  merge base:      ${fromVersion}`)
  console.log(`  target:          ${toVersion}\n`)

  printTargetFidelity(fidelity, toVersion)
  if (fidelity.findings.length > 0) {
    throw new Error(fidelityFailure(fidelity, toVersion))
  }

  printNewInstanceSeams(newSeams)
  printAdoptionReport(adoption)
  printOrphanReport(plan.orphaned, orphanRatchet)
  if (orphanRatchet.increased) {
    throw new Error(
      `${String(plan.orphaned.length)} unsanctioned instance file(s) under a template-owned ` +
        `path (baseline ${String(orphanRatchet.baseline)}) — see the list above (#1026). Move ` +
        'new instance-written files under a sanctioned carve-out ' +
        '(services/api/tests/instance/, modules/**/instance/) or otherwise reduce the count, ' +
        'then re-run.',
    )
  }

  // An instance may still carry an orphaned `core.version` file inherited before
  // #423 retired it from the template. Nothing reads it as an authority, so an
  // upgrade can clean it up — but only when it is provably the un-repurposed
  // inherited value (issue #434). This is a user-owned path, so the decision and
  // any deletion are surfaced, never silent. It rides along with a real upgrade
  // rather than opening a PR of its own.
  const coreVersionCleanup = planCoreVersionCleanup(options.cwd)

  if (plan.changes.length === 0 && migrations.entries.length === 0) {
    log.success('Nothing to upgrade — the instance already matches the target for all core files.')
    return
  }

  // Before the plan, not after: the plan is long, and a warning below it is a
  // warning nobody reads (#407).
  const breaking = breakingChangesBetween(
    fromVersion,
    toVersion,
    // From the TEMPLATE at the target version, never the instance's own copy —
    // docs/ is user-owned, so an instance's guide may be stale or edited.
    readBreakingChanges(theirsDir),
  )
  printBreakingChanges(breaking, options.apply === true)

  printPlan(plan)
  printMigrationCarry(migrations)
  printMigrationBodyDrift(
    migrations,
    findMigrationTestPairings(plan.changes, migrations.divergedBodies),
  )
  printCoreVersionCleanup(coreVersionCleanup, options.apply === true)
  warnStaleFirstPartyCopies(options.cwd)
  console.log(
    `\n  ${chalk.bold(String(plan.changes.length))} change(s), ` +
      `${chalk.bold(String(migrations.entries.length))} new core migration(s), ` +
      `${plan.conflicts.length > 0 ? chalk.red(`${plan.conflicts.length} conflict(s)`) : chalk.green('0 conflicts')}.`,
  )
  if (plan.divergenceSkips && plan.divergenceSkips.length > 0) {
    console.log(
      chalk.dim(
        `  ${plan.divergenceSkips.length} deleted template-owned file(s) left absent — declared divergent in biffo.divergence.json.`,
      ),
    )
  }

  if (!options.apply) {
    if (plan.conflicts.length > 0) {
      log.warn('Some core files changed on both sides and need manual resolution.')
    }
    console.log(
      chalk.dim('\n  Dry run — nothing written. Re-run with --apply to open an upgrade PR.\n'),
    )
    return
  }

  await applyAndOpenPr(
    options,
    deps,
    plan,
    migrations,
    fromVersion,
    toVersion,
    breaking,
    theirsDir,
    coreVersionCleanup,
    orphanRatchet,
    newSeams,
    adoption,
  )
}

async function applyAndOpenPr(
  options: CoreUpgradeOptions,
  deps: CoreUpgradeDeps,
  plan: UpgradePlan,
  migrations: MigrationCarryPlan,
  fromVersion: string,
  toVersion: string,
  breaking: BreakingChange[],
  /** Upstream tree the plan was built from — read for file modes on write. */
  theirsDir: string,
  /** Orphaned `core.version` cleanup decision, if the instance has one (#434). */
  coreVersionCleanup: CoreVersionCleanup | null,
  /** #1026 orphan ratchet outcome — carried through so a first-ever baseline
   * can be recorded alongside the rest of this upgrade's writes. */
  orphanRatchet: OrphanRatchet,
  /** #1188 — new `@/instance-*` seams this upgrade introduces with no
   * instance declaration yet. Warned, never failed on — see
   * `printNewInstanceSeams`'s docstring for why. */
  newSeams: InstanceSeam[],
  /** #1538/#1570 — registered adoption pairs this instance has not consumed.
   * Warned, never failed on, for the same reason as `newSeams`: `core upgrade`
   * cannot write the user-owned fix itself, so blocking every future
   * template-owned upgrade on an unrelated infra gap would hold security
   * patches hostage to it. See `printAdoptionReport`'s docstring. */
  adoption: AdoptionReport,
): Promise<void> {
  if (breaking.length > 0 && !options.acknowledgeBreaking) {
    throw new Error(
      `This upgrade crosses ${breaking.length} documented breaking change(s): ` +
        `${breaking.map((b) => b.version).join(', ')}. They are printed above and in ` +
        `${UPGRADE_GUIDE_PATH}. Read what each one requires — some destroy data or need ` +
        `manual work after the deploy — then re-run with --acknowledge-breaking.`,
    )
  }

  if (plan.conflicts.length > 0 && !options.allowConflicts) {
    throw new Error(
      `${plan.conflicts.length} file(s) conflict. Resolve them upstream, or re-run with ` +
        '--allow-conflicts to open a PR that includes the conflict markers for manual resolution.',
    )
  }

  const { git } = deps
  const token = deps.resolveToken()

  if (!(await git.isGitRepo(options.cwd))) {
    throw new Error(`${options.cwd} is not a git repository.`)
  }

  const branch = upgradeBranchName(fromVersion, toVersion)

  // Where the caller's HEAD was, so it can be put back (#984). `createBranch`
  // switches the checkout it was pointed at, and this used to be a one-way trip:
  // the repo was left parked on the upgrade branch whether the run succeeded or
  // threw. AGENTS.md §2 forbids exactly that, and it is worse than untidy — other
  // agents commonly work the same repo through worktrees, so anything that reads
  // the primary afterwards (a `git grep`, an audit, another tool's `--cwd .`)
  // silently reads the upgrade tree instead of the integration branch.
  //
  // Putting HEAD back is not unconditionally safe, though (#1137): see
  // `restoreCallerBranch`'s docstring for why it refuses to switch at all while
  // the working tree is dirty, rather than trusting `switchBranch`'s own
  // git-level protection to make every restore harmless.
  //
  // Read here rather than reusing the currency check's value so it is the branch
  // as it stands immediately before HEAD moves, not as it stood before planning.
  const callerBranch = await git.currentBranch(options.cwd)

  log.step(1, 4, `Creating branch ${branch}`)
  await git.createBranch(options.cwd, branch)

  // Everything past this point runs with HEAD moved, so it all belongs to the
  // `finally` below — including the steps that fail in practice (push, PR).
  try {
    await buildCommitAndOpenPr(
      options,
      deps,
      plan,
      migrations,
      fromVersion,
      toVersion,
      breaking,
      theirsDir,
      coreVersionCleanup,
      orphanRatchet,
      newSeams,
      adoption,
      branch,
      token,
    )
  } finally {
    await restoreCallerBranch(git, options.cwd, callerBranch, branch)
  }
}

/**
 * Put HEAD back where the caller left it, best-effort (#984) — but only when
 * doing so cannot silently relocate unfinished work onto the caller's branch
 * (#1137).
 *
 * Never throws. It runs in a `finally`, so throwing would replace whatever real
 * error the upgrade hit — a failed push reported as a failed checkout — and the
 * upgrade's actual outcome (branch pushed, PR opened) is not undone by HEAD
 * being in the wrong place. A warning naming both branches is the honest report:
 * the caller can finish the restore with one command.
 *
 * ## Why this checks for uncommitted changes first (#1137)
 *
 * `switchBranch`'s own git-level safety only refuses a switch that would
 * **discard** a change — i.e. one that conflicts with content the target
 * branch already has. That protects against data loss, but it is not the same
 * property as "this checkout is safe to hand back to the caller": the upgrade
 * branch is freshly created FROM `callerBranch`, so until a commit lands on it
 * the two branches' tips are bit-identical. Nothing conflicts with an
 * identical tree, so `git switch` succeeds trivially and silently carries
 * whatever is staged or modified — a conflicted, `--allow-conflicts` merge
 * included — onto `callerBranch`. That is precisely `applyUpgradePlan` +
 * `git add -A` running, then `git commit` failing (most commonly the
 * ownership guard correctly refusing a conflict-marked commit): the files are
 * written and staged before the commit is attempted, so a refused commit
 * leaves them sitting in the working tree with nothing to distinguish them,
 * to git, from ordinary uncommitted edits made directly on `callerBranch`.
 * AGENTS.md §2 forbids a direct commit landing on the integration branch, and
 * this would leave the caller one ordinary `git commit` away from exactly
 * that — worse than merely leaving HEAD parked on the upgrade branch, which is
 * only untidy.
 *
 * So: refuse to switch at all while the working tree is dirty. Leaving HEAD on
 * the upgrade branch is always safe — the dirty state stays attributed to the
 * branch that actually produced it — and the warning says so explicitly rather
 * than guessing whether the caller wanted those changes kept or discarded.
 */
async function restoreCallerBranch(
  git: CoreUpgradeGit,
  cwd: string,
  callerBranch: string,
  upgradeBranch: string,
): Promise<void> {
  // A detached HEAD has no branch name to switch back to. Unreachable today —
  // `checkInstanceCurrency` refuses one before any planning happens — so this is
  // a guard against that check moving, not a live path.
  if (callerBranch === 'HEAD' || callerBranch === '') {
    log.warn(
      `Left ${cwd} on ${upgradeBranch}: HEAD was detached on entry, so there is no branch to ` +
        'restore (#984).',
    )
    return
  }

  // #1137: check before switching, not after. See the docstring above for why
  // an uncommitted change here is unsafe to carry across even though
  // `switchBranch` itself would not refuse it.
  let dirty: boolean
  try {
    dirty = await git.hasUncommittedChanges(cwd)
  } catch {
    // Cannot tell — fail closed the same way a genuine "yes" does, rather than
    // switching on the optimistic assumption that a failed check meant clean.
    dirty = true
  }
  if (dirty) {
    log.warn(
      `Left ${cwd} on ${upgradeBranch}: it has uncommitted changes from this run, and switching ` +
        `back to ${callerBranch} would silently carry them onto it rather than losing them — which ` +
        `is worse (#1137). Resolve them on ${upgradeBranch} first: commit them there, or discard the ` +
        `failed attempt with \`git reset --hard\` / \`git clean -fd\`, THEN ` +
        `\`git switch ${callerBranch}\`.`,
    )
    return
  }

  try {
    await git.switchBranch(cwd, callerBranch)
  } catch {
    log.warn(
      `Could not switch ${cwd} back to ${callerBranch} — it is still on ${upgradeBranch}. ` +
        `Restore it with \`git switch ${callerBranch}\` (#984).`,
    )
  }
}

/**
 * Apply, commit, push and open the PR — the whole of the upgrade that runs while
 * HEAD is on the upgrade branch. Split out purely so its caller can wrap it in
 * the `finally` that restores the caller's branch (#984).
 */
async function buildCommitAndOpenPr(
  options: CoreUpgradeOptions,
  deps: CoreUpgradeDeps,
  plan: UpgradePlan,
  migrations: MigrationCarryPlan,
  fromVersion: string,
  toVersion: string,
  breaking: BreakingChange[],
  theirsDir: string,
  coreVersionCleanup: CoreVersionCleanup | null,
  orphanRatchet: OrphanRatchet,
  /** #1188 — carried through to the PR body. */
  newSeams: InstanceSeam[],
  /** #1538/#1570 — carried through to the PR body. */
  adoption: AdoptionReport,
  branch: string,
  /** Resolved by the caller, before the branch exists, so a missing token fails
   * the run without having moved HEAD first. */
  token: string,
): Promise<void> {
  const { git } = deps

  const applied = applyUpgradePlan(options.cwd, plan, theirsDir)
  const carried = applyMigrationCarry(options.cwd, migrations)
  writeInstanceCoreVersion(options.cwd, toVersion)

  // #1026: the FIRST upgrade this instance runs after the ratchet exists has
  // no baseline yet — record the live count now rather than leaving the
  // instance permanently unable to fail (`checkOrphanRatchet` treats a
  // missing baseline as "establish, don't fail" every single time, not just
  // once). Staged by the `git add -A` below, so it lands in this same PR —
  // the same convention `writeInstanceCoreVersion` above already follows.
  const establishedOrphanBaseline = orphanRatchet.baseline === null
  if (establishedOrphanBaseline) {
    writeOrphanBaseline(options.cwd, orphanRatchet.count)
    log.info(
      `Recorded ${ORPHAN_BASELINE_FILE} with a baseline of ${String(orphanRatchet.count)} ` +
        'unsanctioned instance file(s) under template-owned paths. Future upgrades fail only ' +
        'if this count increases (#1026).',
    )
  }

  // Remove the core.version file when it is provably inherited (#434) or provably
  // stale (#842). Staged by the `git add -A` below and surfaced in the PR body. A
  // repurposed or unauthoritative file is still left alone.
  const cleanedCoreVersion = coreVersionCleanup?.action === 'delete'
  if (cleanedCoreVersion && existsSync(coreVersionCleanup.path)) {
    rmSync(coreVersionCleanup.path)
    log.info(
      coreVersionCleanup.stale
        ? `Deleted stale ${CORE_VERSION_FILE} (recorded ${coreVersionCleanup.found}, behind the ` +
            `version biffo.core.json records — this instance has moved past it) (#842).`
        : `Deleted orphaned ${CORE_VERSION_FILE} (inherited copy recording ${coreVersionCleanup.found}, ` +
            `superseded by biffo.core.json) — nothing reads it as an authority (#434).`,
    )
  }

  log.step(
    2,
    4,
    `Applied ${applied.written.length} change(s), ` +
      `${applied.deleted.length + (cleanedCoreVersion ? 1 : 0)} deletion(s), ` +
      `${carried.length} new migration(s)`,
  )

  // Before `git add`, so regenerated lockfiles land in the same commit as the
  // manifests that invalidated them (#393). package.json/pyproject.toml are
  // template-owned and the upgrade rewrites them; the lockfiles are user-owned
  // so it cannot carry them, and the two disagreeing fails
  // `pnpm install --frozen-lockfile` outright in the instance's CI.
  const lockfiles = await refreshInstanceLockfiles(options.cwd, applied, deps)

  // Read once and reused for both the commit message and the PR body (#1011):
  // the commit is made here, before the push step that can fail and abort the
  // PR-opening step below, so it is the one place this marker is guaranteed to
  // land.
  const carriedPrs = readCarriedPrs(options.templateRepo, fromVersion, toVersion)

  await git.add(options.cwd, ['-A'])
  await git.commit(options.cwd, buildCommitMessage(fromVersion, toVersion, carriedPrs))

  // Install dependencies before pushing (#1040). `.husky/pre-push` runs
  // `scripts/verify.sh`, which cannot run against a tree with no `node_modules`
  // — this used to go straight from the commit above to the push below, so git
  // rejected the push at [3/4] on every worktree AGENTS.md §1 tells a caller to
  // run this in, and [4/4] (opening the PR) never ran. This is what a human
  // does by hand between the two steps. Same `run` fn and injection point as
  // `refreshInstanceLockfiles`, so it is testable without a real pnpm/uv on the
  // machine; failure here is soft (warned, not thrown — see
  // `installInstanceDependencies`'s docstring) because the push below still
  // runs and reports its own failure honestly either way.
  const run: RunCommandFn = deps.runCommand ?? defaultRunCommand
  const installOutcomes = await installInstanceDependencies(options.cwd, run)
  const installFailures = describeInstallFailures(installOutcomes)
  for (const message of installFailures) log.warn(message)

  log.step(3, 4, `Pushing ${branch}`)
  const pushOpts: { remote?: string; token: string } = { token }
  if (options.remote) pushOpts.remote = options.remote
  try {
    await git.push(options.cwd, branch, pushOpts)
  } catch (err) {
    // #1040: the push is the step most likely to fail — a pre-push gate
    // correctly rejecting a tree it cannot verify — and it aborts before
    // step [4/4], the PR-open call that is the marker's only OTHER home. The
    // marker is already inside the commit message above (#1011), which
    // survives this failure, but a human finishing by hand pastes a PR BODY,
    // not a commit message, and has no reason to go looking in `git log` for
    // it. Print it explicitly here so it is not lost twice.
    const marker = carriedPrsSection(carriedPrs).join('\n').trim()
    log.error(
      `Push failed: ${(err as Error).message}\n\n` +
        `The branch ${branch} is committed locally. Push it and open the PR by hand — and ` +
        (marker.length > 0
          ? `include this in the PR body so #767's time-to-feature metric can join on it:\n\n${marker}`
          : 'this upgrade carries no template PRs, so no provenance marker is needed.'),
    )
    throw err
  }

  log.step(4, 4, 'Opening pull request')
  const remoteUrl = await git.getRemoteUrl(options.cwd, options.remote)
  const { owner, repo } = parseGitHubRepo(remoteUrl)
  const github = deps.makeGitHub(token)

  // The integration branch, asked of GitHub rather than assumed. It differs per
  // repo — the template uses `main`, instances use `dev` — so a literal would be
  // wrong for half of them.
  //
  // This used to default to the CURRENT branch, which is wrong in exactly the
  // situation AGENTS.md mandates: run from a worktree on its own branch, the
  // upgrade opened its PR against a local branch that was never pushed, and
  // GitHub rejected it with `field: base, code: invalid` after having already
  // created, committed and pushed the upgrade branch. The work was fine; only
  // the last step failed, which is a confusing place to fail.
  const base = options.base ?? (await github.defaultBranch({ owner, repo }))

  const pr = await github.createPullRequest({
    owner,
    repo,
    head: branch,
    base,
    title: `Upgrade Biffo core ${fromVersion} → ${toVersion}`,
    body: buildPrBody(
      fromVersion,
      toVersion,
      plan,
      migrations,
      base,
      lockfiles,
      breaking,
      cleanedCoreVersion ? coreVersionCleanup : null,
      carriedPrs,
      newSeams,
      installFailures,
      adoption.findings,
    ),
  })

  if (plan.conflicts.length > 0) {
    log.warn(`PR opened with ${plan.conflicts.length} conflict(s) to resolve: ${pr.url}`)
  } else {
    log.success(`Opened PR #${pr.number}: ${pr.url}`)
  }
}

/** Marker delimiting the machine-readable carried-PR list (#767). */
export const CARRIED_PRS_MARKER = 'biffo:carries-template-prs:'

/**
 * Squash subjects between two core tags, as PR numbers. Best-effort by design.
 *
 * Never throws: a shallow clone, a missing tag, or no template checkout at all
 * yields `[]`. Provenance for a metric must not be able to fail an upgrade that
 * is otherwise correct — and an empty list is honest ("this upgrade recorded
 * nothing") rather than wrong.
 */
function readCarriedPrs(templateRepo: string | undefined, from: string, to: string): number[] {
  if (!templateRepo) return []
  try {
    const out = execSync(`git log --format=%s core-v${from}..core-v${to}`, {
      cwd: templateRepo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return carriedPrNumbers(out.split('\n'))
  } catch {
    return []
  }
}

/**
 * The template PRs this upgrade carries, in a form a tool can read.
 *
 * ## Why this exists
 *
 * Time-to-feature (#767) measures issue opened → merged → *running*. For an
 * instance's own issue both stops are local. For a **template** issue the
 * feature is not running when the template PR merges — it is running when an
 * instance deploys it, five hops later (tag → npm publish → `core upgrade` →
 * instance PR → deploy). That gap is the distribution cost the practices page
 * has only ever been able to describe anecdotally, and it could not be measured
 * because **nothing recorded which issues an upgrade carried**. The upgrade PR
 * named versions; versions are not traceable to issues.
 *
 * One line of provenance closes that. The collector already knows each template
 * PR's closing issues (`closingIssuesReferences`), so carrying the PR *numbers*
 * is enough — no issue lookup is duplicated here, and the list stays correct if
 * an issue link is added after the fact.
 *
 * Rendered inside an HTML comment: it is provenance for tooling, not something
 * a reviewer needs to read past on every upgrade.
 */
/**
 * commitlint's `body-max-line-length` / `footer-max-line-length`, from
 * `@commitlint/config-conventional`. The marker goes into a COMMIT MESSAGE as
 * well as a PR body (#1011), so it is bound by this.
 */
const COMMIT_BODY_MAX_LINE = 100

export function carriedPrsSection(carriedPrs: number[]): string[] {
  if (carriedPrs.length === 0) return []
  const unique = [...new Set(carriedPrs)].sort((a, b) => a - b)

  // One line for a short list — the overwhelmingly common case, and the form
  // every existing upgrade PR already carries.
  const single = `<!-- ${CARRIED_PRS_MARKER}${unique.join(',')} -->`
  if (single.length <= COMMIT_BODY_MAX_LINE) return ['', single]

  // Wrapped, because a long list otherwise makes the commit unmakeable (#1198).
  // `--apply` could not commit at all against biffo-platform: 99 carried PRs is
  // a ~1000-character line and commitlint rejects it, so the mechanism that
  // exists to preserve provenance destroyed the commit that carries it —
  // failing hardest on exactly the upgrades with the most provenance to record.
  //
  // The numbers are split across lines INSIDE the comment. `parseCarriedPrs`
  // in scripts/practices-metrics.mjs tolerates whitespace between them; the two
  // must change together, and `carried-prs-marker.test.ts` round-trips this
  // output through that parser so a silent truncation cannot ship.
  const lines: string[] = [`<!-- ${CARRIED_PRS_MARKER}`]
  let current = ''
  for (const n of unique) {
    const token = `${n},`
    if (current.length + token.length > COMMIT_BODY_MAX_LINE) {
      lines.push(current)
      current = ''
    }
    current += token
  }
  // Drop the trailing comma from the final chunk, then close the comment. The
  // closer gets its own line so it can never push a number line over the limit.
  lines.push(current.replace(/,$/, ''))
  lines.push('-->')
  return ['', ...lines]
}

/**
 * The upgrade commit's message, marker included (#1011).
 *
 * `--apply` can complete this commit and then fail at the push step — a
 * misconfigured remote, an SSH identity with no write access — which aborts
 * the run before the PR-opening step that used to be the marker's only home.
 * The operator then pushes and opens the PR by hand, and a hand-made PR is
 * correct in every visible respect except this one invisible thing: no PR
 * body, no marker, and `scripts/practices-metrics.mjs` can no longer join the
 * upgrade to the template PRs it carried.
 *
 * The commit itself is made before that push, so writing the same marker into
 * its message survives exactly the failure that loses the PR body. The
 * collector reads the marker from either place (#1011); this is the one a
 * hand-created PR still carries.
 */
export function buildCommitMessage(from: string, to: string, carriedPrs: number[]): string {
  const subject = `chore(core): upgrade template core ${from} -> ${to}`
  const marker = carriedPrsSection(carriedPrs)
  return marker.length === 0 ? subject : [subject, ...marker].join('\n')
}

/**
 * Template PR numbers merged between two core versions.
 *
 * Reads the squash-merge subjects between the two `core-v*` tags. Every merge to
 * the template's integration branch is a squash whose subject ends `(#N)`, so
 * the numbers are already in the history and need no API call.
 *
 * Returns `[]` rather than throwing when the tags are unavailable — a shallow
 * clone or a missing tag must not fail an upgrade that is otherwise correct.
 * An empty list simply means this upgrade contributes nothing to #767, which is
 * the honest outcome when the history cannot be read.
 */
export function carriedPrNumbers(subjects: string[]): number[] {
  const numbers: number[] = []
  for (const subject of subjects) {
    const match = /\(#(\d+)\)\s*$/.exec(subject)
    if (match?.[1]) numbers.push(Number(match[1]))
  }
  return [...new Set(numbers)].sort((a, b) => a - b)
}

export function buildPrBody(
  from: string,
  to: string,
  plan: UpgradePlan,
  migrations: MigrationCarryPlan,
  base = GLOBAL_DISPATCH_REF,
  lockfiles: LockfileRefreshOutcome[] = [],
  breaking: BreakingChange[] = [],
  /** Orphaned core.version cleanup that this upgrade performed, if any (#434). */
  coreVersionCleanup: CoreVersionCleanup | null = null,
  /** Template PR numbers this upgrade carries, for time-to-feature (#767). */
  carriedPrs: number[] = [],
  /** New `@/instance-*` seams this upgrade introduces with no instance
   * declaration yet (#1188). */
  newSeams: InstanceSeam[] = [],
  /** `describeInstallFailures` output, if `pnpm install` / `uv sync` could not
   * run on the machine that ran the upgrade (#1040). */
  installFailures: string[] = [],
  /** Registered adoption-pair findings this upgrade's target ships but this
   * instance has not consumed (#1538/#1570). */
  adoptionFindings: AdoptionFinding[] = [],
): string {
  const lines: string[] = []
  if (breaking.length > 0) {
    // First thing in the body, above everything. A warning below a 60-line
    // change list is a warning nobody scrolls to (#407).
    lines.push(
      `## ⚠ This upgrade crosses ${breaking.length} breaking change(s)`,
      '',
      'Read these before merging — some destroy data or require manual work afterwards.',
      '',
      ...breaking.flatMap((b) => [`### ${b.version} — ${b.title}`, '', b.body, '']),
      '---',
      '',
    )
  }
  if (newSeams.length > 0) {
    // Same placement reasoning as breaking changes above (#407): this is a
    // "read before merging" item, not a footnote after a long change list.
    lines.push(
      `## ⚠ ${newSeams.length} new instance seam(s) — no declaration yet (#1188)`,
      '',
      'This upgrade introduces a new optional `@/instance-*` module the portal can ' +
        'resolve to an instance-owned override. **This instance has not declared one**, so ' +
        'until it does, it silently gets the template-owned generic default listed below — ' +
        'not necessarily the behaviour this instance actually wants.',
      '',
      ...newSeams.flatMap((s) => [
        `### \`${s.specifier}\``,
        '',
        `- Add \`${s.instanceFile}\` to declare this instance's own behaviour.`,
        `- Until then, this instance uses the template default: \`${s.defaultFile}\`.`,
        '',
      ]),
      'The contract this module implements is part of THIS upgrade, so it does not exist yet ' +
        'anywhere the instance could have written the file in advance — add it as a follow-up ' +
        'commit on this PR, before merging, once the files above have landed on this branch.',
      '',
      '---',
      '',
    )
  }
  const unadopted = adoptionFindings.filter((f) => f.status === 'unadopted')
  if (unadopted.length > 0) {
    // Same placement reasoning as the two sections above (#407): this instance
    // already has the file this upgrade (or an earlier one) shipped, and the
    // capability it's meant to complete has been silently dead since — that
    // belongs above a long change list, not after it.
    lines.push(
      `## ⚠ ${unadopted.length} instance adoption gap(s) — shipped but not consumed (#1538/#1570)`,
      '',
      'The template-owned file(s) below already exist in this instance, but the ' +
        '**user-owned** file that must read them has not been edited to do so. The mechanism ' +
        'ships, CI is green, and it does nothing at runtime — `biffo core upgrade` cannot fix ' +
        'this itself (the file it would need to edit is user-owned), so it is surfaced here on ' +
        'every upgrade until it is adopted by hand.',
      '',
      ...unadopted.flatMap((f) => [
        `### \`${f.pair.id}\``,
        '',
        f.pair.description,
        '',
        `- Template-owned: \`${f.pair.templateFile}\` (already present in this instance)`,
        `- Needs editing: \`${f.pair.userFile}\``,
        `- Fix: ${f.pair.remedy}`,
        '',
      ]),
      '---',
      '',
    )
  }
  lines.push(
    'Automated core upgrade generated by `biffo core upgrade` (ADR-0006).',
    '',
    `Bumps the Biffo template core from **${from}** to **${to}** and updates \`biffo.core.json\`. Only template-owned paths (see \`core-manifest.json\`) were touched — product, plugin, and infra files were left untouched.`,
    ...carriedPrsSection(carriedPrs),
    '',
    `## Changes (${plan.changes.length})`,
    '',
    `- merged: ${plan.summary.merged}`,
    `- take-theirs: ${plan.summary['take-theirs']}`,
    `- added: ${plan.summary.added}`,
    `- restored: ${plan.summary.restored}`,
    `- removed: ${plan.summary.removed}`,
  )
  if (plan.divergenceSkips && plan.divergenceSkips.length > 0) {
    lines.push(
      '',
      `> ${plan.divergenceSkips.length} template-owned file(s) the instance deleted were left absent ` +
        `because \`biffo.divergence.json\` declares the path an intentional divergence (not restored).`,
    )
  }
  if (migrations.entries.length > 0) {
    lines.push(
      '',
      `## Core migrations (${migrations.entries.length})`,
      '',
      "New core Alembic migrations were **appended** to this repo's chain. Existing migrations were not modified — each new one was re-chained onto this instance's head (`" +
        `${migrations.instanceHead ?? '(empty chain)'}` +
        '`) at upgrade time, and the resulting chain was validated for a single head before this PR was opened.',
      '',
      ...migrations.entries.map(
        (e) =>
          `- \`${e.path}\` — revision \`${e.revision}\`${
            e.reissuedFrom
              ? ` (re-issued from \`${e.reissuedFrom}\`, which this repo already uses)`
              : ''
          }, revises \`${e.downRevision ?? '(base)'}\``,
      ),
      '',
      'Review the DDL before merging: merging this PR runs these migrations against the database on the next deploy.',
    )
  }
  if (coreVersionCleanup && coreVersionCleanup.action === 'delete') {
    lines.push(
      '',
      '## Cleanup — removed orphaned `core.version`',
      '',
      `This instance still carried a \`${CORE_VERSION_FILE}\` file (recording ` +
        `\`${coreVersionCleanup.found}\`), inherited through GitHub template generation before ` +
        `the template retired it (#423). It matched the version \`biffo.core.json\` records, so ` +
        `it was the un-repurposed inherited copy, and nothing reads it as an authority — ` +
        `\`biffo.core.json\` wins every lookup. This upgrade **deleted it** (#434). The fallback ` +
        `readers in \`deploy.ts\` and \`core-upgrade.ts\` still read \`${CORE_VERSION_FILE}\` when ` +
        `it is present elsewhere; only this orphaned instance copy was removed.`,
    )
  }
  // Issue #328: some template workflows are dispatched by `biffo deploy` from a
  // FIXED branch (GLOBAL_DISPATCH_REF, i.e. `dev` since #559) regardless of
  // environment. Since every repo's default branch is now also `dev`, a core
  // upgrade PR lands on the same branch it dispatches from, so this note does
  // not fire in the unified model — it remains only for the case where a PR
  // targets some other branch (e.g. a leftover `staging`), leaving the fix
  // unreachable by the deploy until a promotion. Surfaced here so that gap is
  // never silent.
  const globalWorkflowChanges = plan.changes.filter((c) =>
    GLOBAL_DISPATCH_WORKFLOW_PATHS.includes(c.path),
  )
  if (base !== GLOBAL_DISPATCH_REF && globalWorkflowChanges.length > 0) {
    lines.push(
      '',
      `## ⚠ Promotion required — global workflow change (issue #328)`,
      '',
      `This upgrade changes ${globalWorkflowChanges.length} workflow(s) that \`biffo deploy\` ` +
        `dispatches from \`${GLOBAL_DISPATCH_REF}\`, but this PR targets \`${base}\`:`,
      '',
      ...globalWorkflowChanges.map((c) => `- \`${c.path}\``),
      '',
      `Merging here lands the fix on \`${base}\` — **but the deploy runs it from ` +
        `\`${GLOBAL_DISPATCH_REF}\`.** Until you promote \`${base}\` → \`${GLOBAL_DISPATCH_REF}\` ` +
        `(open a PR from \`${base}\` into \`${GLOBAL_DISPATCH_REF}\` and merge it), the old workflow ` +
        `keeps running and this fix will not take effect.`,
    )
  }
  const lockfileFailures = describeFailures(lockfiles)
  if (lockfileFailures.length > 0) {
    lines.push(
      '',
      '## ⚠ Lockfiles could not be refreshed',
      '',
      'This upgrade changed a dependency manifest, but the matching lockfile could not be ' +
        'regenerated on the machine that ran the upgrade. **CI will fail on the mismatch** ' +
        'until this is done by hand:',
      '',
      ...lockfileFailures.map((f) => `- ${f}`),
    )
  } else if (lockfiles.length > 0) {
    lines.push(
      '',
      `## Lockfiles refreshed (${lockfiles.length})`,
      '',
      'This upgrade changed a dependency manifest. The manifests are template-owned and the ' +
        'lockfiles are not, so the lockfiles were regenerated **in this repo** — against its own ' +
        'registry config — and committed alongside, rather than left disagreeing:',
      '',
      ...lockfiles.map((o) => `- \`${o.trigger.lockfile}\` (\`${o.trigger.command.join(' ')}\`)`),
    )
  }
  if (installFailures.length > 0) {
    lines.push(
      '',
      '## ⚠ Dependency install failed',
      '',
      '`pnpm install` (and `uv sync`, where this instance has Python) could not run on the ' +
        'machine that opened this PR, so it may not have been possible to verify this tree ' +
        'before pushing it (#1040):',
      '',
      ...installFailures.map((f) => `- ${f}`),
    )
  }
  if (plan.conflicts.length > 0) {
    lines.push(
      '',
      `## ⚠ Conflicts (${plan.conflicts.length}) — resolve before merging`,
      '',
      'These files changed on both sides and were committed **with conflict markers**:',
      '',
      ...plan.conflicts.map((c) => `- \`${c.path}\` (${c.status})`),
    )
  }
  return lines.join('\n')
}

const STATUS_COLOR: Record<string, (s: string) => string> = {
  conflict: chalk.red,
  'add-conflict': chalk.red,
  'remove-conflict': chalk.red,
  merged: chalk.yellow,
  'take-theirs': chalk.green,
  added: chalk.green,
  restored: chalk.green,
  removed: chalk.red,
  'keep-ours': chalk.dim,
}

function printMigrationCarry(migrations: MigrationCarryPlan): void {
  // Surfaced, not silent: a migration recognised by anything other than its
  // filename means this instance renamed or renumbered a carried copy. That is
  // the case filename matching alone used to get wrong, by re-issuing an
  // already-applied migration against a live database (#366). Seeing it here is
  // how an operator learns their instance is in that shape.
  for (const r of migrations.recognised) {
    console.log(
      `  ${chalk.dim('already carried'.padEnd(15))} ${r.file} ` +
        chalk.dim(`→ this instance calls it ${r.instanceFile} (matched by ${r.how})`),
    )
  }
  // A decline that applies invisibly is indistinguishable from a tool that
  // forgot the migration existed, so say so every time (#735).
  for (const d of migrations.declined) {
    const upstream = d.upstream ? chalk.dim(` [${d.upstream}]`) : ''
    console.log(
      `  ${chalk.yellow('declined'.padEnd(15))} ${d.file} ` +
        chalk.dim(`→ skipped per biffo.core.json: ${d.reason}`) +
        upstream,
    )
  }
  for (const f of migrations.staleDeclines) {
    console.log(
      `  ${chalk.yellow('stale decline'.padEnd(15))} ${f} ` +
        chalk.dim('→ declined in biffo.core.json, but the target template has no such migration.'),
    )
    console.log(
      chalk.dim(
        '                  Either the filename is wrong (declining nothing) or the decline\n' +
          '                  has outlived its cause and should be deleted.',
      ),
    )
  }
  for (const e of migrations.entries) {
    const suffix = e.reissuedFrom
      ? chalk.dim(
          ` (revision ${e.revision}, re-issued from ${e.reissuedFrom}; revises ${e.downRevision ?? 'base'})`,
        )
      : chalk.dim(` (revision ${e.revision}; revises ${e.downRevision ?? 'base'})`)
    console.log(`  ${chalk.green('migration'.padEnd(15))} ${e.path}${suffix}`)
  }
}

/**
 * #739. The carry declined to update an already-applied migration's body — right,
 * you cannot re-run one — while the merge engine happily brought in the test that
 * asserts the new body. Green upstream, red in every instance that already has
 * the migration, and nothing in the plan connected the two.
 *
 * Both facts were already known here. This says so, before the PR is opened.
 */
export function printMigrationBodyDrift(
  migrations: MigrationCarryPlan,
  pairings: MigrationTestPairing[],
): void {
  if (migrations.divergedBodies.length === 0) return

  console.log()
  for (const d of migrations.divergedBodies) {
    const alias =
      d.instanceFile === d.file ? '' : chalk.dim(` (this instance calls it ${d.instanceFile})`)
    console.log(
      `  ${chalk.yellow('body drift'.padEnd(15))} ${d.file}${alias}\n` +
        chalk.dim(
          '                  The template has changed this migration since you carried it.\n' +
            '                  An applied migration cannot be re-run, so the carry left yours\n' +
            '                  alone and this change will NOT reach you.',
        ),
    )
    // #751. The parser and the `declared` field shipped in #1205; this is the
    // operator-visible half. Reporting only — the carry still leaves the file
    // alone either way (see DivergedMigrationBody.declared's doc) — but a
    // declared classification rules out one of the two hand remedies in
    // docs/guides/core-upgrade.md's "Which of the three actually applies"
    // table. Struck out (for a terminal that renders it) AND labelled in
    // plain text — an operator piping this to a file, or on a terminal with
    // colour off, still needs to see which remedy the classification rules
    // out, not just the one a TTY would show crossed out.
    if (d.declared) {
      console.log(
        chalk.dim('                  declared: ') +
          chalk.cyan(d.declared.classification) +
          chalk.dim(` — ${d.declared.reason}`),
      )
      const handPortText = '- port the body change into your copy by hand'
      const followOnText = '- ask upstream for a follow-on migration'
      if (d.declared.classification === 'replay-safe') {
        // Already correct as-is (#670) — a follow-on migration cannot even be
        // reached by a fresh environment that dies inside the old body first.
        console.log(chalk.dim(`                    ${handPortText}`))
        console.log(
          chalk.strikethrough.dim(`                    ${followOnText}`) +
            chalk.dim(' (rules out — replay-safe means your database is already correct)'),
        )
      } else {
        // outcome-changing — restating unchanged-in-effect DDL against a
        // database that already has the wrong schema changes nothing; only a
        // follow-on migration converges it.
        console.log(
          chalk.strikethrough.dim(`                    ${handPortText}`) +
            chalk.dim(' (rules out — restating this body cannot fix an already-wrong schema)'),
        )
        console.log(chalk.dim(`                    ${followOnText}`))
      }
    }
  }

  if (pairings.length === 0) {
    console.log(
      chalk.dim(
        '\n  No arriving test asserts the new body, so this upgrade should still go green.\n' +
          '  It stays a convergence gap: fresh environments get the new body, you keep the old.',
      ),
    )
    return
  }

  // The red-PR case. Loud, because the failure it predicts otherwise surfaces as
  // an unexplained CI failure in a file the instance never wrote.
  console.log(
    `\n  ${chalk.red.bold('This upgrade will not go green.')} ` +
      `${pairings.length} arriving test(s) assert a migration body you will not receive:`,
  )
  for (const p of pairings) {
    console.log(`    ${chalk.red(p.testPath)} ${chalk.dim(`→ asserts ${p.migration}`)}`)
  }
  console.log(
    chalk.dim(
      '\n  Resolve before merging, by one of:\n' +
        '    - port the migration body change into your copy by hand, keeping its\n' +
        '      `# biffo:carried-from:` marker — safe only if re-stating the DDL is a\n' +
        '      no-op against your already-migrated database;\n' +
        '    - drop the arriving test from this PR and raise it upstream, if the\n' +
        '      property it asserts cannot hold here;\n' +
        '    - ask upstream to ship the change as a follow-on migration instead, which\n' +
        '      is the only option that actually converges an applied chain.\n',
    ),
  )
}

/**
 * Report the orphaned `core.version` decision (#434).
 *
 * A user-owned path is involved, so both the deletion and the reason for
 * declining one are visible rather than silent: a `delete` line so the operator
 * sees the file go, and a dim note when it is kept so they see *why* an inherited
 * file the docs mention was left in place (repurposed, or no authority to check).
 */
function printCoreVersionCleanup(cleanup: CoreVersionCleanup | null, applying: boolean): void {
  if (cleanup === null) return
  if (cleanup.action === 'delete') {
    const verb = applying ? 'delete' : 'will delete'
    // Name the evidence, not just the action (#842). "Equal to the authority" and
    // "behind the authority" are different arguments for the same irreversible
    // step, and a log that cannot distinguish them cannot be audited after the
    // fact — which is how #788's fossil went unquestioned for 114 versions.
    const why = cleanup.stale
      ? `stale: records ${cleanup.found}, which this instance has already moved past`
      : `orphaned inherited copy recording ${cleanup.found}`
    console.log(
      `  ${chalk.red('cleanup'.padEnd(15))} ${CORE_VERSION_FILE} ` +
        chalk.dim(`(${why}) — ${verb}`),
    )
    return
  }
  const why =
    cleanup.reason === 'repurposed'
      ? `does not match biffo.core.json — looks repurposed, keeping ${CORE_VERSION_FILE}`
      : `biffo.core.json absent or unparseable — no authority to check, keeping ${CORE_VERSION_FILE}`
  console.log(`  ${chalk.dim('cleanup'.padEnd(15))} ${chalk.dim(`${cleanup.found}: ${why}`)}`)
}

/**
 * Report #1188's new-undeclared-seam warning to the terminal. Printed on every
 * run, dry run included — same reasoning as `printOrphanReport` below: a
 * warning nobody sees before merge is one nobody acts on before merge.
 *
 * This is deliberately a warning, never a thrown error (contrast
 * `orphanRatchet.increased` below, which does throw): failing the upgrade here
 * would deadlock it. The instance file this warns about cannot compile until
 * the contract this same upgrade carries has landed, so there is no way to
 * pre-satisfy the check before running `--apply` — a hard fail would leave the
 * operator unable to get ANY upgrade PR open until they can already read a
 * contract module that does not yet exist anywhere they can reach. Warning
 * loudly, here and in the PR body (`newInstanceSeamsSection` below), lets the
 * otherwise-good upgrade merge while making the follow-up unmissable: the
 * contract is on the upgrade branch the moment `--apply` finishes, so the
 * instance's declaration can be added as a second commit on that same PR,
 * before it merges.
 */
function printNewInstanceSeams(seams: InstanceSeam[]): void {
  if (seams.length === 0) return
  console.log(
    chalk.red.bold(
      `  ⚠ ${String(seams.length)} new instance seam(s) introduced with no declaration (#1188):`,
    ),
  )
  for (const s of seams) {
    console.log(`    ${chalk.bold(s.specifier)} → add ${chalk.yellow(s.instanceFile)}`)
    console.log(
      chalk.dim(`      Until then, this instance gets the template default: ${s.defaultFile}`),
    )
  }
  console.log()
}

/**
 * Report the #1538/#1570 instance-adoption check to the terminal. Printed on
 * every run, dry run included, and states the denominator explicitly —
 * "N registered pair(s), M applicable to this upgrade" — rather than a bare
 * "clean" that could equally mean "checked and found nothing" or "checked
 * nothing" (the prosecution's finding on #1529's guards, which exist in no
 * instance's tree and so are clean over zero real instances). This module
 * runs against exactly one real tree per invocation — `options.cwd` — so a
 * genuine call always examined 1.
 *
 * Deliberately a warning, never a thrown error — same reasoning as
 * `printNewInstanceSeams` above, adapted: `biffo core upgrade` only ever
 * writes template-owned paths, and the fix here is a user-owned file it has
 * no mandate to edit. Hard-failing every future template-owned upgrade
 * (including a security patch) on an unrelated, pre-existing infra gap would
 * make the cure worse than the disease. Warning loudly, on every run, in the
 * terminal AND the PR body (`buildPrBody`'s adoption section) keeps it
 * impossible to miss without blocking anything it cannot itself resolve.
 */
function printAdoptionReport(report: AdoptionReport): void {
  console.log(
    chalk.dim(
      `  Instance adoption: examined ${String(report.examinedInstances)} instance against ` +
        `${String(report.registeredPairs)} registered pair(s), ` +
        `${String(report.applicablePairs)} applicable to this upgrade.`,
    ),
  )
  const unadopted = report.findings.filter((f) => f.status === 'unadopted')
  if (unadopted.length === 0) {
    console.log()
    return
  }
  console.log(
    chalk.red.bold(
      `  ⚠ ${String(unadopted.length)} adoption gap(s) — shipped but not consumed (#1538/#1570):`,
    ),
  )
  for (const f of unadopted) {
    console.log(
      `    ${chalk.bold(f.pair.id)} — ${chalk.yellow(f.pair.userFile)} does not consume ` +
        chalk.yellow(f.pair.templateFile),
    )
    console.log(chalk.dim(`      ${f.pair.remedy}`))
  }
  console.log()
}

/**
 * Report the #1026 orphan ratchet: template-owned paths present only in the
 * instance, with no sanctioned carve-out. Printed on every run, not just an
 * `--apply` — a ratchet nobody sees is one nobody fixes before it fails.
 *
 * Never itself decides pass/fail; the caller throws on `ratchet.increased`.
 * Kept a pure formatter of already-computed data so the decision logic stays
 * in the unit-tested `checkOrphanRatchet` (lib/core-upgrade.ts).
 */
/**
 * Report whether the plan is faithful to the tag (#1399).
 *
 * Always prints something, including on the clean path. A guard that is silent
 * when it passes cannot be distinguished from a guard that did not run — which
 * is the estate's `class:fail-open` shape (#1363: "a gate reports green over a
 * denominator it never printed"), so the denominator is on the screen.
 */
function printTargetFidelity(report: FidelityReport, toVersion: string): void {
  if (report.unverifiable !== null) {
    console.log(chalk.yellow(`  Target fidelity: NOT VERIFIED — ${report.unverifiable}`))
    console.log()
    return
  }
  if (report.findings.length === 0) {
    console.log(
      chalk.dim(
        `  Target fidelity: ${String(report.checked)} path(s) verified byte-identical to core-v${toVersion}.`,
      ),
    )
    console.log()
    return
  }
  console.log(
    chalk.red(
      `  Target fidelity: ${String(report.findings.length)} of ${String(report.checked)} checked path(s) are NOT core-v${toVersion} content (#1399):`,
    ),
  )
  for (const f of report.findings) console.log(`    ${chalk.red(f.path)} — ${f.reason}`)
  console.log()
}

function printOrphanReport(orphaned: MergeEntry[], ratchet: OrphanRatchet): void {
  if (orphaned.length === 0 && ratchet.baseline === null) return

  console.log(
    chalk.bold(
      `  ${String(orphaned.length)} unsanctioned instance file(s) under a template-owned path (#1026):`,
    ),
  )
  for (const e of orphaned) console.log(`    ${chalk.yellow(e.path)}`)

  if (ratchet.baseline === null) {
    console.log(
      chalk.dim(
        `  No ${ORPHAN_BASELINE_FILE} yet — an --apply run will record ${String(ratchet.count)} as the baseline.`,
      ),
    )
  } else if (ratchet.increased) {
    console.log(
      chalk.red(
        `  Baseline is ${String(ratchet.baseline)} — this run found ${String(ratchet.count)}, an increase.`,
      ),
    )
  } else {
    console.log(
      chalk.dim(
        `  Baseline is ${String(ratchet.baseline)} — no increase (${String(ratchet.count)} now).`,
      ),
    )
  }
  console.log()
}

function printPlan(plan: UpgradePlan): void {
  const ordered = [...plan.conflicts, ...plan.changes.filter((c) => !c.conflicted)]
  for (const e of ordered) {
    const color = STATUS_COLOR[e.status] ?? ((s: string) => s)
    console.log(`  ${color(e.status.padEnd(15))} ${e.path}`)
  }
}

/**
 * Regenerate any lockfile this upgrade invalidated, in the instance.
 *
 * Soft-fails by design (#393): the machine running the upgrade may not have
 * pnpm or uv. Aborting would leave a created branch and no PR; skipping quietly
 * would open a PR that is red for a reason nobody can see. So a failure warns
 * with the exact command and is carried into the PR body.
 *
 * Takes the `ApplyResult`, not the plan. `plan.changes` is everything the
 * upgrade *considered* — it includes `removed` entries for files that were
 * already absent from the instance, which write nothing. Two of those fired
 * this refresh on an upgrade that touched no manifest at all, and it announced
 * "the upgrade changed a dependency manifest they lock" when it hadn't (#393,
 * reopened). `applyUpgradePlan` is the only thing that knows what actually
 * landed, so the decision is made from its result rather than by re-deriving a
 * status filter here — and that keeps a *real* deletion of a workspace member's
 * manifest triggering a refresh, which it must, since removing a manifest
 * changes resolution just as surely as editing one.
 */
async function refreshInstanceLockfiles(
  cwd: string,
  applied: ApplyResult,
  deps: CoreUpgradeDeps,
): Promise<LockfileRefreshOutcome[]> {
  const triggers = lockfilesNeedingRefresh([...applied.written, ...applied.deleted], cwd)
  if (triggers.length === 0) return []

  const run: RunCommandFn = deps.runCommand ?? defaultRunCommand
  const outcomes = await refreshLockfiles(cwd, triggers, run)

  const refreshed = outcomes.filter((o) => o.ok)
  if (refreshed.length > 0) {
    log.info(
      `Refreshed ${refreshed.map((o) => o.trigger.lockfile).join(', ')} — the upgrade changed ` +
        'a dependency manifest they lock.',
    )
  }
  for (const message of describeFailures(outcomes)) log.warn(message)
  return outcomes
}

/**
 * How long any dependency-install subprocess may take before it is killed.
 *
 * A bound that cannot be raised gets removed by the first person it inconveniences, so
 * this is overridable -- but it defaults to finite, because the failure it exists to stop
 * is an upgrade that never returns and never says why.
 */
export const runCommandTimeoutMs = (): number => {
  const raw = process.env.BIFFO_RUN_TIMEOUT_MS
  const parsed = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600_000
}

const defaultRunCommand: RunCommandFn = async (command, cwd) => {
  const [bin, ...args] = command
  if (!bin) return { ok: false, error: 'empty command' }
  try {
    await execa(bin, args, {
      cwd,
      // TWO REASONS THIS HUNG FOR 29 HOURS, AND THE FIX NEEDS BOTH.
      //
      // Measured 2026-08-22: `biffo core upgrade --apply` on tabsii-platform sat for
      // 29 hours on `pnpm install` having done NOTHING -- node_modules untouched since
      // two days earlier, git tree clean, no network connections, main thread idle in
      // ep_poll. It was waiting on stdin for input that could never arrive.
      //
      // 1. `stdin: 'ignore'`. execa 9 gives the child a PIPE for stdin by default
      //    (verified directly: the child reports `socket:[...]`, not the parent's fd).
      //    This process's own stdin was /dev/null -- it runs headless -- so had the pipe
      //    not been created the child would have read EOF at once and either carried on
      //    or failed fast. Instead pnpm got a live socket nothing would ever write to.
      //    Closing it turns a silent forever-wait into an immediate, legible outcome.
      //
      // 2. `timeout`. Nothing bounded the wait: 0 of 38 execa call sites in this CLI
      //    passed one. A subprocess that blocks blocks the whole upgrade, unattended and
      //    unreported -- the same class as wait-for-checks outliving its caller. Ten
      //    minutes is generous for a cold `pnpm install` and still finite; override with
      //    BIFFO_RUN_TIMEOUT_MS where an instance genuinely needs longer.
      stdin: 'ignore',
      timeout: runCommandTimeoutMs(),
    })
    return { ok: true }
  } catch (err) {
    const cause = err as { shortMessage?: string; stderr?: string; message?: string }
    const detail = cause.stderr?.trim() || cause.shortMessage || cause.message || 'failed'
    // First line only: a failed `pnpm install` prints a wall of output, and the
    // warning has to stay readable enough to act on.
    return { ok: false, error: detail.split('\n')[0] ?? 'failed' }
  }
}

/**
 * Warn about first-party plugins that still have a copy under
 * `modules/plugins/` (issue #406).
 *
 * The copy is never synced by an upgrade and, if a root config still points at
 * it, is what Terraform actually applies — so an upgrade can report a plugin's
 * infrastructure as changed while the deployed module stays frozen at install
 * time. That failed silently once already: every signal said success.
 *
 * Warned rather than fixed automatically. Deleting the copy is safe only once
 * the environment's module `source` points at the real path, and that source
 * lives in user-owned `infra/`, which an upgrade must not touch.
 */
function warnStaleFirstPartyCopies(cwd: string): void {
  const stale = staleFirstPartyCopies(cwd)
  if (stale.length === 0) return
  log.warn(
    `${stale.length} first-party plugin(s) still have a copy under modules/plugins/: ` +
      `${stale.join(', ')}. An upgrade never updates those copies, so if ` +
      `infra/environments/*/ still sources them, this plugin's infrastructure changes ` +
      `are NOT deployed. Point the module source at services/_plugins/<name>/terraform ` +
      `and delete the copy — see docs/guides/core-upgrade.md.`,
  )
}

/**
 * Print the breaking changes an upgrade crosses, before the plan.
 *
 * The guide's own preamble says "check this list before upgrading past a
 * version in it" — which depended on a human remembering the list exists. The
 * CLI knows both versions and ships the guide, so it can simply say (#407).
 */
function printBreakingChanges(breaking: BreakingChange[], applying: boolean): void {
  if (breaking.length === 0) return
  console.log(
    chalk.red.bold(
      `\n  ⚠ This upgrade crosses ${breaking.length} documented breaking change(s):\n`,
    ),
  )
  for (const b of breaking) {
    console.log(`  ${chalk.bold(b.version)} — ${b.title}`)
    for (const line of b.body.split('\n').slice(0, 6)) console.log(chalk.dim(`      ${line}`))
    console.log()
  }
  console.log(chalk.dim(`  Full detail: ${UPGRADE_GUIDE_PATH}\n`))
  if (!applying) {
    console.log(
      chalk.dim('  Re-run with --apply --acknowledge-breaking once you have read them.\n'),
    )
  }
}

/**
 * The core version a template checkout represents.
 *
 * Since #423 the version lives in the `core-v*` tag, so a checkout produced by
 * `materializeTemplateAtTag` already knows its version — the caller passed it.
 * This is only for a tree supplied explicitly with `--to-template` /
 * `--from-template`, which is an arbitrary directory: tags say nothing about
 * it. Trees checked out at an older tag still carry a `core.version` file, so
 * that is read when present; otherwise the caller must say which version the
 * tree is, because guessing would silently merge against the wrong base.
 */
function versionOfCheckout(dir: string, explicit: string | undefined): string {
  if (explicit) return explicit
  const file = join(dir, CORE_VERSION_FILE)
  if (existsSync(file)) return readCoreVersionFile(file)
  throw new Error(
    `Cannot determine the core version of ${dir}: it has no ${CORE_VERSION_FILE}, and a ` +
      `checkout supplied explicitly is not resolved from a tag. Pass --to to state which ` +
      `version this tree is.`,
  )
}

/**
 * The template's current core version: its highest `core-v*` tag.
 *
 * Falls back to a `core.version` file only for a template that predates the
 * switch or has no releases yet, so an older checkout still resolves.
 */
function latestCoreVersion(repo: string): string {
  const fromTags = latestCoreVersionFromTags(repo)
  if (fromTags) return fromTags
  const file = join(repo, CORE_VERSION_FILE)
  if (existsSync(file)) return readCoreVersionFile(file)
  throw new Error(
    `Cannot determine the template's core version: ${repo} has no core-v* tags and no ` +
      `${CORE_VERSION_FILE}. Fetch tags (\`git fetch --tags\`) or pass --to explicitly.`,
  )
}
