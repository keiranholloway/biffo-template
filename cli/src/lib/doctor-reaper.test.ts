import { describe, expect, it, vi } from 'vitest'
import {
  classifyReapCandidate,
  findBareBranchCandidates,
  findReapCandidates,
  FLEET_CLAIM_STALE_AFTER_MS,
  reapAll,
  reapAllBareBranches,
  reapBareBranch,
  reapCandidate,
  type BranchReapDeps,
  type ReapCandidateFacts,
  type ReapDeps,
} from './doctor-reaper.js'
import type { BranchRef } from './upgrade-branch-reaper.js'
import type { WorktreeFact } from './doctor.js'

/** A safe starting point for classifyReapCandidate's facts; override per test. */
function facts(overrides: Partial<ReapCandidateFacts> = {}): ReapCandidateFacts {
  return {
    isDetached: false,
    isDirty: false,
    hasFleetClaim: false,
    prVerdict: 'merged',
    mergeContainsHead: true,
    ...overrides,
  }
}

describe('classifyReapCandidate', () => {
  // The must-catch / must-NOT-catch table from the module doc, one row per
  // test — this IS the specification `--fix` acts on.

  it('reaps a worktree whose branch PR merged and whose HEAD is contained in what merged', () => {
    expect(classifyReapCandidate(facts({ prVerdict: 'merged', mergeContainsHead: true }))).toEqual({
      action: 'reap',
    })
  })

  // #1810: a merged PR for this branch NAME does not prove this worktree's
  // CURRENT HEAD is what merged — it can carry real, committed, unpushed
  // commits on top. This is the fail-first case: before the fix, the
  // classifier reaped on `prVerdict === 'merged'` alone and never looked at
  // `mergeContainsHead` at all.
  it('keeps a worktree whose branch PR merged but whose HEAD carries commits ahead of it', () => {
    expect(classifyReapCandidate(facts({ prVerdict: 'merged', mergeContainsHead: false }))).toEqual(
      { action: 'keep', reason: 'commits-not-in-merge' },
    )
  })

  it('keeps a worktree whose branch PR merged when containment could not be established', () => {
    expect(classifyReapCandidate(facts({ prVerdict: 'merged', mergeContainsHead: null }))).toEqual({
      action: 'keep',
      reason: 'unknown-merge-head',
    })
  })

  it('keeps a worktree whose branch PR is still open', () => {
    expect(classifyReapCandidate(facts({ prVerdict: 'open' }))).toEqual({
      action: 'keep',
      reason: 'pr-open',
    })
  })

  it('keeps a worktree whose branch PR closed unmerged', () => {
    // #1682's own measurement: security/undici-advisories closed unmerged in
    // several repos, commits sitting nowhere else. Reaping on "PR not open"
    // alone would delete real work; this milestone never distinguishes
    // "nothing unique left" from "unique commits remain" for a closed PR —
    // it simply never touches either. That refinement is milestone 2.
    expect(classifyReapCandidate(facts({ prVerdict: 'closed' }))).toEqual({
      action: 'keep',
      reason: 'pr-closed',
    })
  })

  it('keeps a worktree with no PR ever opened from its branch', () => {
    // batch/* reconvergence branches: local-only commits, no PR at all.
    // There is no GitHub verdict to trust either way.
    expect(classifyReapCandidate(facts({ prVerdict: 'none' }))).toEqual({
      action: 'keep',
      reason: 'no-pr',
    })
  })

  it('keeps a worktree when the PR verdict itself could not be read', () => {
    expect(classifyReapCandidate(facts({ prVerdict: 'unknown' }))).toEqual({
      action: 'keep',
      reason: 'unknown-pr-verdict',
    })
  })

  it('keeps a detached-HEAD worktree before even asking about the PR', () => {
    expect(classifyReapCandidate(facts({ isDetached: true, prVerdict: 'merged' }))).toEqual({
      action: 'keep',
      reason: 'detached-head',
    })
  })

  it('keeps a dirty worktree before even asking about the PR', () => {
    expect(classifyReapCandidate(facts({ isDirty: true, prVerdict: 'merged' }))).toEqual({
      action: 'keep',
      reason: 'uncommitted-changes',
    })
  })

  // #1833 (replaces #1825): a worktree can be clean, merged, and not
  // detached — passing every check above — while a live session still holds
  // it via biffo-fleet's own `.fleet-worktree-claim` lock for follow-up work
  // after the merge. This is the fail-first case: before the fix,
  // `classifyReapCandidate` had no `hasFleetClaim` input at all and reaped
  // on `prVerdict === 'merged'` alone, exactly like #1810 before it.
  it('keeps a worktree with a live fleet-worktree-claim lock before even asking about the PR', () => {
    expect(classifyReapCandidate(facts({ hasFleetClaim: true, prVerdict: 'merged' }))).toEqual({
      action: 'keep',
      reason: 'fleet-worktree-claimed',
    })
  })
})

describe('findReapCandidates', () => {
  const branches: BranchRef[] = [
    { name: 'dev', upstream: 'refs/remotes/origin/dev', track: '' },
    { name: 'chore/merged', upstream: 'refs/remotes/origin/chore/merged', track: '[gone]' },
    { name: 'feat/live', upstream: 'refs/remotes/origin/feat/live', track: '[ahead 1]' },
    { name: 'fix/orphan-bare', upstream: 'refs/remotes/origin/fix/orphan-bare', track: '[gone]' },
  ]
  const worktrees: WorktreeFact[] = [
    { path: '/wt/merged', branch: 'chore/merged', behind: 0 },
    { path: '/wt/live', branch: 'feat/live', behind: 2 },
  ]
  // origin still carries dev and feat/live; chore/merged and fix/orphan-bare
  // do not — the fact `hasProvenGoneRemote` (#1954) actually reads, in place
  // of trusting `track`.
  const remoteBranchNames = new Set(['dev', 'feat/live'])

  it('only considers worktrees whose branch has proven its remote copy gone', () => {
    const candidates = findReapCandidates(branches, worktrees, remoteBranchNames)
    expect(candidates).toEqual([{ branch: 'chore/merged', worktreePath: '/wt/merged' }])
  })

  it('excludes a proven-gone branch with no worktree — bare-branch reaping is findBareBranchCandidates below', () => {
    const candidates = findReapCandidates(branches, worktrees, remoteBranchNames)
    expect(candidates.map((c) => c.branch)).not.toContain('fix/orphan-bare')
  })

  it('excludes a worktree whose remote copy still exists — no verdict to ask for', () => {
    const candidates = findReapCandidates(branches, worktrees, remoteBranchNames)
    expect(candidates.map((c) => c.branch)).not.toContain('feat/live')
  })

  // #1954: the exact defect this fix closes — `agent/1900`'s real upstream
  // was misconfigured to `origin/dev`, so `track` never read `[gone]` even
  // after its own remote copy (`origin/agent/1900`) was deleted.
  it('considers a worktree whose branch has SOME upstream but is mistracking origin/dev, once its own remote copy is gone', () => {
    const mistracked: BranchRef[] = [
      { name: 'agent/1900', upstream: 'refs/remotes/origin/dev', track: '[behind 21]' },
    ]
    const mistrackedWorktrees: WorktreeFact[] = [
      { path: '/wt/agent-1900', branch: 'agent/1900', behind: 21 },
    ]
    // origin/agent/1900 does not exist — only origin/dev does.
    const candidates = findReapCandidates(mistracked, mistrackedWorktrees, new Set(['dev']))
    expect(candidates).toEqual([{ branch: 'agent/1900', worktreePath: '/wt/agent-1900' }])
  })

  // A branch never pushed under any name (no upstream at all — the
  // `upgrade-branch-reaper.ts` fossil case) IS a candidate here, deliberately
  // — see `hasProvenGoneRemote`'s doc comment for why that distinction does
  // not need making at this layer. `reapAll`'s own test below proves it is
  // still never reaped: `classifyReapCandidate`'s GitHub-verified judgement
  // is what actually keeps it safe, not this filter.
  it('DOES include a branch with no upstream at all, since it costs one harmless GitHub call, never an unsafe reap', () => {
    const neverPushed: BranchRef[] = [{ name: 'scratch/local-only', upstream: '', track: '' }]
    const neverPushedWorktrees: WorktreeFact[] = [
      { path: '/wt/local-only', branch: 'scratch/local-only', behind: 0 },
    ]
    const candidates = findReapCandidates(neverPushed, neverPushedWorktrees, new Set())
    expect(candidates).toEqual([{ branch: 'scratch/local-only', worktreePath: '/wt/local-only' }])
  })
})

/** A reap deps mock defaulting to a clean, mergeable worktree; override per test. */
function reapDeps(
  overrides: {
    git?: Record<string, unknown>
    github?: Record<string, unknown>
  } = {},
): ReapDeps {
  return {
    git: {
      currentBranch: vi.fn().mockResolvedValue('chore/merged'),
      hasUncommittedChanges: vi.fn().mockResolvedValue(false),
      hasFleetWorktreeClaim: vi.fn().mockResolvedValue(false),
      // Only ever read when hasFleetWorktreeClaim resolves true (#1948) —
      // defaults to "just claimed" so a test that overrides only
      // hasFleetWorktreeClaim to true still exercises the live-claim path,
      // matching this factory's existing "clean, mergeable" default posture.
      fleetWorktreeClaimAgeMs: vi.fn().mockResolvedValue(0),
      clearStaleFleetWorktreeClaim: vi.fn().mockResolvedValue(undefined),
      removeWorktree: vi.fn().mockResolvedValue(true),
      // Defaults model the safe case: the worktree's HEAD IS the commit the
      // merged PR shipped, so `isAncestor` (self-is-ancestor-of-self) is true.
      headSha: vi.fn().mockResolvedValue('deadbeef'),
      isAncestor: vi.fn().mockResolvedValue(true),
      ...overrides.git,
    } as never,
    github: {
      prVerdictForBranch: vi.fn().mockResolvedValue('merged'),
      mergedHeadSha: vi.fn().mockResolvedValue('deadbeef'),
      ...overrides.github,
    } as never,
  }
}

describe('reapCandidate', () => {
  it('removes the worktree of a merged branch', async () => {
    const deps = reapDeps()
    const outcome = await reapCandidate(
      '/repo',
      { branch: 'chore/merged', worktreePath: '/wt/merged' },
      deps,
    )

    expect(outcome.verdict).toEqual({ action: 'reap' })
    expect(outcome.worktreeRemoved).toBe(true)
    expect(deps.git.removeWorktree).toHaveBeenCalledWith('/repo', '/wt/merged')
  })

  // #1810: the branch's PR merged, but this worktree's HEAD carries a real,
  // committed, unpushed commit on top of the commit that actually merged.
  // Before the fix, `reapCandidate` never asked for `mergedHeadSha` or
  // `headSha` at all and removed the worktree on `prVerdict === 'merged'`
  // alone — this is the exact defect the issue reproduced live.
  it('keeps and never removes a worktree with commits ahead of what its merged PR shipped', async () => {
    const deps = reapDeps({
      git: {
        headSha: vi.fn().mockResolvedValue('unpushed-follow-up-sha'),
        // The worktree's HEAD is NOT an ancestor of the merged PR's head —
        // there is a real commit on top of it.
        isAncestor: vi.fn().mockResolvedValue(false),
      },
      github: { mergedHeadSha: vi.fn().mockResolvedValue('merged-tip-sha') },
    })

    const outcome = await reapCandidate(
      '/repo',
      { branch: 'fix/1602-orphan-ratchet-divergence', worktreePath: '/wt/realname' },
      deps,
    )

    expect(outcome.verdict).toEqual({ action: 'keep', reason: 'commits-not-in-merge' })
    expect(outcome.worktreeRemoved).toBeNull()
    expect(deps.git.removeWorktree as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    expect(deps.git.isAncestor).toHaveBeenCalledWith(
      '/repo',
      'unpushed-follow-up-sha',
      'merged-tip-sha',
    )
  })

  it('keeps a merged-PR worktree, never removing it, when the merged head SHA cannot be read', async () => {
    const deps = reapDeps({ github: { mergedHeadSha: vi.fn().mockResolvedValue(null) } })

    const outcome = await reapCandidate(
      '/repo',
      { branch: 'chore/merged', worktreePath: '/wt/merged' },
      deps,
    )

    expect(outcome.verdict).toEqual({ action: 'keep', reason: 'unknown-merge-head' })
    expect(outcome.worktreeRemoved).toBeNull()
    expect(deps.git.removeWorktree as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    // No point asking merge-base to compare against a SHA we don't have.
    expect(deps.git.isAncestor as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('does not ask for a merged head SHA at all unless the PR verdict is merged', async () => {
    const deps = reapDeps({ github: { prVerdictForBranch: vi.fn().mockResolvedValue('closed') } })
    await reapCandidate('/repo', { branch: 'fix/abandoned', worktreePath: '/wt/x' }, deps)
    expect(deps.github.mergedHeadSha as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    expect(deps.git.headSha as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('keeps a worktree whose branch PR closed unmerged, and never removes it', async () => {
    const deps = reapDeps({ github: { prVerdictForBranch: vi.fn().mockResolvedValue('closed') } })

    const outcome = await reapCandidate(
      '/repo',
      { branch: 'security/undici-advisories', worktreePath: '/wt/undici' },
      deps,
    )

    expect(outcome.verdict).toEqual({ action: 'keep', reason: 'pr-closed' })
    expect(outcome.worktreeRemoved).toBeNull()
    expect(deps.git.removeWorktree as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('leaves the worktree exactly as it was when git worktree remove itself fails', async () => {
    const deps = reapDeps({ git: { removeWorktree: vi.fn().mockResolvedValue(false) } })
    const outcome = await reapCandidate(
      '/repo',
      { branch: 'chore/merged', worktreePath: '/wt/locked' },
      deps,
    )

    expect(outcome.verdict).toEqual({ action: 'reap' })
    expect(outcome.worktreeRemoved).toBe(false)
  })

  it('keeps a detached-HEAD worktree without ever asking GitHub for a verdict', async () => {
    const deps = reapDeps({ git: { currentBranch: vi.fn().mockResolvedValue('HEAD') } })
    const outcome = await reapCandidate(
      '/repo',
      { branch: 'chore/merged', worktreePath: '/wt/detached' },
      deps,
    )
    expect(outcome.verdict).toEqual({ action: 'keep', reason: 'detached-head' })
    expect(deps.github.prVerdictForBranch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('keeps a dirty worktree without ever asking GitHub for a verdict', async () => {
    const deps = reapDeps({ git: { hasUncommittedChanges: vi.fn().mockResolvedValue(true) } })
    const outcome = await reapCandidate(
      '/repo',
      { branch: 'chore/merged', worktreePath: '/wt/dirty' },
      deps,
    )
    expect(outcome.verdict).toEqual({ action: 'keep', reason: 'uncommitted-changes' })
    expect(deps.github.prVerdictForBranch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  // #1833 (replaces #1825): the worktree is clean, its branch's PR merged,
  // and its HEAD is contained in what shipped — every check `reapCandidate`
  // already applied passes. A live `.fleet-worktree-claim` lock must still
  // stop it, the same way isDetached/isDirty already do, before
  // `removeWorktree` is ever called.
  it('keeps a worktree with a live fleet-worktree-claim lock without ever asking GitHub for a verdict', async () => {
    const deps = reapDeps({ git: { hasFleetWorktreeClaim: vi.fn().mockResolvedValue(true) } })
    const outcome = await reapCandidate(
      '/repo',
      { branch: 'chore/merged', worktreePath: '/wt/claimed' },
      deps,
    )
    expect(outcome.verdict).toEqual({ action: 'keep', reason: 'fleet-worktree-claimed' })
    expect(outcome.worktreeRemoved).toBeNull()
    expect(deps.git.removeWorktree as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    expect(deps.github.prVerdictForBranch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    expect(outcome.staleClaimCleared).toBe(false)
  })

  // #1948: nothing in the estate ever releases a fleet-worktree-claim lock,
  // so treating any existing lock as permanently live made the milestone
  // above's own "keep" permanent too — this is the fix, proven the same
  // fail-first way #1810 was: a lock old enough to be abandoned no longer
  // blocks the reap, and the still-merged, still-clean, still-HEAD-current
  // worktree behind it goes on to be removed exactly as it would with no
  // lock at all.
  it('clears a stale fleet-worktree-claim lock and reaps the merged worktree behind it', async () => {
    const deps = reapDeps({
      git: {
        hasFleetWorktreeClaim: vi.fn().mockResolvedValue(true),
        fleetWorktreeClaimAgeMs: vi.fn().mockResolvedValue(FLEET_CLAIM_STALE_AFTER_MS + 1),
      },
    })

    const outcome = await reapCandidate(
      '/repo',
      { branch: 'chore/merged', worktreePath: '/wt/claimed' },
      deps,
    )

    expect(outcome.verdict).toEqual({ action: 'reap' })
    expect(outcome.worktreeRemoved).toBe(true)
    expect(outcome.staleClaimCleared).toBe(true)
    expect(deps.git.clearStaleFleetWorktreeClaim).toHaveBeenCalledWith('/wt/claimed')
    // The GitHub verdict this milestone's own safety net depends on is still
    // asked for — staleness alone never skips it.
    expect(deps.github.prVerdictForBranch).toHaveBeenCalled()
  })

  // A lock one millisecond younger than the TTL is still live — `< TTL`, not
  // `<= TTL` — and the boundary value itself is already stale (covered by
  // the "clears a stale lock" test above, which uses `+ 1`).
  it('keeps a claim just under the TTL boundary as live', async () => {
    const deps = reapDeps({
      git: {
        hasFleetWorktreeClaim: vi.fn().mockResolvedValue(true),
        fleetWorktreeClaimAgeMs: vi.fn().mockResolvedValue(FLEET_CLAIM_STALE_AFTER_MS - 1),
      },
    })

    const outcome = await reapCandidate(
      '/repo',
      { branch: 'chore/merged', worktreePath: '/wt/claimed' },
      deps,
    )

    expect(outcome.verdict).toEqual({ action: 'keep', reason: 'fleet-worktree-claimed' })
    expect(outcome.staleClaimCleared).toBe(false)
    expect(deps.git.clearStaleFleetWorktreeClaim as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  // Fail-closed (#1948): an age that cannot be determined must never be
  // treated as "old enough to be stale" — the same posture
  // `fleetWorktreeClaimAgeMs`'s own doc comment specifies, and the same
  // direction every other "cannot tell" in this module already takes
  // (`unknown-pr-verdict`, `unknown-merge-head`).
  it('treats an unreadable claim age as live, never as stale', async () => {
    const deps = reapDeps({
      git: {
        hasFleetWorktreeClaim: vi.fn().mockResolvedValue(true),
        fleetWorktreeClaimAgeMs: vi.fn().mockResolvedValue(null),
      },
    })

    const outcome = await reapCandidate(
      '/repo',
      { branch: 'chore/merged', worktreePath: '/wt/claimed' },
      deps,
    )

    expect(outcome.verdict).toEqual({ action: 'keep', reason: 'fleet-worktree-claimed' })
    expect(outcome.staleClaimCleared).toBe(false)
    expect(deps.git.clearStaleFleetWorktreeClaim as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  // A stale lock is cleared BEFORE `hasUncommittedChanges` is read (#1948):
  // otherwise the untracked `.fleet-worktree-claim` directory itself would
  // trip `git status --porcelain` and the worktree would be kept anyway,
  // under the less specific `uncommitted-changes` reason — silently
  // defeating the point of deciding the claim was stale.
  it('reads hasUncommittedChanges only after a stale claim has already been cleared', async () => {
    const callOrder: string[] = []
    const deps = reapDeps({
      git: {
        hasFleetWorktreeClaim: vi.fn().mockResolvedValue(true),
        fleetWorktreeClaimAgeMs: vi.fn().mockResolvedValue(FLEET_CLAIM_STALE_AFTER_MS + 1),
        clearStaleFleetWorktreeClaim: vi.fn().mockImplementation(async () => {
          callOrder.push('cleared')
        }),
        hasUncommittedChanges: vi.fn().mockImplementation(async () => {
          callOrder.push('checked-dirty')
          return false
        }),
      },
    })

    await reapCandidate('/repo', { branch: 'chore/merged', worktreePath: '/wt/claimed' }, deps)

    expect(callOrder).toEqual(['cleared', 'checked-dirty'])
  })
})

describe('reapAll', () => {
  const branches: BranchRef[] = [
    { name: 'chore/merged', upstream: 'refs/remotes/origin/chore/merged', track: '[gone]' },
    {
      name: 'security/undici-advisories',
      upstream: 'refs/remotes/origin/security/undici-advisories',
      track: '[gone]',
    },
    { name: 'agent/1682', upstream: 'refs/remotes/origin/agent/1682', track: '[gone]' },
  ]
  const worktrees: WorktreeFact[] = [
    { path: '/wt/merged', branch: 'chore/merged', behind: 0 },
    { path: '/wt/undici', branch: 'security/undici-advisories', behind: 0 },
  ]
  // None of these three branches' own remote copies exist any more.
  const remoteBranchNames = new Set<string>()

  it('reaps the merged one, keeps the closed-unmerged one, and never touches the current branch', async () => {
    const github = {
      prVerdictForBranch: vi.fn(async (_cwd: string, branch: string) =>
        branch === 'chore/merged' ? 'merged' : 'closed',
      ),
      mergedHeadSha: vi.fn().mockResolvedValue('merged-tip-sha'),
    }
    const git = {
      currentBranch: vi.fn().mockResolvedValue('chore/merged'),
      hasUncommittedChanges: vi.fn().mockResolvedValue(false),
      hasFleetWorktreeClaim: vi.fn().mockResolvedValue(false),
      removeWorktree: vi.fn().mockResolvedValue(true),
      // The worktree's HEAD IS what merged — no follow-up commits.
      headSha: vi.fn().mockResolvedValue('merged-tip-sha'),
      isAncestor: vi.fn().mockResolvedValue(true),
    }

    const outcomes = await reapAll(
      '/repo',
      branches,
      worktrees,
      'agent/1682',
      { git: git as never, github: github as never },
      remoteBranchNames,
    )

    // agent/1682 (the branch this session is on) never appears as a candidate,
    // even though its own upstream is [gone] too.
    expect(outcomes.map((o) => o.candidate.branch)).toEqual([
      'chore/merged',
      'security/undici-advisories',
    ])

    const merged = outcomes.find((o) => o.candidate.branch === 'chore/merged')
    expect(merged?.verdict).toEqual({ action: 'reap' })
    expect(merged?.worktreeRemoved).toBe(true)

    const undici = outcomes.find((o) => o.candidate.branch === 'security/undici-advisories')
    expect(undici?.verdict).toEqual({ action: 'keep', reason: 'pr-closed' })
    expect(undici?.worktreeRemoved).toBeNull()

    expect(git.removeWorktree).toHaveBeenCalledTimes(1)
    expect(git.removeWorktree).toHaveBeenCalledWith('/repo', '/wt/merged')
  })

  it('reports nothing to do when no worktree has a gone upstream', async () => {
    const github = { prVerdictForBranch: vi.fn() }
    const git = {
      currentBranch: vi.fn(),
      hasUncommittedChanges: vi.fn(),
      removeWorktree: vi.fn(),
    }
    const liveBranches: BranchRef[] = [
      { name: 'dev', upstream: 'refs/remotes/origin/dev', track: '' },
    ]

    const outcomes = await reapAll(
      '/repo',
      liveBranches,
      [],
      'dev',
      { git: git as never, github: github as never },
      new Set(['dev']),
    )

    expect(outcomes).toEqual([])
    expect(github.prVerdictForBranch).not.toHaveBeenCalled()
  })

  // #1954: the end-to-end proof that widening findReapCandidates to include a
  // never-pushed branch (no upstream at all) never becomes an unsafe reap —
  // GitHub's own verdict is what keeps it, not the candidate filter.
  it('asks GitHub about a clean, never-pushed branch and keeps it for no-pr, never reaps it', async () => {
    const github = {
      prVerdictForBranch: vi.fn().mockResolvedValue('none'),
      mergedHeadSha: vi.fn(),
    }
    const git = {
      currentBranch: vi.fn().mockResolvedValue('scratch/local-only'),
      hasUncommittedChanges: vi.fn().mockResolvedValue(false),
      hasFleetWorktreeClaim: vi.fn().mockResolvedValue(false),
      removeWorktree: vi.fn(),
    }
    const neverPushed: BranchRef[] = [{ name: 'scratch/local-only', upstream: '', track: '' }]
    const worktrees: WorktreeFact[] = [
      { path: '/wt/local-only', branch: 'scratch/local-only', behind: 0 },
    ]

    const outcomes = await reapAll(
      '/repo',
      neverPushed,
      worktrees,
      // Deliberately not the current branch, so the candidate is actually
      // judged rather than filtered out by the current-branch exclusion.
      'dev',
      { git: git as never, github: github as never },
      new Set(),
    )

    expect(outcomes).toEqual([
      {
        candidate: { branch: 'scratch/local-only', worktreePath: '/wt/local-only' },
        verdict: { action: 'keep', reason: 'no-pr' },
        worktreeRemoved: null,
        staleClaimCleared: false,
      },
    ])
    expect(git.removeWorktree as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })
})

// --- Milestone 2 (#1682): bare-branch deletion ------------------------------------------

describe('findBareBranchCandidates', () => {
  const branches: BranchRef[] = [
    { name: 'dev', upstream: 'refs/remotes/origin/dev', track: '' },
    { name: 'chore/merged', upstream: 'refs/remotes/origin/chore/merged', track: '[gone]' },
    { name: 'feat/live', upstream: 'refs/remotes/origin/feat/live', track: '[ahead 1]' },
    { name: 'fix/orphan-bare', upstream: 'refs/remotes/origin/fix/orphan-bare', track: '[gone]' },
  ]
  const worktrees: WorktreeFact[] = [{ path: '/wt/merged', branch: 'chore/merged', behind: 0 }]
  const remoteBranchNames = new Set(['dev', 'feat/live'])

  it('finds a proven-gone branch with no linked worktree', () => {
    const candidates = findBareBranchCandidates(branches, worktrees, remoteBranchNames)
    expect(candidates).toEqual([{ branch: 'fix/orphan-bare' }])
  })

  it('excludes a proven-gone branch that DOES have a linked worktree — that is findReapCandidates', () => {
    const candidates = findBareBranchCandidates(branches, worktrees, remoteBranchNames)
    expect(candidates.map((c) => c.branch)).not.toContain('chore/merged')
  })

  it('excludes a branch whose remote copy still exists', () => {
    const candidates = findBareBranchCandidates(branches, worktrees, remoteBranchNames)
    expect(candidates.map((c) => c.branch)).not.toContain('feat/live')
  })

  // Same deliberate inclusion as findReapCandidates's own test above — see
  // `hasProvenGoneRemote`'s doc comment.
  it('DOES include a bare branch with no upstream at all', () => {
    const neverPushed: BranchRef[] = [{ name: 'scratch/local-only', upstream: '', track: '' }]
    const candidates = findBareBranchCandidates(neverPushed, [], new Set())
    expect(candidates).toEqual([{ branch: 'scratch/local-only' }])
  })
})

/** A branch-reap deps mock defaulting to a clean, mergeable branch; override per test. */
function branchReapDeps(
  overrides: { git?: Record<string, unknown>; github?: Record<string, unknown> } = {},
): BranchReapDeps {
  return {
    git: {
      branchSha: vi.fn().mockResolvedValue('deadbeef'),
      isAncestor: vi.fn().mockResolvedValue(true),
      deleteBranch: vi.fn().mockResolvedValue(true),
      ...overrides.git,
    } as never,
    github: {
      prVerdictForBranch: vi.fn().mockResolvedValue('merged'),
      mergedHeadSha: vi.fn().mockResolvedValue('deadbeef'),
      ...overrides.github,
    } as never,
  }
}

describe('reapBareBranch', () => {
  it('deletes a bare branch whose PR merged and whose tip is contained in what merged', async () => {
    const deps = branchReapDeps()
    const outcome = await reapBareBranch('/repo', { branch: 'fix/orphan-bare' }, deps)

    expect(outcome.verdict).toEqual({ action: 'reap' })
    expect(outcome.branchDeleted).toBe(true)
    expect(deps.git.deleteBranch).toHaveBeenCalledWith('/repo', 'fix/orphan-bare')
  })

  // Same #1810 shape as the worktree case: a merged PR for this branch NAME
  // does not prove the branch's OWN current tip is what merged — a squash
  // merge means later local-only commits on the same branch are possible.
  it('keeps a bare branch whose tip carries commits ahead of what its merged PR shipped', async () => {
    const deps = branchReapDeps({
      git: {
        branchSha: vi.fn().mockResolvedValue('unpushed-follow-up-sha'),
        isAncestor: vi.fn().mockResolvedValue(false),
      },
      github: { mergedHeadSha: vi.fn().mockResolvedValue('merged-tip-sha') },
    })

    const outcome = await reapBareBranch('/repo', { branch: 'fix/orphan-bare' }, deps)

    expect(outcome.verdict).toEqual({ action: 'keep', reason: 'commits-not-in-merge' })
    expect(outcome.branchDeleted).toBeNull()
    expect(deps.git.deleteBranch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    expect(deps.git.isAncestor).toHaveBeenCalledWith(
      '/repo',
      'unpushed-follow-up-sha',
      'merged-tip-sha',
    )
  })

  it('keeps a merged-PR branch, never deleting it, when the merged head SHA cannot be read', async () => {
    const deps = branchReapDeps({ github: { mergedHeadSha: vi.fn().mockResolvedValue(null) } })
    const outcome = await reapBareBranch('/repo', { branch: 'fix/orphan-bare' }, deps)

    expect(outcome.verdict).toEqual({ action: 'keep', reason: 'unknown-merge-head' })
    expect(outcome.branchDeleted).toBeNull()
    expect(deps.git.deleteBranch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    expect(deps.git.isAncestor as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('does not ask for a merged head SHA at all unless the PR verdict is merged', async () => {
    const deps = branchReapDeps({
      github: { prVerdictForBranch: vi.fn().mockResolvedValue('closed') },
    })
    await reapBareBranch('/repo', { branch: 'fix/orphan-bare' }, deps)
    expect(deps.github.mergedHeadSha as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    expect(deps.git.branchSha as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('keeps a branch whose PR closed unmerged, and never deletes it', async () => {
    const deps = branchReapDeps({
      github: { prVerdictForBranch: vi.fn().mockResolvedValue('closed') },
    })
    const outcome = await reapBareBranch('/repo', { branch: 'security/undici-advisories' }, deps)

    expect(outcome.verdict).toEqual({ action: 'keep', reason: 'pr-closed' })
    expect(outcome.branchDeleted).toBeNull()
    expect(deps.git.deleteBranch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('keeps a branch with no PR ever, and never deletes it', async () => {
    const deps = branchReapDeps({
      github: { prVerdictForBranch: vi.fn().mockResolvedValue('none') },
    })
    const outcome = await reapBareBranch('/repo', { branch: 'batch/reconverge' }, deps)

    expect(outcome.verdict).toEqual({ action: 'keep', reason: 'no-pr' })
    expect(outcome.branchDeleted).toBeNull()
  })

  it('leaves the branch exactly as it was when git branch -D itself fails', async () => {
    const deps = branchReapDeps({ git: { deleteBranch: vi.fn().mockResolvedValue(false) } })
    const outcome = await reapBareBranch('/repo', { branch: 'fix/orphan-bare' }, deps)

    expect(outcome.verdict).toEqual({ action: 'reap' })
    expect(outcome.branchDeleted).toBe(false)
  })
})

describe('reapAllBareBranches', () => {
  const branches: BranchRef[] = [
    { name: 'fix/orphan-bare', upstream: 'refs/remotes/origin/fix/orphan-bare', track: '[gone]' },
    {
      name: 'security/undici-advisories',
      upstream: 'refs/remotes/origin/security/undici-advisories',
      track: '[gone]',
    },
    { name: 'agent/1682', upstream: 'refs/remotes/origin/agent/1682', track: '[gone]' },
  ]

  it('deletes the merged one, keeps the closed-unmerged one, and never touches the current branch', async () => {
    const github = {
      prVerdictForBranch: vi.fn(async (_cwd: string, branch: string) =>
        branch === 'fix/orphan-bare' ? 'merged' : 'closed',
      ),
      mergedHeadSha: vi.fn().mockResolvedValue('merged-tip-sha'),
    }
    const git = {
      branchSha: vi.fn().mockResolvedValue('merged-tip-sha'),
      isAncestor: vi.fn().mockResolvedValue(true),
      deleteBranch: vi.fn().mockResolvedValue(true),
    }

    const outcomes = await reapAllBareBranches(
      '/repo',
      branches,
      [],
      'agent/1682',
      { git: git as never, github: github as never },
      new Set<string>(),
    )

    // The current branch (agent/1682) never appears as a candidate, even
    // though its own upstream is [gone] too — never delete the branch this
    // session is standing on.
    expect(outcomes.map((o) => o.candidate.branch)).toEqual([
      'fix/orphan-bare',
      'security/undici-advisories',
    ])

    const merged = outcomes.find((o) => o.candidate.branch === 'fix/orphan-bare')
    expect(merged?.verdict).toEqual({ action: 'reap' })
    expect(merged?.branchDeleted).toBe(true)

    const undici = outcomes.find((o) => o.candidate.branch === 'security/undici-advisories')
    expect(undici?.verdict).toEqual({ action: 'keep', reason: 'pr-closed' })
    expect(undici?.branchDeleted).toBeNull()

    expect(git.deleteBranch).toHaveBeenCalledTimes(1)
    expect(git.deleteBranch).toHaveBeenCalledWith('/repo', 'fix/orphan-bare')
  })

  it('reports nothing to do when no bare branch has a gone upstream', async () => {
    const github = { prVerdictForBranch: vi.fn() }
    const git = { branchSha: vi.fn(), isAncestor: vi.fn(), deleteBranch: vi.fn() }
    const liveBranches: BranchRef[] = [
      { name: 'dev', upstream: 'refs/remotes/origin/dev', track: '' },
    ]

    const outcomes = await reapAllBareBranches(
      '/repo',
      liveBranches,
      [],
      'dev',
      { git: git as never, github: github as never },
      new Set(['dev']),
    )

    expect(outcomes).toEqual([])
    expect(github.prVerdictForBranch).not.toHaveBeenCalled()
  })
})
