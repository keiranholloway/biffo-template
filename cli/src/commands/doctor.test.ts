import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gatherRepoFacts, runDoctor, runDoctorFix } from './doctor.js'
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
    ...overrides,
  }
}

/** A github adapter reporting every branch as merged; override per test. */
function githubMock(overrides: Record<string, unknown> = {}) {
  return {
    prVerdictForBranch: vi.fn().mockResolvedValue('merged'),
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

  it('never considers a [gone] branch with no worktree — bare-branch reaping is milestone 2', async () => {
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
