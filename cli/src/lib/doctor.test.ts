import { describe, expect, it } from 'vitest'
import { upgradeBranchName } from './core-upgrade.js'
import {
  type RepoFacts,
  checkCheckoutCurrency,
  checkCoreVersionCurrency,
  checkFossilCoreVersion,
  checkStaleBranches,
  checkWorktrees,
  runDoctorChecks,
} from './doctor.js'
import { type BranchRef } from './upgrade-branch-reaper.js'

/** A repo in good order — every check should stay silent. */
function healthy(overrides: Partial<RepoFacts> = {}): RepoFacts {
  return {
    currentBranch: 'dev',
    integrationBranch: 'dev',
    ahead: 0,
    behind: 0,
    hasUpstream: true,
    localCoreVersion: '0.158.0',
    remoteCoreVersion: '0.158.0',
    fossilCoreVersion: null,
    branches: [{ name: 'dev', upstream: 'refs/remotes/origin/dev', track: '' }],
    worktrees: [],
    ...overrides,
  }
}

const gone = (name: string): BranchRef => ({
  name,
  upstream: `refs/remotes/origin/${name}`,
  track: '[gone]',
})
const live = (name: string): BranchRef => ({
  name,
  upstream: `refs/remotes/origin/${name}`,
  track: '',
})
const orphan = (name: string): BranchRef => ({ name, upstream: '', track: '' })

const checks = (fs: { check: string }[]): string[] => fs.map((f) => f.check)

describe('a healthy repo', () => {
  it('produces no findings at all', () => {
    expect(runDoctorChecks(healthy())).toEqual([])
  })
})

describe('checkCheckoutCurrency', () => {
  it('flags a primary parked off the integration branch', () => {
    // The condition that produced a wrong audit (#758): everything read from
    // the checkout describes that branch, not the repo.
    const found = checkCheckoutCurrency(healthy({ currentBranch: 'biffo/core-upgrade-1-to-2' }))
    expect(checks(found)).toEqual(['checkout-off-integration'])
    expect(found[0]?.severity).toBe('error')
  })

  it('flags a detached HEAD, and does not also complain about the branch name', () => {
    const found = checkCheckoutCurrency(healthy({ currentBranch: 'HEAD' }))
    expect(checks(found)).toEqual(['checkout-detached'])
  })

  it('flags a checkout behind its upstream', () => {
    const found = checkCheckoutCurrency(healthy({ behind: 3 }))
    expect(checks(found)).toEqual(['checkout-behind'])
    expect(found[0]?.detail).toContain('3 commit(s) behind')
  })

  it('says diverged when it is both ahead and behind', () => {
    const found = checkCheckoutCurrency(healthy({ behind: 3, ahead: 2 }))
    expect(found[0]?.detail).toContain('diverged')
  })

  it('says nothing about behind-ness when there is no upstream to compare to', () => {
    // behind is meaningless without an upstream; reporting it would be a
    // finding invented from an absent measurement.
    expect(checkCheckoutCurrency(healthy({ hasUpstream: false, behind: 9 }))).toEqual([])
  })

  it('reports both conditions when both hold', () => {
    const found = checkCheckoutCurrency(healthy({ currentBranch: 'feat/x', behind: 2 }))
    expect(checks(found)).toEqual(['checkout-off-integration', 'checkout-behind'])
  })
})

describe('checkCoreVersionCurrency', () => {
  it('flags a checkout whose recorded version trails the integration branch', () => {
    // Observed 2026-07-28: 0.153.2 locally against a real 0.157.3, which sized
    // a 4-file upgrade as 17 commits.
    const found = checkCoreVersionCurrency(
      healthy({ localCoreVersion: '0.153.2', remoteCoreVersion: '0.157.3' }),
    )
    expect(checks(found)).toEqual(['core-version-stale'])
    expect(found[0]?.detail).toContain('0.153.2')
    expect(found[0]?.detail).toContain('0.157.3')
  })

  it('stays silent when either side is unknown', () => {
    // Absent is not the same as disagreeing; a template checkout has no record.
    expect(checkCoreVersionCurrency(healthy({ localCoreVersion: null }))).toEqual([])
    expect(checkCoreVersionCurrency(healthy({ remoteCoreVersion: null }))).toEqual([])
  })
})

describe('checkFossilCoreVersion', () => {
  it('flags a core.version that disagrees with the authority', () => {
    const found = checkFossilCoreVersion(
      healthy({ fossilCoreVersion: '0.41.17', localCoreVersion: '0.155.0' }),
    )
    expect(checks(found)).toEqual(['fossil-core-version'])
    expect(found[0]?.severity).toBe('warn')
  })

  it('says nothing when the inherited copy still agrees', () => {
    // At `biffo init` both files are written with the same version, so an
    // untouched copy matching is the normal, uninteresting case.
    expect(
      checkFossilCoreVersion(
        healthy({ fossilCoreVersion: '0.158.0', localCoreVersion: '0.158.0' }),
      ),
    ).toEqual([])
  })

  it('says nothing when there is no core.version at all', () => {
    expect(checkFossilCoreVersion(healthy({ fossilCoreVersion: null }))).toEqual([])
  })
})

describe('checkStaleBranches', () => {
  it('flags branches whose upstream is gone', () => {
    const found = checkStaleBranches(
      healthy({ branches: [live('dev'), gone('feat/merged'), gone('fix/also-merged')] }),
    )
    expect(checks(found)).toEqual(['stale-branches'])
    expect(found[0]?.detail).toContain('2 local branch(es)')
  })

  it('never counts a branch with no upstream', () => {
    // Indistinguishable from unlanded local work — the distinction that keeps
    // the 2026-07-28 sweep from deleting somebody's unpushed branch.
    expect(checkStaleBranches(healthy({ branches: [orphan('feat/never-pushed')] }))).toEqual([])
  })

  it('never counts the branch currently checked out', () => {
    expect(
      checkStaleBranches(healthy({ currentBranch: 'feat/here', branches: [gone('feat/here')] })),
    ).toEqual([])
  })

  it('calls out how many came from core upgrades', () => {
    const found = checkStaleBranches(
      healthy({ branches: [gone(upgradeBranchName('1.0.0', '1.1.0')), gone('feat/x')] }),
    )
    expect(found[0]?.detail).toContain('1 from core upgrades')
  })

  it('does not name upgrades when none of them are', () => {
    const found = checkStaleBranches(healthy({ branches: [gone('feat/x')] }))
    expect(found[0]?.detail).not.toContain('core upgrades')
  })
})

describe('checkWorktrees', () => {
  it('flags a worktree sitting on a merged branch', () => {
    const found = checkWorktrees(
      healthy({
        branches: [gone('feat/done')],
        worktrees: [{ path: '.worktrees/done', branch: 'feat/done', behind: 0 }],
      }),
    )
    expect(checks(found)).toEqual(['worktree-merged'])
  })

  it('flags a worktree far behind the integration branch', () => {
    const found = checkWorktrees(
      healthy({ worktrees: [{ path: '.worktrees/ancient', branch: 'feat/old', behind: 120 }] }),
    )
    expect(checks(found)).toEqual(['worktree-stale'])
    expect(found[0]?.detail).toContain('120')
  })

  it('reports a merged worktree once, not also as stale', () => {
    // Otherwise the same worktree appears under two headings and the counts
    // read as twice the problem.
    const found = checkWorktrees(
      healthy({
        branches: [gone('feat/done')],
        worktrees: [{ path: '.worktrees/done', branch: 'feat/done', behind: 300 }],
      }),
    )
    expect(checks(found)).toEqual(['worktree-merged'])
  })

  it('leaves a live worktree alone', () => {
    expect(
      checkWorktrees(
        healthy({
          branches: [live('feat/wip')],
          worktrees: [{ path: '.worktrees/wip', branch: 'feat/wip', behind: 2 }],
        }),
      ),
    ).toEqual([])
  })

  it('says nothing when how far behind cannot be measured', () => {
    expect(
      checkWorktrees(
        healthy({ worktrees: [{ path: '.worktrees/x', branch: 'feat/x', behind: null }] }),
      ),
    ).toEqual([])
  })
})

describe('runDoctorChecks', () => {
  it('reports the real 2026-07-28 estate state in one pass', () => {
    const found = runDoctorChecks(
      healthy({
        currentBranch: 'biffo/core-upgrade-0.133.3-to-0.136.0',
        behind: 10,
        localCoreVersion: '0.153.2',
        remoteCoreVersion: '0.157.3',
        fossilCoreVersion: '0.41.17',
        branches: [gone('chore/old'), orphan('feat/unpushed')],
        worktrees: [{ path: '.worktrees/core-upgrade-work', branch: 'feat/unpushed', behind: 400 }],
      }),
    )

    expect(checks(found)).toEqual([
      'checkout-off-integration',
      'checkout-behind',
      'core-version-stale',
      'fossil-core-version',
      'stale-branches',
      'worktree-stale',
    ])
  })

  it('gives every finding a remedy, not just a complaint', () => {
    const found = runDoctorChecks(
      healthy({ currentBranch: 'feat/x', behind: 1, fossilCoreVersion: '0.1.0' }),
    )
    expect(found.length).toBeGreaterThan(0)
    for (const f of found) expect(f.remedy.length).toBeGreaterThan(0)
  })
})
