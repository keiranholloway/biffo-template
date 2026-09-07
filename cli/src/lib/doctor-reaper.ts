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
 * clean, HEAD not detached, worktree HEAD actually contained in what that PR
 * shipped (#1810 — a branch name having a merged PR is not, by itself, proof
 * of that last part), and not held by a LIVE biffo-fleet worktree-claim
 * lock (#1833, replaces #1825 — a merged, clean, attached worktree can still
 * be open for follow-up work under a live session)" is left alone and
 * reported with a reason, per the #1413 denominator rule (state what was
 * kept, not only what was removed).
 *
 * "Live" is judged by age, not mere existence (#1948): nothing in the estate
 * ever releases a `.fleet-worktree-claim` lock (`fleet.sh worktree-claim
 * --release`/`--steal` are documented and never called), so treating any
 * existing lock as permanently live made this milestone's own "keep" a
 * permanent one — measured directly, every `biffo-pg-test-*` Docker
 * container that should have been reclaimed once its worktree's PR merged
 * was instead being kept indefinitely for this exact reason. See
 * `FLEET_CLAIM_STALE_AFTER_MS` below for the TTL and why it can afford to be
 * generous.
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

/**
 * How old a `.fleet-worktree-claim` lock must be before `--fix` stops
 * trusting it as a live session and treats it as abandoned
 * (biffo-template#1948). Four hours, matching `scripts/pg-test-db.sh`'s own
 * `BIFFO_PG_CLONE_TTL_MIN` precedent (240 minutes) for the identical
 * trade-off: generous on purpose, because the actual safety net here is not
 * this TTL, it is the PR-verdict check that runs immediately afterward.
 *
 * Nothing in the estate ever calls `fleet.sh worktree-claim ... --release` or
 * `--steal` (grepped the whole of biffo-fleet — the two verbs are documented
 * in the command's own help text and invoked nowhere) so, absent a TTL, a
 * lock is permanent from the moment it is written. Making that lock stale by
 * age, rather than requiring a release nobody sends, closes the loop the same
 * way every other unreleased-claim class in this estate was closed:
 * mechanism, not a caller remembering a step (`claim.sh`'s `--as`,
 * `--reaffirm` for PR#1848/#1849).
 *
 * Crucially, treating a lock as stale does not by itself reap anything — it
 * only stops short-circuiting `hasFleetClaim` to `true`, and the candidate
 * still has to clear `classifyReapCandidate`'s full table below: `isDirty`,
 * and then a GitHub-confirmed `merged` verdict with `mergeContainsHead ===
 * true`. A worktree a live session is genuinely still working on — no PR yet,
 * or an open one, or uncommitted changes — keeps for that reason instead,
 * whatever the lock's age. So this TTL can afford to be generous: it decides
 * only whether an ALREADY-MERGED, ALREADY-CLEAN worktree gets a chance to be
 * reaped, not whether in-progress work does.
 */
export const FLEET_CLAIM_STALE_AFTER_MS = 4 * 60 * 60 * 1000

export type ReapAction = 'reap' | 'keep'

export type KeepReason =
  | 'detached-head'
  | 'uncommitted-changes'
  | 'fleet-worktree-claimed'
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
  /**
   * True if a live session still holds this worktree via biffo-fleet's own
   * `.fleet-worktree-claim` lock (#1833, replaces #1825). A worktree can be
   * clean, merged, and not detached — passing every other check below —
   * while a live session has it open for follow-up work after the merge.
   * Checked alongside `isDetached`/`isDirty`, before the PR verdict is even
   * asked for: a bare branch (no worktree, no lock directory) always passes
   * `false` here, the same way it does for those two fields.
   */
  hasFleetClaim: boolean
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
  // Checked first, ahead of isDetached/isDirty: the lock directory itself is
  // untracked, so a live claim almost always ALSO trips `isDirty` via `git
  // status --porcelain` (#1833) — checking isDirty first would report every
  // claimed worktree as merely "uncommitted-changes" and the more specific,
  // actionable reason would rarely if ever surface in practice.
  if (facts.hasFleetClaim) return { action: 'keep', reason: 'fleet-worktree-claimed' }
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
 * A branch's OWN name is absent from the live `origin/*` refs
 * (biffo-template#1954) — deliberately not the same test as
 * `branch.track.includes('gone')`.
 *
 * `git worktree add -b <branch> <path> origin/dev` sets the new branch's
 * upstream to `origin/dev` by default, and a plain `git push origin HEAD`
 * (AGENTS.md's own documented push command, no `-u`) never corrects it — so a
 * branch can be pushed, merged, and have `origin/<branch>` deleted on GitHub,
 * while `%(upstream:track)` never reports `[gone]` because the ref it is
 * actually tracking (`origin/dev`) never goes anywhere. Measured live,
 * 2026-09-07: `agent/1900`'s PR merged two days prior and its remote branch
 * was gone, but `git branch -vv` still read `[origin/dev: ahead 1, behind
 * 21]` — invisible to the old `[gone]`-only filter, forever.
 *
 * The fix checks the branch's OWN name against the actual set of live
 * `origin/*` refs (`listRemoteBranchNames`, config-independent) instead of
 * trusting what the branch happens to be configured to track.
 *
 * Deliberately NOT gated on `branch.upstream !== ''` — that would reintroduce
 * a version of the same bug it fixes: `git worktree add -b <branch> <path>
 * origin/dev` sets a non-empty upstream (`origin/dev`) on every branch it
 * creates in this repo's own documented workflow, whether or not that branch
 * is EVER pushed under its own name, so "has some upstream" cannot
 * distinguish "pushed then deleted" from "never pushed at all" here — it is
 * nearly always true. That distinction does not need making, unlike in
 * `upgrade-branch-reaper.ts` (which deletes a branch on this signal ALONE,
 * with no downstream verification): this module's only actual safety check
 * is the GitHub-verified judgement `classifyReapCandidate` applies afterward
 * (`prVerdictForBranch` + `mergeContainsHead`) — a branch that was genuinely
 * never pushed gets `prVerdict: 'none'` there and keeps for `no-pr`, exactly
 * as safely as before. Being "wrong" here costs one extra, harmless GitHub
 * call; being wrong the other way costs a leaked worktree forever.
 */
function hasProvenGoneRemote(branch: BranchRef, remoteBranchNames: Set<string>): boolean {
  return !remoteBranchNames.has(branch.name)
}

/**
 * The candidate pool `--fix` is willing to consider: every worktree whose
 * branch has proven, by `hasProvenGoneRemote`, that its own remote copy is
 * gone (the same set `checkWorktrees`'s `worktree-merged` finding reports,
 * modulo #1954's fix — see that function's doc comment).
 *
 * Deliberately excludes a branch with a live same-named remote copy
 * entirely: nothing has told us this branch's PR ever resolved, so there is
 * no verdict worth asking GitHub for and it stays a report, never an action.
 * Also deliberately worktree-only — a proven-gone branch with no worktree at
 * all is a bare-branch candidate, which is milestone 2.
 */
export function findReapCandidates(
  branches: BranchRef[],
  worktrees: WorktreeFact[],
  remoteBranchNames: Set<string>,
): ReapCandidate[] {
  const goneBranches = new Set(
    branches.filter((b) => hasProvenGoneRemote(b, remoteBranchNames)).map((b) => b.name),
  )
  return worktrees
    .filter((w) => goneBranches.has(w.branch))
    .map((w) => ({ branch: w.branch, worktreePath: w.path }))
}

export interface ReapOutcome {
  candidate: ReapCandidate
  verdict: ReapVerdict
  /** Only meaningful when verdict.action === 'reap'. */
  worktreeRemoved: boolean | null
  /**
   * True when a `.fleet-worktree-claim` lock was found older than
   * `FLEET_CLAIM_STALE_AFTER_MS` and cleared before judgement (#1948) — worth
   * reporting on its own, per the #1413 denominator rule, since it is the
   * one case where `--fix` took a destructive action on a lock nothing else
   * in the estate would ever have released.
   */
  staleClaimCleared: boolean
}

export interface ReapDeps {
  git: Pick<
    GitAdapter,
    | 'hasUncommittedChanges'
    | 'hasFleetWorktreeClaim'
    | 'fleetWorktreeClaimAgeMs'
    | 'clearStaleFleetWorktreeClaim'
    | 'currentBranch'
    | 'removeWorktree'
    | 'headSha'
    | 'isAncestor'
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

  const [current, claimExists] = await Promise.all([
    git.currentBranch(candidate.worktreePath),
    git.hasFleetWorktreeClaim(candidate.worktreePath),
  ])
  const isDetached = current === 'HEAD' || current === ''

  // Staleness is decided BEFORE `isDirty` is read, and a stale lock is
  // cleared before that read too (#1948): the lock directory is untracked,
  // so leaving it in place would trip `git status --porcelain` and keep the
  // worktree anyway, under the less specific `uncommitted-changes` reason —
  // silently defeating the point of deciding the claim itself is stale.
  let hasFleetClaim = false
  let staleClaimCleared = false
  if (claimExists) {
    const ageMs = await git.fleetWorktreeClaimAgeMs(candidate.worktreePath)
    // `null` (lock present, age unreadable) is fail-closed: treated exactly
    // like a live claim, never like a stale one — see `fleetWorktreeClaimAgeMs`'s
    // own doc comment.
    if (ageMs === null || ageMs < FLEET_CLAIM_STALE_AFTER_MS) {
      hasFleetClaim = true
    } else {
      await git.clearStaleFleetWorktreeClaim(candidate.worktreePath)
      staleClaimCleared = true
    }
  }

  const isDirty = await git.hasUncommittedChanges(candidate.worktreePath)

  const prVerdict: PrVerdict =
    isDetached || isDirty || hasFleetClaim
      ? 'unknown'
      : await github.prVerdictForBranch(cwd, candidate.branch)

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

  const verdict = classifyReapCandidate({
    isDetached,
    isDirty,
    hasFleetClaim,
    prVerdict,
    mergeContainsHead,
  })

  if (verdict.action === 'keep') {
    return { candidate, verdict, worktreeRemoved: null, staleClaimCleared }
  }

  const worktreeRemoved = await git.removeWorktree(cwd, candidate.worktreePath)
  return { candidate, verdict, worktreeRemoved, staleClaimCleared }
}

/** Runs every candidate found in `facts`, sequentially — see doc comment on why. */
export async function reapAll(
  cwd: string,
  branches: BranchRef[],
  worktrees: WorktreeFact[],
  currentBranch: string,
  deps: ReapDeps,
  remoteBranchNames: Set<string>,
): Promise<ReapOutcome[]> {
  const candidates = findReapCandidates(branches, worktrees, remoteBranchNames).filter(
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
 * Every proven-gone local branch (`hasProvenGoneRemote`, #1954) with **no**
 * linked worktree. Deliberately the complement of `findReapCandidates`'s own
 * filter (worktree branches only) — together the two cover every proven-gone
 * branch exactly once, never both ways for the same name.
 */
export function findBareBranchCandidates(
  branches: BranchRef[],
  worktrees: WorktreeFact[],
  remoteBranchNames: Set<string>,
): BareBranchCandidate[] {
  const worktreeBranches = new Set(worktrees.map((w) => w.branch))
  return branches
    .filter((b) => hasProvenGoneRemote(b, remoteBranchNames) && !worktreeBranches.has(b.name))
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
    // A bare branch has no worktree, so there is no `.fleet-worktree-claim`
    // directory that could exist — trivially false, same reasoning as the
    // two fields above (#1833).
    hasFleetClaim: false,
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
  remoteBranchNames: Set<string>,
): Promise<BareBranchReapOutcome[]> {
  const candidates = findBareBranchCandidates(branches, worktrees, remoteBranchNames).filter(
    (c) => c.branch !== currentBranch,
  )
  const outcomes: BareBranchReapOutcome[] = []
  for (const candidate of candidates) {
    outcomes.push(await reapBareBranch(cwd, candidate, deps))
  }
  return outcomes
}
