import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitAdapter } from './index.js'
import { makeTmpDir } from '../../test-utils/tmp.js'
import { findReapCandidates, reapCandidate, type ReapDeps } from '../../lib/doctor-reaper.js'

/**
 * `GitAdapter.removeWorktree` (#1682, milestone 1), proven against real git
 * rather than a mocked subprocess — this is the one destructive call `--fix`
 * makes, so its refusal behaviour needs to be real, not asserted.
 */
describe('GitAdapter.removeWorktree (#1682)', () => {
  let repo: string
  let worktreeDir: string
  const adapter = new GitAdapter()

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

  beforeEach(() => {
    repo = makeTmpDir('biffo-reap-primary')
    git(repo, 'init', '-q', '-b', 'dev')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    writeFileSync(join(repo, 'a.txt'), 'base\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'base')
    worktreeDir = join(repo, '.worktrees', 'reap-me')
    git(repo, 'worktree', 'add', worktreeDir, '-b', 'chore/reap-me')
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('removes a clean linked worktree', async () => {
    expect(await adapter.removeWorktree(repo, worktreeDir)).toBe(true)
    expect(existsSync(worktreeDir)).toBe(false)
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(worktreeDir)
  })

  it('refuses (rather than forcing past) a worktree with uncommitted changes', async () => {
    writeFileSync(join(worktreeDir, 'a.txt'), 'dirty\n')

    expect(await adapter.removeWorktree(repo, worktreeDir)).toBe(false)
    // Left exactly as it was — not force-removed, no data lost.
    expect(existsSync(worktreeDir)).toBe(true)
  })
})

/**
 * `reapCandidate` against a REAL repo, REAL worktree and REAL commits —
 * #1810's own reproduction shape, without stubbing anything git-side. Only
 * the GitHub half is faked (there is no live PR to ask about in a disposable
 * local repo), via a minimal object satisfying `ReapDeps['github']` that
 * reports the branch as merged with a specific, known `headRefOid` — exactly
 * what `GithubCliAdapter.prVerdictForBranch` / `mergedHeadSha` would report
 * for a real merged PR.
 *
 * Everything that decides whether the worktree survives — `git rev-parse
 * HEAD`, `git merge-base --is-ancestor`, `git worktree remove` — runs for
 * real, through the real `GitAdapter`, against a real `.git`.
 */
describe('reapCandidate: worktree HEAD vs. what actually merged (#1810)', () => {
  let repo: string
  let worktreeDir: string
  const adapter = new GitAdapter()

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

  /** A github stub reporting `branch` merged, with `mergedHeadSha` as its shipped tip. */
  function githubStub(mergedHeadSha: string | null): ReapDeps['github'] {
    return {
      prVerdictForBranch: async () => 'merged',
      mergedHeadSha: async () => mergedHeadSha,
    }
  }

  beforeEach(() => {
    repo = makeTmpDir('biffo-reap-merge-head')
    git(repo, 'init', '-q', '-b', 'dev')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    writeFileSync(join(repo, 'a.txt'), 'base\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'base')
    worktreeDir = join(repo, '.worktrees', 'realname')
    git(repo, 'worktree', 'add', worktreeDir, '-b', 'fix/1602-orphan-ratchet-divergence')
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  // Fail-first: this is the exact defect #1810 reported, reproduced live.
  // A branch whose PR merged (per the GitHub verdict) has a worktree whose
  // CURRENT HEAD carries a real, committed, unpushed follow-up commit on
  // top of the commit that actually merged. The classifier must keep it —
  // before #1810's fix, `reapCandidate` never looked past `prVerdict ===
  // 'merged'` and deleted the worktree (and the file inside it) outright.
  it('keeps a worktree, and its unique file, that has a real commit ahead of what its PR merged', async () => {
    // The commit that "merged" — captured before any follow-up work.
    const mergedHeadSha = git(worktreeDir, 'rev-parse', 'HEAD')

    // Real, committed, unpushed follow-up work — exactly #1810's repro:
    // "an agent that kept working post-merge".
    writeFileSync(
      join(worktreeDir, 'UNIQUE_LOCAL_WORK.txt'),
      'irreplaceable local work not yet pushed anywhere\n',
    )
    git(worktreeDir, 'add', '-A')
    git(worktreeDir, 'commit', '-qm', 'local-only follow-up work, never pushed')

    const deps: ReapDeps = { git: adapter, github: githubStub(mergedHeadSha) }
    const outcome = await reapCandidate(
      repo,
      { branch: 'fix/1602-orphan-ratchet-divergence', worktreePath: worktreeDir },
      deps,
    )

    expect(outcome.verdict).toEqual({ action: 'keep', reason: 'commits-not-in-merge' })
    expect(outcome.worktreeRemoved).toBeNull()

    // The worktree — and the unique file inside it — must still be on disk.
    expect(existsSync(worktreeDir)).toBe(true)
    expect(readFileSync(join(worktreeDir, 'UNIQUE_LOCAL_WORK.txt'), 'utf8')).toContain(
      'irreplaceable local work',
    )
  })

  it('reaps a worktree whose HEAD is exactly the commit that merged — no follow-up commits', async () => {
    const mergedHeadSha = git(worktreeDir, 'rev-parse', 'HEAD')

    const deps: ReapDeps = { git: adapter, github: githubStub(mergedHeadSha) }
    const outcome = await reapCandidate(
      repo,
      { branch: 'fix/1602-orphan-ratchet-divergence', worktreePath: worktreeDir },
      deps,
    )

    expect(outcome.verdict).toEqual({ action: 'reap' })
    expect(outcome.worktreeRemoved).toBe(true)
    expect(existsSync(worktreeDir)).toBe(false)
  })

  it('reaps a worktree whose HEAD is BEHIND what merged — it never got the branch tip locally, but nothing is ahead', async () => {
    // Simulate: the PR's actual final push added a commit this worktree
    // never pulled. The worktree's HEAD is an ancestor of what merged, so it
    // holds nothing unique — safe.
    const behindSha = git(worktreeDir, 'rev-parse', 'HEAD')
    writeFileSync(join(worktreeDir, 'b.txt'), 'final push before merge\n')
    git(worktreeDir, 'add', '-A')
    git(worktreeDir, 'commit', '-qm', 'the actual final commit that merged')
    const mergedHeadSha = git(worktreeDir, 'rev-parse', 'HEAD')
    // Roll the worktree back to before that final push, without touching history.
    git(worktreeDir, 'reset', '-q', '--hard', behindSha)

    const deps: ReapDeps = { git: adapter, github: githubStub(mergedHeadSha) }
    const outcome = await reapCandidate(
      repo,
      { branch: 'fix/1602-orphan-ratchet-divergence', worktreePath: worktreeDir },
      deps,
    )

    expect(outcome.verdict).toEqual({ action: 'reap' })
    expect(outcome.worktreeRemoved).toBe(true)
  })

  it('keeps the worktree when the merged head SHA cannot be read from GitHub at all', async () => {
    writeFileSync(join(worktreeDir, 'c.txt'), 'more local work\n')
    git(worktreeDir, 'add', '-A')
    git(worktreeDir, 'commit', '-qm', 'local work, and GitHub lookup fails this time')

    const deps: ReapDeps = { git: adapter, github: githubStub(null) }
    const outcome = await reapCandidate(
      repo,
      { branch: 'fix/1602-orphan-ratchet-divergence', worktreePath: worktreeDir },
      deps,
    )

    expect(outcome.verdict).toEqual({ action: 'keep', reason: 'unknown-merge-head' })
    expect(outcome.worktreeRemoved).toBeNull()
    expect(existsSync(worktreeDir)).toBe(true)
  })
})

/**
 * #1833 (replaces #1825): the fleet's own `.fleet-worktree-claim` lock
 * directory, checked for real — no mocked filesystem, no mocked `GitAdapter`
 * method. `bin/fleet.sh worktree-claim` (biffo-fleet, a different repo) is
 * what actually writes this directory; this repo only needs to prove it
 * reads the directory's existence correctly, which is the filesystem fact
 * #1833's own routing note says this repo is allowed to depend on.
 */
describe('reapCandidate: a live fleet-worktree-claim lock stops the reap (#1833)', () => {
  let repo: string
  let worktreeDir: string
  const adapter = new GitAdapter()

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

  const githubStub: ReapDeps['github'] = {
    prVerdictForBranch: async () => 'merged',
    // Set per-test to the worktree's own HEAD once it exists.
    mergedHeadSha: async () => null,
  }

  beforeEach(() => {
    repo = makeTmpDir('biffo-reap-fleet-claim')
    git(repo, 'init', '-q', '-b', 'dev')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    writeFileSync(join(repo, 'a.txt'), 'base\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'base')
    worktreeDir = join(repo, '.worktrees', 'claimed')
    git(repo, 'worktree', 'add', worktreeDir, '-b', 'agent/1833-claimed')
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('reports true from a real lock directory on disk', async () => {
    mkdirSync(join(worktreeDir, '.fleet-worktree-claim'))
    expect(await adapter.hasFleetWorktreeClaim(worktreeDir)).toBe(true)
  })

  it('reports false when no lock directory exists', async () => {
    expect(await adapter.hasFleetWorktreeClaim(worktreeDir)).toBe(false)
  })

  // Fail-first shape, proven end to end: a worktree that is clean, whose
  // branch's PR merged, and whose HEAD is exactly what merged — every check
  // `reapCandidate` already applied says "safe" — must still be kept because
  // a live session holds it via the fleet's own lock.
  it('keeps and never removes a worktree that is clean, merged, and HEAD-current, when a real fleet lock is present', async () => {
    const mergedHeadSha = git(worktreeDir, 'rev-parse', 'HEAD')
    mkdirSync(join(worktreeDir, '.fleet-worktree-claim'))
    // A FRESH timestamp, not a hardcoded past date (#1948): this test's own
    // job is to prove a LIVE lock still blocks the reap, and a claim old
    // enough to cross `FLEET_CLAIM_STALE_AFTER_MS` is exactly what this fix
    // now treats as abandoned instead — proven by the age-aware tests below.
    writeFileSync(
      join(worktreeDir, '.fleet-worktree-claim', 'holder'),
      `some-other-session-0831-abcd\n${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}\n`,
    )

    const deps: ReapDeps = {
      git: adapter,
      github: { ...githubStub, mergedHeadSha: async () => mergedHeadSha },
    }
    const outcome = await reapCandidate(
      repo,
      { branch: 'agent/1833-claimed', worktreePath: worktreeDir },
      deps,
    )

    expect(outcome.verdict).toEqual({ action: 'keep', reason: 'fleet-worktree-claimed' })
    expect(outcome.worktreeRemoved).toBeNull()
    expect(existsSync(worktreeDir)).toBe(true)
  })
})

/**
 * `GitAdapter.fleetWorktreeClaimAgeMs` / `clearStaleFleetWorktreeClaim`
 * (biffo-template#1948), proven against a real lock directory and a real
 * `reapCandidate` run — the same "no mocked filesystem" posture the describe
 * block above takes, for the same reason: `bin/fleet.sh worktree-claim` is a
 * different repo's shell script, so this repo can only prove it reads and
 * clears the directory it writes correctly, never that the script itself
 * behaves a particular way.
 */
describe('GitAdapter.fleetWorktreeClaimAgeMs / clearStaleFleetWorktreeClaim (#1948)', () => {
  let repo: string
  let worktreeDir: string
  const adapter = new GitAdapter()

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

  const githubStub: ReapDeps['github'] = {
    prVerdictForBranch: async () => 'merged',
    mergedHeadSha: async () => null,
  }

  beforeEach(() => {
    repo = makeTmpDir('biffo-reap-fleet-claim-age')
    git(repo, 'init', '-q', '-b', 'dev')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    writeFileSync(join(repo, 'a.txt'), 'base\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'base')
    worktreeDir = join(repo, '.worktrees', 'claimed')
    git(repo, 'worktree', 'add', worktreeDir, '-b', 'agent/1948-claimed')
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns null when no lock exists', async () => {
    expect(await adapter.fleetWorktreeClaimAgeMs(worktreeDir)).toBeNull()
  })

  it('returns null when the lock directory exists but the holder file does not (the unwritten-holder window)', async () => {
    mkdirSync(join(worktreeDir, '.fleet-worktree-claim'))
    expect(await adapter.fleetWorktreeClaimAgeMs(worktreeDir)).toBeNull()
  })

  it('returns a small positive age for a lock claimed moments ago', async () => {
    mkdirSync(join(worktreeDir, '.fleet-worktree-claim'))
    writeFileSync(
      join(worktreeDir, '.fleet-worktree-claim', 'holder'),
      `session-a\n${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}\n`,
    )
    const ageMs = await adapter.fleetWorktreeClaimAgeMs(worktreeDir)
    expect(ageMs).not.toBeNull()
    expect(ageMs as number).toBeGreaterThanOrEqual(0)
    expect(ageMs as number).toBeLessThan(60_000)
  })

  it('clearStaleFleetWorktreeClaim removes the lock directory outright', async () => {
    mkdirSync(join(worktreeDir, '.fleet-worktree-claim'))
    writeFileSync(
      join(worktreeDir, '.fleet-worktree-claim', 'holder'),
      'session-a\n2020-01-01T00:00:00Z\n',
    )

    await adapter.clearStaleFleetWorktreeClaim(worktreeDir)

    expect(existsSync(join(worktreeDir, '.fleet-worktree-claim'))).toBe(false)
    // The worktree itself is untouched — only the lock is cleared.
    expect(existsSync(worktreeDir)).toBe(true)
  })

  it('clearStaleFleetWorktreeClaim is a harmless no-op when there is nothing to clear', async () => {
    await expect(adapter.clearStaleFleetWorktreeClaim(worktreeDir)).resolves.toBeUndefined()
  })

  // End to end, real filesystem, real git: an abandoned lock (2020 — far
  // past FLEET_CLAIM_STALE_AFTER_MS) no longer blocks a merged, clean,
  // HEAD-current worktree from being reaped, and the lock is gone along with
  // the rest of the worktree.
  it('reaps a merged worktree behind an abandoned lock, clearing the lock first', async () => {
    const mergedHeadSha = git(worktreeDir, 'rev-parse', 'HEAD')
    mkdirSync(join(worktreeDir, '.fleet-worktree-claim'))
    writeFileSync(
      join(worktreeDir, '.fleet-worktree-claim', 'holder'),
      'abandoned-session-0101\n2020-01-01T00:00:00Z\n',
    )

    const deps: ReapDeps = {
      git: adapter,
      github: { ...githubStub, mergedHeadSha: async () => mergedHeadSha },
    }
    const outcome = await reapCandidate(
      repo,
      { branch: 'agent/1948-claimed', worktreePath: worktreeDir },
      deps,
    )

    expect(outcome.verdict).toEqual({ action: 'reap' })
    expect(outcome.worktreeRemoved).toBe(true)
    expect(outcome.staleClaimCleared).toBe(true)
    expect(existsSync(worktreeDir)).toBe(false)
  })
})

/**
 * `GitAdapter.listRemoteBranchNames` / `hasProvenGoneRemote` (biffo-template#1954),
 * proven against a real bare remote — the defect this closes is entirely a
 * property of git's own bookkeeping (`%(upstream:track)` reads `[gone]` only
 * for the ref the branch is actually CONFIGURED to track), so it has to be
 * reproduced with real `git worktree add`, a real push, and a real branch
 * deletion on a real remote, not asserted against a hand-built `BranchRef`.
 */
describe('GitAdapter.listRemoteBranchNames / mistracked-upstream reap (#1954)', () => {
  let remote: string
  let work: string
  let worktreeDir: string
  const adapter = new GitAdapter()

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

  beforeEach(() => {
    remote = makeTmpDir('biffo-mistrack-remote')
    work = makeTmpDir('biffo-mistrack-work')
    git(remote, 'init', '--bare', '-q', '-b', 'dev')
    git(work, 'init', '-q', '-b', 'dev')
    git(work, 'config', 'user.email', 'test@example.com')
    git(work, 'config', 'user.name', 'Test')
    writeFileSync(join(work, 'a.txt'), 'base\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-qm', 'base')
    git(work, 'remote', 'add', 'origin', remote)
    git(work, 'push', '-qu', 'origin', 'dev')

    // The exact shape AGENTS.md §1 documents: `git worktree add -b <branch>
    // <path> origin/dev` — which sets the new branch's upstream to
    // origin/dev by default, regardless of this host's own
    // push.autoSetupRemote setting.
    worktreeDir = join(work, '.worktrees', 'agent-1900')
    git(work, 'worktree', 'add', worktreeDir, '-b', 'agent/1900', 'origin/dev')
  })
  afterEach(() => {
    rmSync(remote, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  })

  it('excludes a branch name with a live same-named remote ref', async () => {
    git(worktreeDir, 'push', '-q', 'origin', 'agent/1900:agent/1900')
    const names = await adapter.listRemoteBranchNames(work)
    expect(names.has('agent/1900')).toBe(true)
  })

  it('excludes the HEAD symref from the result', async () => {
    const names = await adapter.listRemoteBranchNames(work)
    expect(names.has('HEAD')).toBe(false)
  })

  // The reproduction: push the branch under its own name (so it genuinely
  // existed on the remote), force its upstream to origin/dev regardless of
  // what the push itself set — deterministic proof of the mistracked shape
  // independent of this host's push.autoSetupRemote — then delete the
  // remote copy and prune. `git branch -vv` must NOT read `[gone]`, and
  // `listRemoteBranchNames` must NOT list `agent/1900`.
  it('reports a branch absent once its own remote copy is deleted, even though it is configured to track origin/dev', async () => {
    git(worktreeDir, 'push', '-q', 'origin', 'agent/1900:agent/1900')
    git(worktreeDir, 'branch', '--set-upstream-to=origin/dev', 'agent/1900')
    git(remote, 'branch', '-D', 'agent/1900')
    git(work, 'fetch', '-q', '--prune', 'origin')

    const trackLine = git(
      work,
      'for-each-ref',
      '--format=%(upstream:track)',
      'refs/heads/agent/1900',
    )
    expect(trackLine).not.toContain('gone')

    const names = await adapter.listRemoteBranchNames(work)
    expect(names.has('agent/1900')).toBe(false)
  })

  // End to end: doctor --fix reaps this worktree even though its own
  // `%(upstream:track)` never reads `[gone]` — proving the fix, not just the
  // underlying git fact.
  it('reaps a merged worktree mistracking origin/dev, once its own remote copy is deleted', async () => {
    git(worktreeDir, 'push', '-q', 'origin', 'agent/1900:agent/1900')
    git(worktreeDir, 'branch', '--set-upstream-to=origin/dev', 'agent/1900')
    const mergedHeadSha = git(worktreeDir, 'rev-parse', 'HEAD')
    git(remote, 'branch', '-D', 'agent/1900')
    git(work, 'fetch', '-q', '--prune', 'origin')

    const branches = await adapter.listBranchRefs(work)
    const worktrees = await adapter.listWorktrees(work)
    const remoteBranchNames = await adapter.listRemoteBranchNames(work)

    const candidates = findReapCandidates(branches, worktrees, remoteBranchNames)
    expect(candidates.map((c) => c.branch)).toContain('agent/1900')

    const deps: ReapDeps = {
      git: adapter,
      github: {
        prVerdictForBranch: async () => 'merged',
        mergedHeadSha: async () => mergedHeadSha,
      },
    }
    const outcome = await reapCandidate(
      work,
      { branch: 'agent/1900', worktreePath: worktreeDir },
      deps,
    )

    expect(outcome.verdict).toEqual({ action: 'reap' })
    expect(outcome.worktreeRemoved).toBe(true)
    expect(existsSync(worktreeDir)).toBe(false)
  })

  // The negative control this whole fix hinges on: a branch never pushed
  // under its own name at all must NOT be treated as proven-gone, even
  // though it is equally absent from `listRemoteBranchNames`.
  // agent/1900 here has upstream=origin/dev and was never pushed under its
  // own name at all. It IS a candidate — see `hasProvenGoneRemote`'s doc
  // comment for why that is deliberate — proven safe end to end: GitHub
  // reports no PR for it, and `reapCandidate` keeps it, never removing the
  // worktree.
  it('includes an unpushed branch as a candidate, and reapCandidate still never removes it', async () => {
    const branches = await adapter.listBranchRefs(work)
    const worktrees = await adapter.listWorktrees(work)
    const remoteBranchNames = await adapter.listRemoteBranchNames(work)

    const candidates = findReapCandidates(branches, worktrees, remoteBranchNames)
    expect(candidates.map((c) => c.branch)).toContain('agent/1900')

    const deps: ReapDeps = {
      git: adapter,
      github: { prVerdictForBranch: async () => 'none', mergedHeadSha: async () => null },
    }
    const outcome = await reapCandidate(
      work,
      { branch: 'agent/1900', worktreePath: worktreeDir },
      deps,
    )

    expect(outcome.verdict).toEqual({ action: 'keep', reason: 'no-pr' })
    expect(outcome.worktreeRemoved).toBeNull()
    expect(existsSync(worktreeDir)).toBe(true)
  })
})
