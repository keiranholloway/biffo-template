import { describe, expect, it, vi } from 'vitest'
import {
  classifyReapCandidate,
  findReapCandidates,
  reapAll,
  reapCandidate,
  type ReapCandidateFacts,
  type ReapDeps,
} from './doctor-reaper.js'
import type { BranchRef } from './upgrade-branch-reaper.js'
import type { WorktreeFact } from './doctor.js'

/** A safe starting point for classifyReapCandidate's facts; override per test. */
function facts(overrides: Partial<ReapCandidateFacts> = {}): ReapCandidateFacts {
  return { isDetached: false, isDirty: false, prVerdict: 'merged', ...overrides }
}

describe('classifyReapCandidate', () => {
  // The must-catch / must-NOT-catch table from the module doc, one row per
  // test — this IS the specification `--fix` acts on.

  it('reaps a worktree whose branch PR merged', () => {
    expect(classifyReapCandidate(facts({ prVerdict: 'merged' }))).toEqual({ action: 'reap' })
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

  it('only considers worktrees whose branch has a gone upstream', () => {
    const candidates = findReapCandidates(branches, worktrees)
    expect(candidates).toEqual([{ branch: 'chore/merged', worktreePath: '/wt/merged' }])
  })

  it('excludes a [gone] branch with no worktree — bare-branch reaping is milestone 2', () => {
    const candidates = findReapCandidates(branches, worktrees)
    expect(candidates.map((c) => c.branch)).not.toContain('fix/orphan-bare')
  })

  it('excludes a worktree with a live (not gone) upstream — no verdict to ask for', () => {
    const candidates = findReapCandidates(branches, worktrees)
    expect(candidates.map((c) => c.branch)).not.toContain('feat/live')
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
      removeWorktree: vi.fn().mockResolvedValue(true),
      ...overrides.git,
    } as never,
    github: {
      prVerdictForBranch: vi.fn().mockResolvedValue('merged'),
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

  it('reaps the merged one, keeps the closed-unmerged one, and never touches the current branch', async () => {
    const github = {
      prVerdictForBranch: vi.fn(async (_cwd: string, branch: string) =>
        branch === 'chore/merged' ? 'merged' : 'closed',
      ),
    }
    const git = {
      currentBranch: vi.fn().mockResolvedValue('chore/merged'),
      hasUncommittedChanges: vi.fn().mockResolvedValue(false),
      removeWorktree: vi.fn().mockResolvedValue(true),
    }

    const outcomes = await reapAll('/repo', branches, worktrees, 'agent/1682', {
      git: git as never,
      github: github as never,
    })

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

    const outcomes = await reapAll('/repo', liveBranches, [], 'dev', {
      git: git as never,
      github: github as never,
    })

    expect(outcomes).toEqual([])
    expect(github.prVerdictForBranch).not.toHaveBeenCalled()
  })
})
