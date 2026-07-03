import { execSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import { GitAdapter } from '../adapters/git/index.js'
import { GitHubAdapter } from '../adapters/source-control/github/index.js'
import { readCoreManifest, resolveTemplateRoot } from '../lib/core-manifest.js'
import {
  readCoreVersionFile,
  readInstanceCoreVersion,
  writeInstanceCoreVersion,
} from '../lib/core-version.js'
import {
  type UpgradePlan,
  applyUpgradePlan,
  parseGitHubRepo,
  planCoreUpgrade,
  upgradeBranchName,
} from '../lib/core-upgrade.js'
import { type MaterializedTree, materializeTemplateAtTag } from '../lib/core-template-trees.js'
import { log } from '../lib/logger.js'

export const coreUpgradeCommand = new Command('upgrade')
  .description('Three-way-merge template-owned files for a core upgrade; preview it or open a PR')
  .option('--cwd <path>', 'Instance repo root to upgrade (defaults to the current directory)')
  .option(
    '--template-repo <path>',
    'Path to a biffo-template git checkout whose core-v* tags supply the base/target trees (defaults to the template this CLI ships with)',
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
  .option('--base <branch>', 'Base branch for the PR (defaults to the current branch)')
  .option('--remote <name>', 'Git remote to push to and open the PR on (default: origin)')
  .action(
    async (options: {
      cwd?: string
      templateRepo?: string
      to?: string
      fromTemplate?: string
      toTemplate?: string
      apply?: boolean
      allowConflicts?: boolean
      base?: string
      remote?: string
    }) => {
      const cwd = options.cwd ? resolve(options.cwd) : process.cwd()
      const runOptions: CoreUpgradeOptions = {
        cwd,
        apply: options.apply ?? false,
        allowConflicts: options.allowConflicts ?? false,
      }
      if (options.templateRepo) runOptions.templateRepo = resolve(options.templateRepo)
      if (options.to) runOptions.toVersion = options.to
      if (options.fromTemplate) runOptions.baseDir = resolve(options.fromTemplate)
      if (options.toTemplate) runOptions.theirsDir = resolve(options.toTemplate)
      if (options.base) runOptions.base = options.base
      if (options.remote) runOptions.remote = options.remote
      try {
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
  base?: string
  remote?: string
}

// Minimal adapter interfaces so the apply path is unit-testable with fakes.
export interface CoreUpgradeGit {
  isGitRepo(cwd: string): Promise<boolean>
  hasUncommittedChanges(cwd: string): Promise<boolean>
  currentBranch(cwd: string): Promise<string>
  getRemoteUrl(cwd: string, remote?: string): Promise<string>
  createBranch(cwd: string, branch: string): Promise<void>
  add(cwd: string, paths: string[]): Promise<void>
  commit(cwd: string, message: string): Promise<void>
  push(cwd: string, branch: string, opts?: { remote?: string; token?: string }): Promise<void>
}
export interface CoreUpgradeGitHub {
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
}

function defaultDeps(): CoreUpgradeDeps {
  return {
    git: new GitAdapter(),
    makeGitHub: (token) => new GitHubAdapter(token),
    resolveToken: resolveGitHubToken,
    materialize: materializeTemplateAtTag,
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
  } finally {
    for (const c of cleanups) c()
  }
}

async function runCoreUpgradeResolved(
  options: CoreUpgradeOptions,
  deps: CoreUpgradeDeps,
  cleanups: Array<() => void>,
): Promise<void> {
  const materialize = deps.materialize ?? materializeTemplateAtTag
  const templateRepo = options.templateRepo ? resolve(options.templateRepo) : resolveTemplateRoot()
  const instanceVersion = readInstanceCoreVersion(options.cwd)

  // Target tree (theirs): explicit checkout > template working tree (when the
  // target is its own version) > the target version's tag. `toVersion` is read
  // from whichever tree is used, so display and branch naming stay consistent.
  let theirsDir: string
  let toVersion: string
  if (options.theirsDir) {
    theirsDir = options.theirsDir
    toVersion = readCoreVersionFile(join(theirsDir, 'core.version'))
  } else {
    const workingVersion = readCoreVersionFile(join(templateRepo, 'core.version'))
    toVersion = options.toVersion ?? workingVersion
    if (toVersion === workingVersion) {
      theirsDir = templateRepo
    } else {
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
    fromVersion = readCoreVersionFile(join(baseDir, 'core.version'))
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

  const heading = options.apply ? 'Biffo core upgrade' : 'Biffo core upgrade (dry run)'
  console.log(chalk.bold(`\n  ${heading}\n`))
  console.log(`  instance core:   ${instanceVersion ?? chalk.dim('(unrecorded)')}`)
  console.log(`  merge base:      ${fromVersion}`)
  console.log(`  target:          ${toVersion}\n`)

  if (plan.changes.length === 0) {
    log.success('Nothing to upgrade — the instance already matches the target for all core files.')
    return
  }

  printPlan(plan)
  console.log(
    `\n  ${chalk.bold(String(plan.changes.length))} change(s), ` +
      `${plan.conflicts.length > 0 ? chalk.red(`${plan.conflicts.length} conflict(s)`) : chalk.green('0 conflicts')}.`,
  )

  if (!options.apply) {
    if (plan.conflicts.length > 0) {
      log.warn('Some core files changed on both sides and need manual resolution.')
    }
    console.log(
      chalk.dim('\n  Dry run — nothing written. Re-run with --apply to open an upgrade PR.\n'),
    )
    return
  }

  await applyAndOpenPr(options, deps, plan, fromVersion, toVersion)
}

async function applyAndOpenPr(
  options: CoreUpgradeOptions,
  deps: CoreUpgradeDeps,
  plan: UpgradePlan,
  fromVersion: string,
  toVersion: string,
): Promise<void> {
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
  if (await git.hasUncommittedChanges(options.cwd)) {
    throw new Error('The working tree has uncommitted changes. Commit or stash them first.')
  }

  const base = options.base ?? (await git.currentBranch(options.cwd))
  const branch = upgradeBranchName(fromVersion, toVersion)

  log.step(1, 4, `Creating branch ${branch}`)
  await git.createBranch(options.cwd, branch)

  const applied = applyUpgradePlan(options.cwd, plan)
  writeInstanceCoreVersion(options.cwd, toVersion)
  log.step(
    2,
    4,
    `Applied ${applied.written.length} change(s), ${applied.deleted.length} deletion(s)`,
  )

  await git.add(options.cwd, ['-A'])
  await git.commit(options.cwd, `chore(core): upgrade template core ${fromVersion} -> ${toVersion}`)

  log.step(3, 4, `Pushing ${branch}`)
  const pushOpts: { remote?: string; token: string } = { token }
  if (options.remote) pushOpts.remote = options.remote
  await git.push(options.cwd, branch, pushOpts)

  log.step(4, 4, 'Opening pull request')
  const remoteUrl = await git.getRemoteUrl(options.cwd, options.remote)
  const { owner, repo } = parseGitHubRepo(remoteUrl)
  const pr = await deps.makeGitHub(token).createPullRequest({
    owner,
    repo,
    head: branch,
    base,
    title: `Upgrade Biffo core ${fromVersion} → ${toVersion}`,
    body: buildPrBody(fromVersion, toVersion, plan),
  })

  if (plan.conflicts.length > 0) {
    log.warn(`PR opened with ${plan.conflicts.length} conflict(s) to resolve: ${pr.url}`)
  } else {
    log.success(`Opened PR #${pr.number}: ${pr.url}`)
  }
}

function buildPrBody(from: string, to: string, plan: UpgradePlan): string {
  const lines: string[] = [
    'Automated core upgrade generated by `biffo core upgrade` (ADR-0006).',
    '',
    `Bumps the Biffo template core from **${from}** to **${to}** and updates \`biffo.core.json\`. Only template-owned paths (see \`core-manifest.json\`) were touched — product, plugin, and infra files were left untouched.`,
    '',
    `## Changes (${plan.changes.length})`,
    '',
    `- merged: ${plan.summary.merged}`,
    `- take-theirs: ${plan.summary['take-theirs']}`,
    `- added: ${plan.summary.added}`,
    `- removed: ${plan.summary.removed}`,
  ]
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
  removed: chalk.red,
  'keep-ours': chalk.dim,
}

function printPlan(plan: UpgradePlan): void {
  const ordered = [...plan.conflicts, ...plan.changes.filter((c) => !c.conflicted)]
  for (const e of ordered) {
    const color = STATUS_COLOR[e.status] ?? ((s: string) => s)
    console.log(`  ${color(e.status.padEnd(15))} ${e.path}`)
  }
}
