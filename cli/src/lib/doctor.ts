/**
 * Repo-state checks for `biffo doctor` (#797).
 *
 * ## Why these five, and not a general linter
 *
 * Every check below corresponds to a condition that has already produced a
 * **wrong conclusion** in this estate — not a tidiness preference. They share
 * one shape: *a file or checkout that is stale in a way nothing signals, read
 * confidently, producing a number that is wrong but entirely plausible.* Each
 * was caught by a human or by luck; none was caught by a tool.
 *
 * | Condition | What it caused |
 * | --- | --- |
 * | primary parked off the integration branch | an audit run against dead code, and a wrong claim in a PR body (#758) |
 * | `biffo.core.json` stale versus the remote | a 4-file upgrade sized as 17 commits, from a checkout two releases behind |
 * | fossil `core.version` disagreeing | read as authoritative, 114 minor versions wrong (#788) |
 * | local branches whose PR merged | 190 accumulated, invisible to `--merged` (squash) and to `: gone]` (#758) |
 * | worktrees on merged or ancient branches | one sat ~30 core versions stale (#758) |
 *
 * ## Read-only, by construction
 *
 * Nothing here mutates. The reaper in `upgrade-branch-reaper.ts` deletes only
 * behind an explicit `--reap`; a doctor that acted on sight would be worse than
 * the problem, because several of these conditions are *legitimate* in a repo
 * someone is mid-flight in.
 *
 * The functions take already-gathered facts rather than reaching for git or
 * GitHub themselves, so the judgement is testable without a repository.
 */

import { UPGRADE_BRANCH_PREFIX } from './core-upgrade.js'
import { type BranchRef } from './upgrade-branch-reaper.js'

export type DoctorSeverity = 'error' | 'warn'

export interface DoctorFinding {
  /** Stable identifier, so a caller can filter without matching prose. */
  check: string
  severity: DoctorSeverity
  /** What is wrong, in terms of the consequence rather than the symptom. */
  detail: string
  /** The command or action that resolves it. */
  remedy: string
}

/** Everything the checks need, gathered once by the command. */
export interface RepoFacts {
  /** Checked-out branch of this checkout; 'HEAD' when detached. */
  currentBranch: string
  /**
   * Is this the primary checkout, rather than a linked worktree?
   *
   * AGENTS.md §2 requires the *primary* to stay on the integration branch,
   * while §1 requires all work to happen in a worktree on its own branch. So
   * "not on dev" is a defect in one and the mandated state in the other, and
   * a check that cannot tell them apart cries wolf in the place everybody
   * works.
   */
  isPrimary: boolean
  /** The repo's integration branch — `dev` in every Biffo repo (AGENTS.md §2). */
  integrationBranch: string
  ahead: number
  behind: number
  hasUpstream: boolean
  /** Does this checkout have uncommitted changes? */
  isDirty: boolean
  /** `biffo.core.json`'s version in this checkout, null when absent. */
  localCoreVersion: string | null
  /** The same file's version on the integration branch, null when unknown. */
  remoteCoreVersion: string | null
  /** Trimmed content of a `core.version` file, null when there is none. */
  fossilCoreVersion: string | null
  /** Local branches with upstream/tracking state. */
  branches: BranchRef[]
  /** Worktrees other than the primary. */
  worktrees: WorktreeFact[]
}

export interface WorktreeFact {
  path: string
  branch: string
  /** Commits this worktree's branch is behind the integration branch. */
  behind: number | null
}

/**
 * The primary checkout must sit on the integration branch, current.
 *
 * #797 rates this the highest-value check because it is the one that produced a
 * wrong audit: a primary parked on a stale upgrade branch reads as the state of
 * the repo, and everything derived from it inherits the error.
 */
export function checkCheckoutCurrency(facts: RepoFacts): DoctorFinding[] {
  const findings: DoctorFinding[] = []

  if (facts.currentBranch === 'HEAD' || facts.currentBranch === '') {
    findings.push({
      check: 'checkout-detached',
      severity: 'error',
      detail:
        'The primary checkout has a detached HEAD, so nothing read from it can be attributed to a branch.',
      remedy: `git switch ${facts.integrationBranch}`,
    })
    return findings
  }

  // Only the PRIMARY is required to sit on the integration branch. A linked
  // worktree on a feature branch is AGENTS.md §1 being followed, not a defect.
  if (facts.isPrimary && facts.currentBranch !== facts.integrationBranch) {
    findings.push({
      check: 'checkout-off-integration',
      severity: 'error',
      detail:
        `The primary checkout is on '${facts.currentBranch}', not '${facts.integrationBranch}'. ` +
        `Anything read from it — versions, migrations, whether a feature exists — describes that ` +
        `branch, not the repo. This is how an audit gets run against dead code (AGENTS.md §2).`,
      remedy: `git switch ${facts.integrationBranch} && git pull  (do the work in a worktree instead)`,
    })
  }

  // A dirty PRIMARY means someone edited it directly, which AGENTS.md §1
  // forbids — all work belongs in a worktree. Beyond the rule, it means what
  // you read from it is neither `dev` nor anything reviewed. In a worktree,
  // uncommitted changes are just work in progress.
  if (facts.isPrimary && facts.isDirty) {
    findings.push({
      check: 'checkout-dirty',
      severity: 'warn',
      detail:
        'The primary checkout has uncommitted changes, so what it contains is neither the ' +
        'integration branch nor anything reviewed. Editing the primary directly is what ' +
        'AGENTS.md §1 exists to prevent; work belongs in a worktree.',
      remedy:
        'git stash push -m "<what this is>" or commit it on a branch, then work in a worktree',
    })
  }

  if (facts.hasUpstream && facts.behind > 0) {
    const diverged = facts.ahead > 0 ? `, and ${String(facts.ahead)} ahead (diverged)` : ''
    const where = facts.isPrimary ? 'The primary checkout' : 'This worktree'
    findings.push({
      check: 'checkout-behind',
      // In a worktree, behind-its-own-upstream means someone else pushed to the
      // branch — worth knowing, but not a reason to distrust everything read
      // from it the way a stale primary is.
      severity: facts.isPrimary ? 'error' : 'warn',
      detail:
        `${where} is ${String(facts.behind)} commit(s) behind its upstream${diverged}. ` +
        `Every file read from it may be stale, including the ones that look like authoritative state.`,
      remedy: 'git pull --ff-only',
    })
  }

  return findings
}

/**
 * The recorded core version must match what the integration branch carries.
 *
 * Observed on 2026-07-28: two instances' primary checkouts reported `0.153.2`
 * and `0.155.0` while both were really on `0.157.3`. A 4-file upgrade was sized
 * as 17 commits / 29 files from that reading, and the decision about whether to
 * run it was nearly taken on it.
 */
export function checkCoreVersionCurrency(facts: RepoFacts): DoctorFinding[] {
  if (facts.localCoreVersion === null || facts.remoteCoreVersion === null) return []
  if (facts.localCoreVersion === facts.remoteCoreVersion) return []
  // A worktree branched before the last upgrade legitimately records an older
  // version; that is a branch being a branch, not a stale checkout.
  if (!facts.isPrimary) return []

  return [
    {
      check: 'core-version-stale',
      severity: 'error',
      detail:
        `This checkout records core ${facts.localCoreVersion}, but ${facts.integrationBranch} ` +
        `carries ${facts.remoteCoreVersion}. Sizing an upgrade or reasoning about which fixes ` +
        `this instance has from the local number will be wrong.`,
      remedy: 'git pull --ff-only, then re-read biffo.core.json',
    },
  ]
}

/**
 * A `core.version` file that disagrees with the authority is a fossil (#788).
 *
 * Written once at `biffo init`, never maintained, and not shipped by the
 * template at all since #423 — so the only copies are frozen ones inside
 * instances. It is a top-level file whose entire content is a version number,
 * with nothing signalling that it is dead, and it has already misled a reader
 * with the code in front of them. #811 stopped the CLI trusting it; nothing
 * stops a human.
 *
 * **Kept deliberately, as a permanent regression guard (#842).** The two live
 * instances' copies are gone and nothing in this repo writes `core.version` any
 * more — every reference reads it — so in a healthy estate this check never
 * fires. Firing means either a pre-#423 instance has surfaced that has not yet
 * run an upgrade, or something has started writing the file again. It is not
 * dead code awaiting removal once the fossils were cleared.
 */
export function checkFossilCoreVersion(facts: RepoFacts): DoctorFinding[] {
  if (facts.fossilCoreVersion === null || facts.localCoreVersion === null) return []
  if (facts.fossilCoreVersion === facts.localCoreVersion) return []

  return [
    {
      check: 'fossil-core-version',
      severity: 'warn',
      detail:
        `core.version says ${facts.fossilCoreVersion} while biffo.core.json says ` +
        `${facts.localCoreVersion}. core.version is inherited from \`biffo init\` and has not ` +
        `been maintained since; biffo.core.json is the authority. Reading the wrong one is #788.`,
      remedy:
        'Ignore core.version. `biffo core upgrade` removes it when it can prove it is redundant ' +
        '(equal to biffo.core.json) or stale (behind it), and deliberately keeps a copy AHEAD of ' +
        'biffo.core.json or not a version at all — no upgrade produces those, so they are ' +
        'somebody’s own file and this warning is then expected.',
    },
  ]
}

/**
 * Local branches whose remote copy is gone — merged and left behind.
 *
 * Generalised past the upgrade-branch prefix that `upgrade-branch-reaper.ts`
 * matches, because the 2026-07-28 sweep found the accumulation is mostly
 * hand-named branches, not tool-created ones: 32 of 35 leftovers.
 *
 * Only counts branches whose upstream git reports as **gone** — positive
 * evidence that the remote copy was deleted, which `--delete-branch` does after
 * a merge. A branch with no upstream at all is indistinguishable from unlanded
 * local work and is never reported as reapable.
 */
export function checkStaleBranches(facts: RepoFacts): DoctorFinding[] {
  const gone = facts.branches
    .filter((b) => b.name !== facts.currentBranch && b.track.includes('gone'))
    .map((b) => b.name)

  if (gone.length === 0) return []

  const upgradeOnes = gone.filter((n) => n.startsWith(UPGRADE_BRANCH_PREFIX)).length
  const note = upgradeOnes > 0 ? ` (${String(upgradeOnes)} from core upgrades)` : ''

  return [
    {
      check: 'stale-branches',
      severity: 'warn',
      detail:
        `${String(gone.length)} local branch(es) have a gone upstream${note} — their remote copy ` +
        `was deleted, which happens on merge. Squash merges mean \`git branch -d\` refuses them ` +
        `and \`--merged\` never lists them, so they accumulate silently (#758).`,
      remedy: `git branch -D ${gone.slice(0, 3).join(' ')}${gone.length > 3 ? ' …' : ''}`,
    },
  ]
}

/** Worktrees left on a branch that has merged, or that has fallen far behind. */
export function checkWorktrees(facts: RepoFacts, behindThreshold = 50): DoctorFinding[] {
  const findings: DoctorFinding[] = []
  const goneBranches = new Set(
    facts.branches.filter((b) => b.track.includes('gone')).map((b) => b.name),
  )

  const merged = facts.worktrees.filter((w) => goneBranches.has(w.branch))
  if (merged.length > 0) {
    findings.push({
      check: 'worktree-merged',
      severity: 'warn',
      detail:
        `${String(merged.length)} worktree(s) sit on a branch whose remote copy is gone, i.e. ` +
        `whose PR has merged: ${merged.map((w) => w.path).join(', ')}.`,
      remedy: 'git worktree remove <path>',
    })
  }

  const ancient = facts.worktrees.filter(
    (w) => !goneBranches.has(w.branch) && w.behind !== null && w.behind >= behindThreshold,
  )
  if (ancient.length > 0) {
    findings.push({
      check: 'worktree-stale',
      severity: 'warn',
      detail:
        `${String(ancient.length)} worktree(s) are more than ${String(behindThreshold)} commits ` +
        `behind ${facts.integrationBranch}: ` +
        `${ancient.map((w) => `${w.path} (${String(w.behind)})`).join(', ')}. Reading one of ` +
        `these describes the repo as it was, not as it is.`,
      remedy: 'git worktree remove <path>, or rebase it onto the integration branch',
    })
  }

  return findings
}

/** Every check, in the order a reader should see them. */
export function runDoctorChecks(facts: RepoFacts): DoctorFinding[] {
  return [
    ...checkCheckoutCurrency(facts),
    ...checkCoreVersionCurrency(facts),
    ...checkFossilCoreVersion(facts),
    ...checkStaleBranches(facts),
    ...checkWorktrees(facts),
  ]
}
