import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitAdapter } from './index.js'
import { makeTmpDir } from '../../test-utils/tmp.js'

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
