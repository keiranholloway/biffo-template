import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reapBareBranch, type BranchReapDeps } from '../../lib/doctor-reaper.js'
import { makeTmpDir } from '../../test-utils/tmp.js'
import { GitAdapter } from './index.js'

/**
 * `GitAdapter.branchSha` and `reapBareBranch` (#1682, milestone 2), proven
 * against real git rather than a mocked subprocess — same discipline as
 * `doctor-reaper.integration.test.ts`'s worktree coverage. A bare branch has
 * no worktree of its own, so `branchSha` resolves the branch's tip by name
 * rather than by `rev-parse HEAD` in a checked-out directory — this is the
 * one piece that cannot be proven by a unit test with a mocked `execa`.
 */
describe('reapBareBranch: branch tip vs. what actually merged (#1810, bare-branch shape)', () => {
  let repo: string
  const adapter = new GitAdapter()

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

  /** A github stub reporting `branch` merged, with `mergedHeadSha` as its shipped tip. */
  function githubStub(mergedHeadSha: string | null): BranchReapDeps['github'] {
    return {
      prVerdictForBranch: async () => 'merged',
      mergedHeadSha: async () => mergedHeadSha,
    }
  }

  beforeEach(() => {
    repo = makeTmpDir('biffo-reap-bare-branch')
    git(repo, 'init', '-q', '-b', 'dev')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    writeFileSync(join(repo, 'a.txt'), 'base\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'base')
    // A bare branch: created, but never checked out into a worktree — the
    // exact shape `findBareBranchCandidates` targets.
    git(repo, 'branch', 'fix/orphan-bare')
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('deletes a bare branch whose tip is exactly the commit that merged', async () => {
    const mergedHeadSha = git(repo, 'rev-parse', 'fix/orphan-bare')

    const deps: BranchReapDeps = { git: adapter, github: githubStub(mergedHeadSha) }
    const outcome = await reapBareBranch(repo, { branch: 'fix/orphan-bare' }, deps)

    expect(outcome.verdict).toEqual({ action: 'reap' })
    expect(outcome.branchDeleted).toBe(true)
    expect(git(repo, 'branch', '--list', 'fix/orphan-bare')).toBe('')
  })

  // Fail-first shape, mirrored from the worktree case (#1810): the branch's
  // PR merged, but real, committed work landed on this branch AFTER that —
  // e.g. a session pushed a follow-up fixup that was never itself opened as
  // (or included in) a PR. Deleting the branch would silently discard it.
  it('keeps a bare branch with a real commit ahead of what its merged PR shipped', async () => {
    const mergedHeadSha = git(repo, 'rev-parse', 'fix/orphan-bare')

    // Commit directly onto the branch without checking it out, so the repo
    // stays on `dev` throughout — exercising exactly the no-worktree path.
    const followUpSha = git(
      repo,
      'commit-tree',
      `${mergedHeadSha}^{tree}`,
      '-p',
      mergedHeadSha,
      '-m',
      'local-only follow-up work, never pushed',
    )
    git(repo, 'branch', '-f', 'fix/orphan-bare', followUpSha)

    const deps: BranchReapDeps = { git: adapter, github: githubStub(mergedHeadSha) }
    const outcome = await reapBareBranch(repo, { branch: 'fix/orphan-bare' }, deps)

    expect(outcome.verdict).toEqual({ action: 'keep', reason: 'commits-not-in-merge' })
    expect(outcome.branchDeleted).toBeNull()
    // Still there, still pointing at the follow-up work.
    expect(git(repo, 'rev-parse', 'fix/orphan-bare')).toBe(followUpSha)
  })

  it('keeps the branch when the merged head SHA cannot be read from GitHub at all', async () => {
    const deps: BranchReapDeps = { git: adapter, github: githubStub(null) }
    const outcome = await reapBareBranch(repo, { branch: 'fix/orphan-bare' }, deps)

    expect(outcome.verdict).toEqual({ action: 'keep', reason: 'unknown-merge-head' })
    expect(outcome.branchDeleted).toBeNull()
    expect(git(repo, 'branch', '--list', 'fix/orphan-bare')).not.toBe('')
  })
})
