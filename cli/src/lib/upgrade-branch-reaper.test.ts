import { describe, expect, it } from 'vitest'
import { UPGRADE_BRANCH_PREFIX, upgradeBranchName } from './core-upgrade.js'
import {
  BRANCH_REF_FORMAT,
  classifyUpgradeBranches,
  parseBranchRefs,
  type BranchRef,
} from './upgrade-branch-reaper.js'

/** Builds the exact tab-separated line `git for-each-ref` emits. */
function line(name: string, upstream = '', track = ''): string {
  return [name, upstream, track].join('\t')
}

describe('parseBranchRefs', () => {
  it('reads name, upstream and track from git for-each-ref output', () => {
    const refs = parseBranchRefs(
      [
        line('dev', 'refs/remotes/origin/dev', ''),
        line(
          'biffo/core-upgrade-1.0.0-to-1.1.0',
          'refs/remotes/origin/biffo/core-upgrade-1.0.0-to-1.1.0',
          '[gone]',
        ),
        line('feat/thing'),
      ].join('\n'),
    )

    expect(refs).toEqual([
      { name: 'dev', upstream: 'refs/remotes/origin/dev', track: '' },
      {
        name: 'biffo/core-upgrade-1.0.0-to-1.1.0',
        upstream: 'refs/remotes/origin/biffo/core-upgrade-1.0.0-to-1.1.0',
        track: '[gone]',
      },
      { name: 'feat/thing', upstream: '', track: '' },
    ])
  })

  it('ignores blank lines and trailing newlines', () => {
    expect(parseBranchRefs('\n' + line('dev') + '\n\n')).toEqual([
      { name: 'dev', upstream: '', track: '' },
    ])
  })

  it('returns nothing for empty output rather than a phantom branch', () => {
    // A repo can legitimately have no branches matching; an empty string must
    // not parse into one entry with an empty name, which would then be passed
    // to `git branch -D ''`.
    expect(parseBranchRefs('')).toEqual([])
  })

  it('asks git for exactly the three fields it parses', () => {
    expect(BRANCH_REF_FORMAT.split('\t')).toHaveLength(3)
  })
})

describe('classifyUpgradeBranches', () => {
  const dead = (name: string): BranchRef => ({
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

  it('reaps an upgrade branch whose upstream is gone', () => {
    const { reapable, unverifiable } = classifyUpgradeBranches(
      [dead(upgradeBranchName('1.0.0', '1.1.0'))],
      'dev',
    )
    expect(reapable).toEqual(['biffo/core-upgrade-1.0.0-to-1.1.0'])
    expect(unverifiable).toEqual([])
  })

  it('never reaps a branch with no upstream — the pre-#761 fossil case', () => {
    // Indistinguishable from local work someone never pushed. Deleting it on
    // suspicion destroys the one thing that cannot be recovered.
    const { reapable, unverifiable } = classifyUpgradeBranches(
      [orphan(upgradeBranchName('0.41.18', '0.49.1'))],
      'dev',
    )
    expect(reapable).toEqual([])
    expect(unverifiable).toEqual(['biffo/core-upgrade-0.41.18-to-0.49.1'])
  })

  it('leaves an in-flight upgrade alone entirely', () => {
    // Live upstream = the PR has not merged yet. Not dead, not a fossil.
    const { reapable, unverifiable } = classifyUpgradeBranches(
      [live(upgradeBranchName('2.0.0', '2.1.0'))],
      'dev',
    )
    expect(reapable).toEqual([])
    expect(unverifiable).toEqual([])
  })

  it('never touches branches outside the upgrade prefix', () => {
    const { reapable, unverifiable } = classifyUpgradeBranches(
      [dead('feat/my-work'), orphan('backup/pre-recreate-local-history'), dead('dev')],
      'dev',
    )
    expect(reapable).toEqual([])
    expect(unverifiable).toEqual([])
  })

  it('excludes the branch currently checked out', () => {
    // `git branch -D` on the current branch fails, and an upgrade run from its
    // own worktree legitimately sits on one of these names.
    const current = upgradeBranchName('1.0.0', '1.1.0')
    const { reapable, unverifiable } = classifyUpgradeBranches(
      [dead(current), dead(upgradeBranchName('0.9.0', '1.0.0'))],
      current,
    )
    expect(reapable).toEqual(['biffo/core-upgrade-0.9.0-to-1.0.0'])
    expect(unverifiable).toEqual([])
  })

  it('separates a realistic mixed repo correctly', () => {
    const { reapable, unverifiable } = classifyUpgradeBranches(
      [
        live('dev'),
        dead(upgradeBranchName('0.1.0', '0.2.0')),
        dead(upgradeBranchName('0.2.0', '0.3.0')),
        orphan(upgradeBranchName('0.41.18', '0.49.1')),
        live(upgradeBranchName('9.0.0', '9.1.0')),
        orphan('feat/unrelated'),
      ],
      'dev',
    )
    expect(reapable).toEqual([
      'biffo/core-upgrade-0.1.0-to-0.2.0',
      'biffo/core-upgrade-0.2.0-to-0.3.0',
    ])
    expect(unverifiable).toEqual(['biffo/core-upgrade-0.41.18-to-0.49.1'])
  })

  it('recognises whatever prefix upgradeBranchName actually produces', () => {
    // Derived, not hand-written: renaming the prefix must not silently stop
    // the reaper matching (the trap core-ownership-guard.test.ts calls out).
    expect(upgradeBranchName('1.0.0', '1.1.0').startsWith(UPGRADE_BRANCH_PREFIX)).toBe(true)
  })
})
