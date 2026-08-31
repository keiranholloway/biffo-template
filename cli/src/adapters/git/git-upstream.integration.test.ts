import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitAdapter } from './index.js'
import { makeTmpDir, removeTmpDir } from '../../test-utils/tmp.js'

/**
 * #758, proven end to end against real repositories.
 *
 * The unit tests assert which git commands are issued. They cannot assert the
 * thing that actually matters: that a branch this tool pushed becomes
 * *detectable as dead* once its PR is squash-merged and the remote branch
 * deleted. That is a property of git's own bookkeeping, so it is exercised here
 * with a real bare remote and a real clone — including a negative control
 * reproducing the original defect.
 */
describe('push leaves a branch that can be found once merged (#758)', () => {
  let remote: string
  let work: string
  const adapter = new GitAdapter()

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

  beforeEach(() => {
    remote = makeTmpDir('biffo-remote')
    work = makeTmpDir('biffo-work')
    git(remote, 'init', '--bare', '-q', '-b', 'dev')
    git(work, 'init', '-q', '-b', 'dev')
    git(work, 'config', 'user.email', 'test@example.com')
    git(work, 'config', 'user.name', 'Test')
    writeFileSync(join(work, 'a.txt'), 'base\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-qm', 'base')
    git(work, 'remote', 'add', 'origin', remote)
    git(work, 'push', '-q', 'origin', 'dev')
  })
  afterEach(() => {
    // Both were just written to by real `git` subprocesses -- see
    // `removeTmpDir`'s docstring for why a bare `rmSync` here is racy.
    removeTmpDir(remote)
    removeTmpDir(work)
  })

  /** Simulate a squash-merge: the content lands on dev as a NEW commit, and the
   * remote branch is deleted — exactly what `gh pr merge --squash --delete-branch`
   * leaves behind. */
  function squashMergeAndDelete(branch: string): void {
    git(remote, 'update-ref', '-d', `refs/heads/${branch}`)
    git(work, 'fetch', '--prune', '-q', 'origin')
  }

  function tracking(branch: string): string {
    return git(work, 'branch', '-vv', '--list', branch)
  }

  it('a branch pushed by the adapter is reported gone after its remote copy is deleted', () => {
    git(work, 'switch', '-qc', 'feat/x')
    writeFileSync(join(work, 'a.txt'), 'change\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-qm', 'work')

    return adapter.push(work, 'feat/x').then(() => {
      // While the PR is open the branch must NOT read as gone — marking a live
      // branch dead would be worse than the bug being fixed.
      expect(tracking('feat/x')).toContain('[origin/feat/x]')
      expect(tracking('feat/x')).not.toContain('gone')

      squashMergeAndDelete('feat/x')

      // Now it is detectable by the standard check, which is the whole point.
      expect(tracking('feat/x')).toContain('gone')
    })
  })

  it('NEGATIVE CONTROL: a plain refspec push (the old behaviour) stays invisible', () => {
    git(work, 'switch', '-qc', 'feat/old')
    writeFileSync(join(work, 'a.txt'), 'change\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-qm', 'work')
    // Exactly what the adapter used to do — no -u, no upstream recorded.
    git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/feat/old')

    squashMergeAndDelete('feat/old')
    // Switch away first, or `-d` refuses because the branch is CHECKED OUT —
    // which would make the assertion below pass for a reason that has nothing
    // to do with merge status.
    git(work, 'switch', '-q', 'dev')

    // Neither standard check can see it: this is the defect, reproduced.
    expect(tracking('feat/old')).not.toContain('gone')
    expect(git(work, 'branch', '--merged', 'dev')).not.toContain('feat/old')
    // ...and `-d` refuses it *on merge grounds*, leaving only -D.
    let refusal = ''
    try {
      git(work, 'branch', '-d', 'feat/old')
    } catch (err) {
      refusal = String((err as { stderr?: string }).stderr ?? err)
    }
    expect(refusal).toMatch(/not fully merged/i)
  })

  it('the adapter-pushed branch is equally invisible to --merged, so the upstream is what saves it', () => {
    git(work, 'switch', '-qc', 'feat/y')
    writeFileSync(join(work, 'a.txt'), 'change\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-qm', 'work')

    return adapter.push(work, 'feat/y').then(() => {
      squashMergeAndDelete('feat/y')
      // Squash-merge defeats --merged regardless of this fix...
      expect(git(work, 'branch', '--merged', 'dev')).not.toContain('feat/y')
      // ...so `: gone]` is the only signal, and it is now present.
      expect(tracking('feat/y')).toContain('gone')
    })
  })
})
