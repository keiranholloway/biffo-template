import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { classifyUpgradeBranches } from '../../lib/upgrade-branch-reaper.js'
import { upgradeBranchName } from '../../lib/core-upgrade.js'
import { GitAdapter } from './index.js'
import { makeTmpDir } from '../../test-utils/tmp.js'

/**
 * Reaping the branches `core upgrade` leaves behind (#758), proven end to end.
 *
 * The unit tests cover classification given a list of refs. They cannot cover
 * the part that actually decides whether this works: that **real git**, after a
 * real push and a real squash-merge-and-delete, reports the branch in a way the
 * classifier recognises. That is a property of git's own bookkeeping, not ours,
 * so it is exercised against a real bare remote and clone — including a negative
 * control showing what happens without the prune.
 */
describe('reaping merged upgrade branches (#758)', () => {
  let remote: string
  let work: string
  const adapter = new GitAdapter()

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

  beforeEach(() => {
    remote = makeTmpDir('biffo-reap-remote')
    work = makeTmpDir('biffo-reap-work')
    git(remote, 'init', '--bare', '-q', '-b', 'dev')
    git(work, 'init', '-q', '-b', 'dev')
    git(work, 'config', 'user.email', 'test@example.com')
    git(work, 'config', 'user.name', 'Test')
    writeFileSync(join(work, 'a.txt'), 'base\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-qm', 'base')
    git(work, 'remote', 'add', 'origin', remote)
    git(work, 'push', '-qu', 'origin', 'dev')
  })
  afterEach(() => {
    rmSync(remote, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  })

  /** Create an upgrade branch and push it the way the tool does. */
  async function pushUpgradeBranch(from: string, to: string): Promise<string> {
    const branch = upgradeBranchName(from, to)
    git(work, 'switch', '-qc', branch)
    writeFileSync(join(work, 'a.txt'), `${from}->${to}\n`)
    git(work, 'add', '-A')
    git(work, 'commit', '-qm', `upgrade ${from} to ${to}`)
    await adapter.push(work, branch)
    git(work, 'switch', '-q', 'dev')
    return branch
  }

  /**
   * What `gh pr merge --squash --delete-branch` leaves behind: the content
   * lands on the base as a NEW commit (so the branch tip is never an ancestor),
   * and the remote branch is removed.
   */
  function squashMergeAndDelete(branch: string): void {
    git(remote, 'update-ref', '-d', `refs/heads/${branch}`)
  }

  it('classifies a merged-and-deleted upgrade branch as reapable, and deletes it', async () => {
    const branch = await pushUpgradeBranch('1.0.0', '1.1.0')
    squashMergeAndDelete(branch)

    // The prune is what turns the deleted remote branch into `[gone]`.
    await adapter.fetchPrune(work)
    const refs = await adapter.listBranchRefs(work)
    const { reapable, unverifiable } = classifyUpgradeBranches(refs, 'dev')

    expect(reapable).toEqual([branch])
    expect(unverifiable).toEqual([])

    expect(await adapter.deleteBranch(work, branch)).toBe(true)
    expect(await adapter.listBranchRefs(work)).toEqual([expect.objectContaining({ name: 'dev' })])
  })

  it('git branch -d would have refused it — which is why nobody cleaned these up', async () => {
    const branch = await pushUpgradeBranch('1.0.0', '1.1.0')
    squashMergeAndDelete(branch)
    await adapter.fetchPrune(work)

    // The whole reason `deleteBranch` uses -D: the squash means the tip is not
    // an ancestor of dev, so the safe delete refuses.
    expect(() => git(work, 'branch', '-d', branch)).toThrow()
    expect(await adapter.deleteBranch(work, branch)).toBe(true)
  })

  it('without the prune, nothing is reapable — the branch still looks alive', async () => {
    // Negative control for fetchPrune. `fetch()` alone does not drop the stale
    // remote-tracking ref, so the branch reports no `[gone]` and the reaper
    // correctly declines to touch it.
    const branch = await pushUpgradeBranch('1.0.0', '1.1.0')
    squashMergeAndDelete(branch)

    await adapter.fetch(work)
    const refs = await adapter.listBranchRefs(work)
    const { reapable } = classifyUpgradeBranches(refs, 'dev')

    expect(reapable).toEqual([])
    expect(refs.map((r) => r.name)).toContain(branch)
  })

  it('leaves an upgrade branch whose PR has not merged yet', async () => {
    const branch = await pushUpgradeBranch('2.0.0', '2.1.0')
    await adapter.fetchPrune(work)

    const refs = await adapter.listBranchRefs(work)
    const { reapable, unverifiable } = classifyUpgradeBranches(refs, 'dev')
    // Present and tracked, but in neither bucket — an upgrade still in flight.
    expect(refs.map((r) => r.name)).toContain(branch)
    expect(reapable).toEqual([])
    expect(unverifiable).toEqual([])
  })

  it('never reaps a hand-made branch that was never pushed', async () => {
    // The pre-#761 fossil shape, and also just ordinary unlanded work. It must
    // survive: with no upstream there is no evidence it merged anywhere.
    const branch = upgradeBranchName('0.41.18', '0.49.1')
    git(work, 'branch', branch)
    await adapter.fetchPrune(work)

    const { reapable, unverifiable } = classifyUpgradeBranches(
      await adapter.listBranchRefs(work),
      'dev',
    )
    expect(reapable).toEqual([])
    expect(unverifiable).toEqual([branch])
  })
})
