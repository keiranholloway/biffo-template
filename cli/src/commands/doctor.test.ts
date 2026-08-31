import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  gatherRepoFacts,
  printBranchReapOutcomes,
  printReapOutcomes,
  runDoctor,
  runDoctorFix,
  runDoctorFixBranches,
} from './doctor.js'
import type { BareBranchReapOutcome, ReapOutcome } from '../lib/doctor-reaper.js'
import { capturedOutput } from '../test-utils/console.js'
import { makeTmpDir } from '../test-utils/tmp.js'

vi.mock('../lib/logger.js', () => ({
  log: { step: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

let cwd: string

beforeEach(() => {
  cwd = makeTmpDir('biffo-doctor')
})
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

/** A git adapter reporting a healthy repo; override per test. */
function gitMock(overrides: Record<string, unknown> = {}) {
  return {
    isGitRepo: vi.fn().mockResolvedValue(true),
    currentBranch: vi.fn().mockResolvedValue('dev'),
    isPrimaryWorktree: vi.fn().mockResolvedValue(true),
    hasUncommittedChanges: vi.fn().mockResolvedValue(false),
    fetchPrune: vi.fn().mockResolvedValue(undefined),
    aheadBehind: vi.fn().mockResolvedValue({ ahead: 0, behind: 0, hasUpstream: true }),
    listBranchRefs: vi.fn().mockResolvedValue([]),
    listWorktrees: vi.fn().mockResolvedValue([]),
    countBehind: vi.fn().mockResolvedValue(0),
    showFileAtRef: vi.fn().mockResolvedValue(null),
    removeWorktree: vi.fn().mockResolvedValue(true),
    // #1810: defaults model the safe case — the worktree's HEAD IS the
    // commit the merged PR shipped (self-is-ancestor-of-self).
    headSha: vi.fn().mockResolvedValue('merged-tip-sha'),
    isAncestor: vi.fn().mockResolvedValue(true),
    // Milestone 2 (#1682): same safe-case default, for the bare-branch path.
    branchSha: vi.fn().mockResolvedValue('merged-tip-sha'),
    deleteBranch: vi.fn().mockResolvedValue(true),
    ...overrides,
  }
}

/** A github adapter reporting every branch as merged; override per test. */
function githubMock(overrides: Record<string, unknown> = {}) {
  return {
    prVerdictForBranch: vi.fn().mockResolvedValue('merged'),
    mergedHeadSha: vi.fn().mockResolvedValue('merged-tip-sha'),
    ...overrides,
  }
}

const checks = (fs: { check: string }[]): string[] => fs.map((f) => f.check)

describe('runDoctor', () => {
  it('reports nothing for a healthy checkout', async () => {
    const found = await runDoctor({ cwd, fetch: true }, { git: gitMock() as never })
    expect(found).toEqual([])
  })

  it('refuses a directory that is not a git repo', async () => {
    await expect(
      runDoctor(
        { cwd, fetch: true },
        { git: gitMock({ isGitRepo: vi.fn().mockResolvedValue(false) }) as never },
      ),
    ).rejects.toThrow(/not a git repository/)
  })

  it('prunes before judging, or a merged branch never reports as gone', async () => {
    // Without --prune the remote-tracking ref survives, `[gone]` never appears,
    // and the branch and worktree checks silently find nothing.
    const git = gitMock()
    await runDoctor({ cwd, fetch: true }, { git: git as never })
    expect(git.fetchPrune).toHaveBeenCalledWith(cwd)
  })

  it('skips the fetch when asked, for offline use', async () => {
    const git = gitMock()
    await runDoctor({ cwd, fetch: false }, { git: git as never })
    expect(git.fetchPrune).not.toHaveBeenCalled()
  })

  it('compares the recorded core version against the integration branch', async () => {
    writeFileSync(join(cwd, 'biffo.core.json'), JSON.stringify({ version: '0.153.2' }))
    const git = gitMock({
      showFileAtRef: vi.fn().mockResolvedValue(JSON.stringify({ version: '0.157.3' })),
    })

    const found = await runDoctor({ cwd, fetch: true }, { git: git as never })

    expect(checks(found)).toContain('core-version-stale')
    expect(git.showFileAtRef).toHaveBeenCalledWith(cwd, 'origin/dev', 'biffo.core.json')
  })

  it('notices real drift a shared decoder would paper over (#1544, class #1362 instance 11 shape)', async () => {
    // checkCoreVersionCurrency's two facts used to be decoded through the
    // SAME parseCoreRecord() JSON.parse helper before ever being compared —
    // a fault in that one decoder mangles both reads identically, and the
    // comparison agrees over data it never actually verified.
    //
    // This is not a hypothetical: JSON.parse's own spec-mandated behaviour on
    // a document with a duplicate key is to keep whichever occurs LAST,
    // silently discarding the first. A biffo.core.json corrupted with two
    // `version` keys (a bad merge, an interrupted rewrite) is genuinely
    // ambiguous — the file disagrees with itself — but the shared decoder
    // resolves it to "0.157.3" here, which happens to equal the remote. A
    // guard that decodes local and remote through the identical JSON.parse
    // step cannot distinguish that from a genuinely current checkout: it
    // reports no finding over a record that was never trustworthy to begin
    // with. A test that only fed the happy path (one clean version string
    // through one decoder) could never tell "the versions genuinely match"
    // from "the decoder mangled two documents into agreement" — this one
    // does, by giving the decoder something it demonstrably mangles.
    writeFileSync(join(cwd, 'biffo.core.json'), '{"version": "0.153.2", "version": "0.157.3"}')
    const git = gitMock({
      showFileAtRef: vi.fn().mockResolvedValue(JSON.stringify({ version: '0.157.3' })),
    })

    const found = await runDoctor({ cwd, fetch: true }, { git: git as never })

    expect(checks(found)).toContain('core-version-stale')
  })

  it('reads biffo.core.json directly, so the fossil is not compared against itself', async () => {
    // readInstanceCoreVersion falls back to core.version when the record is
    // absent. Using it here would make the fossil check compare a value to
    // itself and never fire — the exact conflation this command surfaces.
    writeFileSync(join(cwd, 'core.version'), '0.41.17\n')
    const git = gitMock()

    const found = await runDoctor({ cwd, fetch: true }, { git: git as never })

    // No biffo.core.json, so there is no authority to disagree with — and
    // crucially no finding invented from the fossil alone.
    expect(checks(found)).not.toContain('fossil-core-version')
  })

  it('flags a fossil core.version that disagrees with the authority', async () => {
    writeFileSync(join(cwd, 'biffo.core.json'), JSON.stringify({ version: '0.155.0' }))
    writeFileSync(join(cwd, 'core.version'), '0.41.17\n')

    const found = await runDoctor({ cwd, fetch: true }, { git: gitMock() as never })

    expect(checks(found)).toContain('fossil-core-version')
  })

  it('measures each worktree against the integration branch', async () => {
    const git = gitMock({
      listWorktrees: vi.fn().mockResolvedValue([{ path: '/wt/old', branch: 'feat/old' }]),
      countBehind: vi.fn().mockResolvedValue(400),
    })

    const found = await runDoctor({ cwd, fetch: true }, { git: git as never })

    expect(git.countBehind).toHaveBeenCalledWith(cwd, 'feat/old', 'origin/dev')
    expect(checks(found)).toContain('worktree-stale')
  })

  it('survives a malformed biffo.core.json rather than throwing mid-report', async () => {
    // A diagnostic that dies on the thing it is diagnosing is useless.
    writeFileSync(join(cwd, 'biffo.core.json'), '{ not json')
    const found = await runDoctor({ cwd, fetch: true }, { git: gitMock() as never })
    expect(checks(found)).not.toContain('core-version-stale')
  })

  it('asks git whether this is the primary, rather than assuming', async () => {
    const git = gitMock({
      isPrimaryWorktree: vi.fn().mockResolvedValue(false),
      currentBranch: vi.fn().mockResolvedValue('feat/in-a-worktree'),
    })

    const found = await runDoctor({ cwd, fetch: true }, { git: git as never })

    expect(git.isPrimaryWorktree).toHaveBeenCalledWith(cwd)
    expect(checks(found)).not.toContain('checkout-off-integration')
  })

  it('reports the full 2026-07-28 shape end to end', async () => {
    writeFileSync(join(cwd, 'biffo.core.json'), JSON.stringify({ version: '0.153.2' }))
    writeFileSync(join(cwd, 'core.version'), '0.41.17\n')
    mkdirSync(join(cwd, '.worktrees'), { recursive: true })

    const git = gitMock({
      currentBranch: vi.fn().mockResolvedValue('biffo/core-upgrade-0.133.3-to-0.136.0'),
      aheadBehind: vi.fn().mockResolvedValue({ ahead: 0, behind: 10, hasUpstream: true }),
      showFileAtRef: vi.fn().mockResolvedValue(JSON.stringify({ version: '0.157.3' })),
      listBranchRefs: vi
        .fn()
        .mockResolvedValue([
          { name: 'chore/merged', upstream: 'refs/remotes/origin/chore/merged', track: '[gone]' },
        ]),
      listWorktrees: vi.fn().mockResolvedValue([{ path: '/wt/ancient', branch: 'feat/ancient' }]),
      countBehind: vi.fn().mockResolvedValue(300),
    })

    const found = await runDoctor({ cwd, fetch: true }, { git: git as never })

    expect(checks(found)).toEqual([
      'checkout-off-integration',
      'checkout-behind',
      'core-version-stale',
      'fossil-core-version',
      'stale-branches',
      'worktree-stale',
    ])
  })
})

/**
 * `runDoctorFix` (#1682, milestone 1) — the command-level wiring from
 * gathered facts to `reapAll`. The classification table itself is
 * unit-tested exhaustively in `lib/doctor-reaper.test.ts`; this only proves
 * the command actually reaches it with the facts `gatherRepoFacts` already
 * collected, rather than `--fix` existing as a flag with nothing behind it —
 * and that it never deletes a branch, worktree-only being this milestone's
 * whole scope.
 */
describe('runDoctorFix', () => {
  it('removes the worktree of a branch whose PR merged', async () => {
    const git = gitMock({
      listBranchRefs: vi
        .fn()
        .mockResolvedValue([
          { name: 'chore/merged', upstream: 'refs/remotes/origin/chore/merged', track: '[gone]' },
        ]),
      listWorktrees: vi.fn().mockResolvedValue([{ path: '/wt/merged', branch: 'chore/merged' }]),
    })
    const github = githubMock()

    const facts = await gatherRepoFacts({ cwd, fetch: true }, { git: git as never })
    const outcomes = await runDoctorFix(cwd, facts, { git: git as never, github: github as never })

    expect(outcomes).toEqual([
      {
        candidate: { branch: 'chore/merged', worktreePath: '/wt/merged' },
        verdict: { action: 'reap' },
        worktreeRemoved: true,
      },
    ])
    expect(git.removeWorktree).toHaveBeenCalledWith(cwd, '/wt/merged')
  })

  it('keeps and never removes a worktree carrying commits ahead of its merged PR (#1810)', async () => {
    const git = gitMock({
      listBranchRefs: vi.fn().mockResolvedValue([
        {
          name: 'fix/1602-orphan-ratchet-divergence',
          upstream: 'refs/remotes/origin/fix/1602-orphan-ratchet-divergence',
          track: '[gone]',
        },
      ]),
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/wt/realname',
          branch: 'fix/1602-orphan-ratchet-divergence',
        },
      ]),
      headSha: vi.fn().mockResolvedValue('unpushed-follow-up-sha'),
      isAncestor: vi.fn().mockResolvedValue(false),
    })
    const github = githubMock({ mergedHeadSha: vi.fn().mockResolvedValue('merged-tip-sha') })

    const facts = await gatherRepoFacts({ cwd, fetch: true }, { git: git as never })
    const outcomes = await runDoctorFix(cwd, facts, { git: git as never, github: github as never })

    expect(outcomes).toEqual([
      {
        candidate: {
          branch: 'fix/1602-orphan-ratchet-divergence',
          worktreePath: '/wt/realname',
        },
        verdict: { action: 'keep', reason: 'commits-not-in-merge' },
        worktreeRemoved: null,
      },
    ])
    expect(git.removeWorktree).not.toHaveBeenCalled()
  })

  it('keeps a worktree whose branch PR closed unmerged, and never removes it', async () => {
    const git = gitMock({
      listBranchRefs: vi.fn().mockResolvedValue([
        {
          name: 'security/undici-advisories',
          upstream: 'refs/remotes/origin/security/undici-advisories',
          track: '[gone]',
        },
      ]),
      listWorktrees: vi
        .fn()
        .mockResolvedValue([{ path: '/wt/undici', branch: 'security/undici-advisories' }]),
    })
    const github = githubMock({ prVerdictForBranch: vi.fn().mockResolvedValue('closed') })

    const facts = await gatherRepoFacts({ cwd, fetch: true }, { git: git as never })
    const outcomes = await runDoctorFix(cwd, facts, { git: git as never, github: github as never })

    expect(outcomes).toEqual([
      {
        candidate: { branch: 'security/undici-advisories', worktreePath: '/wt/undici' },
        verdict: { action: 'keep', reason: 'pr-closed' },
        worktreeRemoved: null,
      },
    ])
    expect(git.removeWorktree).not.toHaveBeenCalled()
  })

  it('never considers a [gone] branch with no worktree — bare-branch reaping is runDoctorFixBranches below', async () => {
    const git = gitMock({
      listBranchRefs: vi.fn().mockResolvedValue([
        {
          name: 'chore/bare-merged',
          upstream: 'refs/remotes/origin/chore/bare-merged',
          track: '[gone]',
        },
      ]),
      listWorktrees: vi.fn().mockResolvedValue([]),
    })
    const github = githubMock()

    const facts = await gatherRepoFacts({ cwd, fetch: true }, { git: git as never })
    const outcomes = await runDoctorFix(cwd, facts, { git: git as never, github: github as never })

    expect(outcomes).toEqual([])
    expect(github.prVerdictForBranch).not.toHaveBeenCalled()
  })

  it('never considers the branch this checkout is currently on', async () => {
    const git = gitMock({
      currentBranch: vi.fn().mockResolvedValue('agent/1682'),
      listBranchRefs: vi
        .fn()
        .mockResolvedValue([
          { name: 'agent/1682', upstream: 'refs/remotes/origin/agent/1682', track: '[gone]' },
        ]),
    })
    const github = githubMock()

    const facts = await gatherRepoFacts({ cwd, fetch: true }, { git: git as never })
    const outcomes = await runDoctorFix(cwd, facts, { git: git as never, github: github as never })

    expect(outcomes).toEqual([])
    expect(github.prVerdictForBranch).not.toHaveBeenCalled()
  })
})

/**
 * `runDoctorFixBranches` (#1682, milestone 2) — the command-level wiring from
 * gathered facts to `reapAllBareBranches`. Same split of responsibility as
 * `runDoctorFix` above: the classification table is unit-tested exhaustively
 * in `lib/doctor-reaper.test.ts`; this only proves the command reaches it
 * with the right facts, and that it is the worktree-havers' complement — a
 * branch WITH a linked worktree is `runDoctorFix`'s job, never this one's.
 */
describe('runDoctorFixBranches', () => {
  it('deletes a bare branch whose PR merged', async () => {
    const git = gitMock({
      listBranchRefs: vi.fn().mockResolvedValue([
        {
          name: 'fix/orphan-bare',
          upstream: 'refs/remotes/origin/fix/orphan-bare',
          track: '[gone]',
        },
      ]),
      listWorktrees: vi.fn().mockResolvedValue([]),
    })
    const github = githubMock()

    const facts = await gatherRepoFacts({ cwd, fetch: true }, { git: git as never })
    const outcomes = await runDoctorFixBranches(cwd, facts, {
      git: git as never,
      github: github as never,
    })

    expect(outcomes).toEqual([
      {
        candidate: { branch: 'fix/orphan-bare' },
        verdict: { action: 'reap' },
        branchDeleted: true,
      },
    ])
    expect(git.deleteBranch).toHaveBeenCalledWith(cwd, 'fix/orphan-bare')
  })

  it('keeps and never deletes a bare branch carrying commits ahead of its merged PR (#1810)', async () => {
    const git = gitMock({
      listBranchRefs: vi.fn().mockResolvedValue([
        {
          name: 'fix/orphan-bare',
          upstream: 'refs/remotes/origin/fix/orphan-bare',
          track: '[gone]',
        },
      ]),
      listWorktrees: vi.fn().mockResolvedValue([]),
      branchSha: vi.fn().mockResolvedValue('unpushed-follow-up-sha'),
      isAncestor: vi.fn().mockResolvedValue(false),
    })
    const github = githubMock({ mergedHeadSha: vi.fn().mockResolvedValue('merged-tip-sha') })

    const facts = await gatherRepoFacts({ cwd, fetch: true }, { git: git as never })
    const outcomes = await runDoctorFixBranches(cwd, facts, {
      git: git as never,
      github: github as never,
    })

    expect(outcomes).toEqual([
      {
        candidate: { branch: 'fix/orphan-bare' },
        verdict: { action: 'keep', reason: 'commits-not-in-merge' },
        branchDeleted: null,
      },
    ])
    expect(git.deleteBranch).not.toHaveBeenCalled()
  })

  it('never considers a [gone] branch that has a linked worktree — that is runDoctorFix', async () => {
    const git = gitMock({
      listBranchRefs: vi
        .fn()
        .mockResolvedValue([
          { name: 'chore/merged', upstream: 'refs/remotes/origin/chore/merged', track: '[gone]' },
        ]),
      listWorktrees: vi.fn().mockResolvedValue([{ path: '/wt/merged', branch: 'chore/merged' }]),
    })
    const github = githubMock()

    const facts = await gatherRepoFacts({ cwd, fetch: true }, { git: git as never })
    const outcomes = await runDoctorFixBranches(cwd, facts, {
      git: git as never,
      github: github as never,
    })

    expect(outcomes).toEqual([])
    expect(github.prVerdictForBranch).not.toHaveBeenCalled()
  })

  it('never considers the branch this checkout is currently on', async () => {
    const git = gitMock({
      currentBranch: vi.fn().mockResolvedValue('agent/1682'),
      listBranchRefs: vi
        .fn()
        .mockResolvedValue([
          { name: 'agent/1682', upstream: 'refs/remotes/origin/agent/1682', track: '[gone]' },
        ]),
      listWorktrees: vi.fn().mockResolvedValue([]),
    })
    const github = githubMock()

    const facts = await gatherRepoFacts({ cwd, fetch: true }, { git: git as never })
    const outcomes = await runDoctorFixBranches(cwd, facts, {
      git: git as never,
      github: github as never,
    })

    expect(outcomes).toEqual([])
    expect(github.prVerdictForBranch).not.toHaveBeenCalled()
  })
})

/**
 * `printReapOutcomes` (#1805) — the trailing summary line must be built from
 * `worktreeRemoved`, never from `verdict.action === 'reap'` alone. A
 * candidate judged safe to reap can still fail `git worktree remove`
 * (locked worktree, permission error); the per-item loop already prints
 * that as `FAILED`, and the summary used to silently count it as removed
 * anyway, overstating success in the one line most likely to actually be
 * read.
 */
describe('printReapOutcomes', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  it('does not fold a failed removal into the "removed" count', () => {
    const outcomes: ReapOutcome[] = [
      {
        candidate: { branch: 'feature-dirty', worktreePath: '/wt/feature-dirty' },
        verdict: { action: 'reap' },
        worktreeRemoved: false,
      },
      {
        candidate: { branch: 'feature-open', worktreePath: '/wt/feature-open' },
        verdict: { action: 'reap' },
        worktreeRemoved: true,
      },
    ]

    printReapOutcomes(outcomes)

    const out = capturedOutput(logSpy)
    expect(out).toContain('FAILED   /wt/feature-dirty (feature-dirty)')
    expect(out).toContain('removed  /wt/feature-open (feature-open)')
    // Exactly one worktree was actually removed, and the failure must not
    // vanish from the printed denominator: the old `${reaped.length}
    // removed` computation reported "2 removed, 0 kept" here.
    expect(out).toContain('--fix: 1 removed, 1 failed, 0 kept, of 2 worktree(s) considered.')
  })

  it('reports "0 failed" honestly when every reap attempt actually succeeded', () => {
    const outcomes: ReapOutcome[] = [
      {
        candidate: { branch: 'chore/merged', worktreePath: '/wt/merged' },
        verdict: { action: 'reap' },
        worktreeRemoved: true,
      },
      {
        candidate: { branch: 'pr-open', worktreePath: '/wt/pr-open' },
        verdict: { action: 'keep', reason: 'pr-open' },
        worktreeRemoved: null,
      },
    ]

    printReapOutcomes(outcomes)

    expect(capturedOutput(logSpy)).toContain(
      '--fix: 1 removed, 0 failed, 1 kept, of 2 worktree(s) considered.',
    )
  })

  it('reports the #1810 keep reasons in plain English, not the raw reason code', () => {
    const outcomes: ReapOutcome[] = [
      {
        candidate: { branch: 'fix/1602-orphan-ratchet-divergence', worktreePath: '/wt/realname' },
        verdict: { action: 'keep', reason: 'commits-not-in-merge' },
        worktreeRemoved: null,
      },
      {
        candidate: { branch: 'chore/merged', worktreePath: '/wt/merged' },
        verdict: { action: 'keep', reason: 'unknown-merge-head' },
        worktreeRemoved: null,
      },
    ]

    printReapOutcomes(outcomes)

    const out = capturedOutput(logSpy)
    expect(out).toContain(
      'kept     /wt/realname (fix/1602-orphan-ratchet-divergence) — ' +
        'worktree HEAD includes commits the merged PR never shipped',
    )
    expect(out).toContain(
      'kept     /wt/merged (chore/merged) — could not confirm worktree HEAD is contained in what merged',
    )
  })
})

/**
 * `printBranchReapOutcomes` (#1682 milestone 2) — the branch counterpart to
 * `printReapOutcomes`, same denominator-honesty rule (#1413/#1805): the
 * summary must be built from `branchDeleted`, never from `verdict.action`
 * alone.
 */
describe('printBranchReapOutcomes', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  it('does not fold a failed deletion into the "deleted" count', () => {
    const outcomes: BareBranchReapOutcome[] = [
      {
        candidate: { branch: 'fix/locked-somehow' },
        verdict: { action: 'reap' },
        branchDeleted: false,
      },
      {
        candidate: { branch: 'fix/orphan-bare' },
        verdict: { action: 'reap' },
        branchDeleted: true,
      },
    ]

    printBranchReapOutcomes(outcomes)

    const out = capturedOutput(logSpy)
    expect(out).toContain('FAILED   fix/locked-somehow')
    expect(out).toContain('deleted  fix/orphan-bare')
    expect(out).toContain(
      '--fix (branches): 1 deleted, 1 failed, 0 kept, of 2 branch(es) considered.',
    )
  })

  it('reports "0 failed" honestly when every deletion actually succeeded', () => {
    const outcomes: BareBranchReapOutcome[] = [
      {
        candidate: { branch: 'fix/orphan-bare' },
        verdict: { action: 'reap' },
        branchDeleted: true,
      },
      {
        candidate: { branch: 'security/undici-advisories' },
        verdict: { action: 'keep', reason: 'pr-closed' },
        branchDeleted: null,
      },
    ]

    printBranchReapOutcomes(outcomes)

    expect(capturedOutput(logSpy)).toContain(
      '--fix (branches): 1 deleted, 0 failed, 1 kept, of 2 branch(es) considered.',
    )
  })

  it('reports nothing-to-do plainly when there are no bare-branch candidates', () => {
    printBranchReapOutcomes([])
    expect(capturedOutput(logSpy)).toContain(
      '--fix (branches): no bare branch with a gone upstream to consider.',
    )
  })
})
