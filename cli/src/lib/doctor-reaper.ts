/**
 * `biffo doctor --fix` (#1682, milestone 1): turning the WORKTREE findings
 * `lib/doctor.ts` already reports accurately into safe, automatic removal.
 *
 * ## Scope: worktrees only
 *
 * This milestone reaps a stale **worktree** whose branch's PR has PROVEN
 * merged — nothing else. It never deletes a branch (`git branch -D`, even for
 * a bare branch with no worktree at all) and nothing calls it yet (no CI, no
 * hook, no cron) — both are later milestones tracked on #1682. Fail-closed by
 * construction: every candidate that is not provably "PR merged, worktree
 * clean, HEAD not detached, and worktree HEAD actually contained in what that
 * PR shipped" (#1810 — a branch name having a merged PR is not, by itself,
 * proof of that last part) is left alone and reported with a reason, per the
 * #1413 denominator rule (state what was kept, not only what was removed).
 *
 * ## Why local commit reachability is not the signal
 *
 * Measured across `~/code` on 2026-08-22 (179 stale worktrees), classified by
 * asking GitHub what actually happened to each branch's PR rather than by
 * local commit reachability: 136 had a resolved (merged, or closed with
 * nothing unique) PR and were safe to reap; the remaining 43 were not,
 * spanning detached HEADs, uncommitted changes, PRs still open, PRs closed
 * unmerged, and branches with no PR at all.
 *
 * `git log --not --remotes` is NOT a safe reap signal on its own: branch
 * auto-delete plus squash merges mean a legitimately merged branch's local
 * commits exist on no remote — 118 of the 179 worktrees measured looked
 * "unpushed" by that test while being entirely landed. The signal that is
 * actually safe is the PR's **verdict**, read from GitHub:
 * `GithubCliAdapter.prVerdictForBranch`. `classifyReapCandidate` below acts on
 * that verdict alone (plus the worktree's own clean/attached state) and
 * nothing else.
 */
import type { GithubCliAdapter, PrVerdict } from '../adapters/github-cli/index.js'
import type { GitAdapter } from '../adapters/git/index.js'
import type { BranchRef } from './upgrade-branch-reaper.js'
import type { WorktreeFact } from './doctor.js'

export type ReapAction = 'reap' | 'keep'

export type KeepReason =
  | 'detached-head'
  | 'uncommitted-changes'
  | 'pr-open'
  | 'pr-closed'
  | 'no-pr'
  | 'unknown-pr-verdict'
  | 'commits-not-in-merge'
  | 'unknown-merge-head'

export interface ReapVerdict {
  action: ReapAction
  reason?: KeepReason
}

/** Everything the judgement needs for one worktree. */
export interface ReapCandidateFacts {
  isDetached: boolean
  isDirty: boolean
  prVerdict: PrVerdict
  /**
   * Whether the worktree's current HEAD is contained within (an ancestor of,
   * or equal to) the commit the merged PR actually shipped — the fact #1810
   * exists because "a PR merged for this branch name" does not, by itself,
   * prove it. `null` means it could not be established (the merged PR's head
   * SHA could not be read from GitHub, or the local repo has never fetched
   * that object) and is treated the same as any other unproven case: kept,
   * not reaped. Only consulted when `prVerdict === 'merged'` — every other
   * verdict already keeps for its own reason, so `true` is a safe, unused
   * default for those rows.
   */
  mergeContainsHead: boolean | null
}

/**
 * The table in the module doc, as code. Pure and synchronous so every row is
 * a one-line test with no repository, mock process, or network involved.
 *
 * Only `merged` reaps. Everything else — `open`, `closed` (unmerged), `none`
 * (no PR ever), `unknown` (GitHub could not be asked) — keeps. Branch
 * deletion and the closed-but-holds-unique-commits distinction that would
 * matter for a *bare* branch are milestone 2 (#1682); this milestone only
 * ever removes a worktree, never a branch, so that distinction does not
 * apply here.
 */
export function classifyReapCandidate(facts: ReapCandidateFacts): ReapVerdict {
  if (facts.isDetached) return { action: 'keep', reason: 'detached-head' }
  if (facts.isDirty) return { action: 'keep', reason: 'uncommitted-changes' }

  switch (facts.prVerdict) {
    case 'merged':
      // "A PR merged for this branch name" is trusted regardless of local
      // commit reachability — a squash merge rewrites every SHA, so "exists
      // nowhere else" would wrongly read a landed branch as unique work. But
      // that is a fact about the BRANCH, not about this worktree's current
      // HEAD (#1810): a worktree can carry real, committed, unpushed commits
      // on top of an already-merged tip, and the branch name alone cannot
      // distinguish that from the safe case. `mergeContainsHead` is the
      // second, independent proof this needs — checked here, not folded into
      // `prVerdict`, so a `null` (could not determine) reads the same
      // fail-closed way `unknown-pr-verdict` already does below.
      if (facts.mergeContainsHead === true) return { action: 'reap' }
      if (facts.mergeContainsHead === false) {
        return { action: 'keep', reason: 'commits-not-in-merge' }
      }
      return { action: 'keep', reason: 'unknown-merge-head' }
    case 'open':
      return { action: 'keep', reason: 'pr-open' }
    case 'closed':
      return { action: 'keep', reason: 'pr-closed' }
    case 'none':
      // No PR was ever opened from this branch. There is no GitHub verdict to
      // trust either way, so this is never reaped automatically.
      return { action: 'keep', reason: 'no-pr' }
    case 'unknown':
      return { action: 'keep', reason: 'unknown-pr-verdict' }
  }
}

export interface ReapCandidate {
  branch: string
  worktreePath: string
}

/**
 * The candidate pool `--fix` is willing to consider: every worktree whose
 * branch's upstream git reports `[gone]` (positive evidence its remote copy
 * was deleted — the same set `checkWorktrees`'s `worktree-merged` finding
 * already reports).
 *
 * Deliberately excludes the `worktree-stale` (far-behind-but-not-gone) class
 * entirely: a live upstream means nothing has told us this branch's PR ever
 * resolved, so there is no verdict to ask GitHub for and it stays a report,
 * never an action. Also deliberately worktree-only — a `[gone]` branch with
 * no worktree at all is a bare-branch candidate, which is milestone 2.
 */
export function findReapCandidates(
  branches: BranchRef[],
  worktrees: WorktreeFact[],
): ReapCandidate[] {
  const goneBranches = new Set(branches.filter((b) => b.track.includes('gone')).map((b) => b.name))
  return worktrees
    .filter((w) => goneBranches.has(w.branch))
    .map((w) => ({ branch: w.branch, worktreePath: w.path }))
}

export interface ReapOutcome {
  candidate: ReapCandidate
  verdict: ReapVerdict
  /** Only meaningful when verdict.action === 'reap'. */
  worktreeRemoved: boolean | null
}

export interface ReapDeps {
  git: Pick<
    GitAdapter,
    'hasUncommittedChanges' | 'currentBranch' | 'removeWorktree' | 'headSha' | 'isAncestor'
  >
  github: Pick<GithubCliAdapter, 'prVerdictForBranch' | 'mergedHeadSha'>
}

/**
 * Gathers the per-candidate facts `classifyReapCandidate` needs, judges, and
 * — for anything judged `reap` — removes the worktree. Never touches a
 * `keep`, and never deletes the branch underneath (milestone 2).
 *
 * The GitHub lookup is skipped entirely once the worktree is already known
 * detached or dirty, since neither of those verdicts changes on the PR state.
 * Likewise, the extra "is HEAD actually contained in what merged" check
 * (#1810) only ever runs once a `merged` verdict is already in hand — every
 * other verdict keeps for its own reason regardless.
 */
export async function reapCandidate(
  cwd: string,
  candidate: ReapCandidate,
  deps: ReapDeps,
): Promise<ReapOutcome> {
  const { git, github } = deps

  const [current, isDirty] = await Promise.all([
    git.currentBranch(candidate.worktreePath),
    git.hasUncommittedChanges(candidate.worktreePath),
  ])
  const isDetached = current === 'HEAD' || current === ''

  const prVerdict: PrVerdict =
    isDetached || isDirty ? 'unknown' : await github.prVerdictForBranch(cwd, candidate.branch)

  // Unused by classifyReapCandidate unless prVerdict === 'merged' — see that
  // field's doc comment. `true` here is a harmless default for every other
  // row of the table.
  let mergeContainsHead: boolean | null = true
  if (prVerdict === 'merged') {
    const [headSha, mergedHeadSha] = await Promise.all([
      git.headSha(candidate.worktreePath),
      github.mergedHeadSha(cwd, candidate.branch),
    ])
    mergeContainsHead =
      headSha === null || mergedHeadSha === null
        ? null
        : await git.isAncestor(cwd, headSha, mergedHeadSha)
  }

  const verdict = classifyReapCandidate({ isDetached, isDirty, prVerdict, mergeContainsHead })

  if (verdict.action === 'keep') {
    return { candidate, verdict, worktreeRemoved: null }
  }

  const worktreeRemoved = await git.removeWorktree(cwd, candidate.worktreePath)
  return { candidate, verdict, worktreeRemoved }
}

/** Runs every candidate found in `facts`, sequentially — see doc comment on why. */
export async function reapAll(
  cwd: string,
  branches: BranchRef[],
  worktrees: WorktreeFact[],
  currentBranch: string,
  deps: ReapDeps,
): Promise<ReapOutcome[]> {
  const candidates = findReapCandidates(branches, worktrees).filter(
    (c) => c.branch !== currentBranch,
  )
  const outcomes: ReapOutcome[] = []
  // Sequential, not Promise.all: each candidate can remove a worktree, and
  // two removals racing against the same shared `.git` (every worktree of a
  // clone shares one) is exactly the kind of concurrent-git hazard AGENTS.md
  // §1 warns about elsewhere in this repo. The candidate count here is small
  // enough (the whole point of running this often) that sequential cost is
  // not worth that risk.
  for (const candidate of candidates) {
    outcomes.push(await reapCandidate(cwd, candidate, deps))
  }
  return outcomes
}

/**
 * Milestone 2 (#1682): the same judgement, extended to a **bare** branch — one
 * with a `[gone]` upstream and no linked worktree at all. 124 measured
 * 2026-08-22, the other half of the same accumulation `git branch -d` cannot
 * clean up (squash merges mean its tips are never ancestors of `dev`).
 *
 * Deliberately reuses `classifyReapCandidate` rather than a parallel
 * classifier: a bare branch has no working tree to be dirty or detached, so
 * both of those inputs are trivially `false` — the ONLY question that differs
 * from the worktree case is what "HEAD" means (a branch's own tip, not a
 * checked-out one), which is what `branchSha` (vs. `headSha`) supplies.
 */
export interface BareBranchCandidate {
  branch: string
}

/**
 * Every `[gone]` local branch with **no** linked worktree. Deliberately the
 * complement of `findReapCandidates`'s own filter (worktree branches only) —
 * together the two cover every `[gone]` branch exactly once, never both ways
 * for the same name.
 */
export function findBareBranchCandidates(
  branches: BranchRef[],
  worktrees: WorktreeFact[],
): BareBranchCandidate[] {
  const worktreeBranches = new Set(worktrees.map((w) => w.branch))
  return branches
    .filter((b) => b.track.includes('gone') && !worktreeBranches.has(b.name))
    .map((b) => ({ branch: b.name }))
}

export interface BareBranchReapOutcome {
  candidate: BareBranchCandidate
  verdict: ReapVerdict
  /** Only meaningful when verdict.action === 'reap'. */
  branchDeleted: boolean | null
}

export interface BranchReapDeps {
  git: Pick<GitAdapter, 'branchSha' | 'isAncestor' | 'deleteBranch'>
  github: Pick<GithubCliAdapter, 'prVerdictForBranch' | 'mergedHeadSha'>
}

/** Judges and, if safe, deletes one bare branch — see the module doc above. */
export async function reapBareBranch(
  cwd: string,
  candidate: BareBranchCandidate,
  deps: BranchReapDeps,
): Promise<BareBranchReapOutcome> {
  const { git, github } = deps

  const prVerdict = await github.prVerdictForBranch(cwd, candidate.branch)

  let mergeContainsHead: boolean | null = true
  if (prVerdict === 'merged') {
    const [branchTip, mergedHeadSha] = await Promise.all([
      git.branchSha(cwd, candidate.branch),
      github.mergedHeadSha(cwd, candidate.branch),
    ])
    mergeContainsHead =
      branchTip === null || mergedHeadSha === null
        ? null
        : await git.isAncestor(cwd, branchTip, mergedHeadSha)
  }

  const verdict = classifyReapCandidate({
    isDetached: false,
    isDirty: false,
    prVerdict,
    mergeContainsHead,
  })

  if (verdict.action === 'keep') {
    return { candidate, verdict, branchDeleted: null }
  }

  const branchDeleted = await git.deleteBranch(cwd, candidate.branch)
  return { candidate, verdict, branchDeleted }
}

/**
 * Runs every bare-branch candidate, sequentially — same reasoning as
 * `reapAll`: branch deletion mutates the same shared `.git` every worktree of
 * this clone reads from.
 */
export async function reapAllBareBranches(
  cwd: string,
  branches: BranchRef[],
  worktrees: WorktreeFact[],
  currentBranch: string,
  deps: BranchReapDeps,
): Promise<BareBranchReapOutcome[]> {
  const candidates = findBareBranchCandidates(branches, worktrees).filter(
    (c) => c.branch !== currentBranch,
  )
  const outcomes: BareBranchReapOutcome[] = []
  for (const candidate of candidates) {
    outcomes.push(await reapBareBranch(cwd, candidate, deps))
  }
  return outcomes
}
