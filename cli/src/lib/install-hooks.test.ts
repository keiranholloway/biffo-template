import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Arming has to reach worktrees that **already exist**, on branches nobody is
 * allowed to touch.
 *
 * #838 tracked the hooks and pointed `core.hooksPath` at them. That fixed the
 * gitignored-runner-directory bug, but `core.hooksPath` is relative and shared:
 * the moment it is set, every worktree checked out on a branch predating
 * `.githooks/` has the config and not the directory, and git is silently
 * skipping again. AGENTS.md §1 forbids modifying a worktree you did not create,
 * so rebasing them is not available.
 *
 * Git's default beats the override. With `core.hooksPath` unset, a linked
 * worktree runs the **common** `.git/hooks` — so one install arms every worktree
 * the clone will ever have. These tests pin that, because the entire coverage
 * argument rests on it and it is not obvious from the docs.
 */
const scripts = join(import.meta.dirname, '..', '..', '..', 'scripts')

function repoWithWorktree() {
  const dir = mkdtempSync(join(tmpdir(), 'install-hooks-'))
  const main = join(dir, 'main')
  mkdirSync(main)
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  git(main, 'init', '-q', '-b', 'dev')
  git(main, 'config', 'user.email', 't@t')
  git(main, 'config', 'user.name', 't')
  writeFileSync(join(main, 'a.txt'), 'a\n')
  git(main, 'add', '-A')
  git(main, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init')
  // A worktree that exists BEFORE the hooks are installed — the case that
  // matters, and the one core.hooksPath cannot reach.
  const linked = join(dir, 'linked')
  git(main, 'worktree', 'add', '-q', linked, '-b', 'feat/pre-existing')
  return { dir, main, linked, git }
}

function install(main: string) {
  return execFileSync('sh', [join(scripts, 'install-hooks.sh')], { cwd: main, encoding: 'utf8' })
}

describe('install-hooks', () => {
  it('arms a worktree that existed before it ran', () => {
    const { main, linked } = repoWithWorktree()
    install(main)
    // The dispatcher lives in the common dir; the linked worktree has no hooks
    // directory of its own and does not need one.
    expect(existsSync(join(main, '.git', 'hooks', 'pre-commit'))).toBe(true)
    expect(existsSync(join(linked, '.git'))).toBe(true) // a file, not a directory
    const out = execFileSync('bash', [join(scripts, 'hook-audit.sh')], {
      cwd: linked,
      encoding: 'utf8',
    })
    expect(out).toContain('ARMED')
    expect(out).not.toContain('DEAD')
  })

  it('clears core.hooksPath, which would make every dispatcher unreachable', () => {
    const { main, git } = repoWithWorktree()
    git(main, 'config', 'core.hooksPath', '.githooks')
    install(main)
    // `git config --get` exits 1 when the key is unset, so "it threw" IS the
    // assertion. Reading the value and comparing to '' would pass whether the
    // key were cleared or merely empty, which are different states.
    let cleared = false
    let value = 'still set'
    try {
      value = execFileSync('git', ['-C', main, 'config', '--local', '--get', 'core.hooksPath'], {
        encoding: 'utf8',
      }).trim()
    } catch {
      cleared = true
    }
    expect(cleared, `core.hooksPath is still ${value}`).toBe(true)
  })

  it('dispatches to the running worktree’s tracked hook', () => {
    const { main, linked, git } = repoWithWorktree()
    install(main)
    mkdirSync(join(linked, '.githooks'), { recursive: true })
    writeFileSync(join(linked, '.githooks', 'commit-msg'), '#!/usr/bin/env sh\nexit 3\n')
    chmodSync(join(linked, '.githooks', 'commit-msg'), 0o755)
    writeFileSync(join(linked, 'b.txt'), 'b\n')
    git(linked, 'add', '-A')
    let status = 0
    try {
      git(linked, '-c', 'commit.gpgsign=false', 'commit', '-m', 'x')
    } catch (e) {
      status = (e as { status: number }).status
    }
    // The tracked hook rejected it, through the dispatcher, in a worktree that
    // predates the install.
    expect(status).not.toBe(0)
    expect(git(linked, 'log', '--oneline').trim().split('\n')).toHaveLength(1)
  })

  /**
   * A branch with no `.githooks/` has no repo-defined hooks — the state it was
   * already in. Blocking every commit there would invent a gate that branch
   * never had and would break other agents mid-flight. But silence is the
   * defect, so it warns on stderr every time.
   */
  it('warns rather than blocks when the tree has no tracked hooks', () => {
    const { main, linked, git } = repoWithWorktree()
    install(main)
    writeFileSync(join(linked, 'b.txt'), 'b\n')
    git(linked, 'add', '-A')
    const out = execFileSync(
      'git',
      ['-C', linked, '-c', 'commit.gpgsign=false', 'commit', '-m', 'x'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    expect(out).toBeDefined()
    const hook = readFileSync(join(main, '.git', 'hooks', 'pre-commit'), 'utf8')
    expect(hook).toContain('NO checks ran')
    expect(hook).toContain('exit 0')
  })
})
