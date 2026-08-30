import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * `reclaim_sync_branch` / `reset_sync_worktree` (biffo-template#1785).
 *
 * ## The bug
 *
 * `stage_repo`'s pre-stage sequence used to be three unconditional lines:
 * remove `$d/.worktrees/shared-sync` (a fixed, expected path), `git branch -D
 * chore/sync-shared`, then `git worktree add -b chore/sync-shared`. That works
 * only if nothing ELSE currently holds `chore/sync-shared` — and if something
 * does (a foreign worktree, at any other path), the `worktree remove` above is
 * a no-op against it, so is the `branch -D` right after (git prints `error:
 * cannot delete branch ... checked out at ...` and exits non-zero, but the
 * call redirects both away and never checks), and `worktree add -b` then dies
 * with `fatal: a branch named 'chore/sync-shared' already exists`.
 *
 * `stage_repo` correctly turns that into `CANNOT STAGE`, but has no recovery
 * from it — and refusing to stage ONE repo aborts the ENTIRE estate-wide
 * round by design (nothing ships on a partial rehearsal). That happened for
 * real: a leftover `.worktrees/pr379-gh-fix` in `tabsii-crm`, debris from an
 * unrelated PR's rejected remediation attempt, silently blocked shared-file
 * distribution to every satellite and plugin repo for 5 consecutive days
 * (2026-08-26 through -30), because nothing polls the worktree log a
 * `CANNOT STAGE` line goes to.
 *
 * Reproduced manually against `origin/dev`'s pre-fix script before writing
 * this fix: a foreign worktree on `chore/sync-shared` makes the old three-line
 * sequence's final `worktree add -q ... -b chore/sync-shared` fail with
 * exactly that `fatal: a branch named ... already exists`.
 *
 * ## What these test
 *
 * `reclaim_sync_branch` finds `chore/sync-shared` by BRANCH rather than by the
 * one path `stage_repo` expects to find it at (git refuses to check the same
 * branch out in two worktrees at once, so there is only ever one holder to
 * find), and force-removes it if it is anywhere OTHER than the expected path.
 * `reset_sync_worktree` is the pre-stage sequence itself, with that reclaim
 * folded in — extracted from `stage_repo` the same way `acquire_stage_lock` is
 * tested in isolation in shared-sync-stage-lock.test.ts, rather than driving
 * the whole script (which also needs a fixture template, manifest and `gh`
 * stub unrelated to this bug).
 */
const script = join(import.meta.dirname, '..', '..', '..', 'scripts', 'shared-sync.sh')

/** Extract a named function's body verbatim — same technique as
 * shared-sync-stage-lock.test.ts's `functionSource`. */
function functionSource(name: string): string {
  const lines = readFileSync(script, 'utf8').split('\n')
  const start = lines.findIndex((l) => l === `${name}() {`)
  expect(start, `${name}() not found -- has it been renamed?`).toBeGreaterThan(-1)
  const end = lines.findIndex((l, i) => i > start && l === '}')
  expect(end, `no closing brace for ${name}()`).toBeGreaterThan(start)
  return lines.slice(start, end + 1).join('\n')
}

/** `wt_log` stubbed to a no-op, same reasoning as the stage-lock test: the
 * real one appends under `$HOME`, which these tests must not touch, and its
 * own coverage lives in shared-sync-worktree-log.test.ts. */
function preamble(): string {
  return `wt_log() { :; }\n${functionSource('reclaim_sync_branch')}\n${functionSource('reset_sync_worktree')}\n`
}

function run(program: string) {
  // `reclaim_sync_branch` reports what it did on stderr (it is a warning, not
  // the function's return value), so both streams are merged inside the
  // subshell -- otherwise a *successful* run's stderr is simply discarded by
  // execFileSync and assertions on "did it log the reclaim" would only ever
  // see it on the (irrelevant) failure path.
  const wrapped = `{\n${program}\n} 2>&1`
  try {
    const stdout = execFileSync('bash', ['-c', wrapped], {
      encoding: 'utf8',
      timeout: 15_000,
    })
    return { code: 0, out: stdout }
  } catch (e) {
    const err = e as { status: number | null; stdout: string; stderr: string }
    return { code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

/** A real git repo standing in for `$d` (a satellite clone), with a real
 * `origin/trunk` to stage against — `dev` is deliberately avoided as the
 * fixture's branch name so this repo's own pre-push guard (which refuses a
 * direct push naming an integration branch) never fires against fixture
 * plumbing that has nothing to do with it. */
function makeSatellite(): string {
  const root = makeTmpDir('sync-reclaim')
  const origin = join(root, 'origin.git')
  const sat = join(root, 'sat')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'trunk', origin])
  execFileSync('git', ['clone', '-q', origin, sat])
  execFileSync('git', [
    '-C',
    sat,
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    'commit',
    '--allow-empty',
    '-qm',
    'init',
  ])
  execFileSync('git', ['-C', sat, 'push', '-q', 'origin', 'trunk'])
  return sat
}

describe('reclaim_sync_branch', () => {
  it('is a no-op when chore/sync-shared is not checked out anywhere', () => {
    const sat = makeSatellite()
    const program = `cd ${JSON.stringify(sat)}\n${preamble()}\nreclaim_sync_branch . ".worktrees/shared-sync" test-label\n`
    const { code, out } = run(program)

    expect(code).toBe(0)
    expect(out).not.toContain('reclaiming')
  })

  it('does not touch its own expected worktree', () => {
    const sat = makeSatellite()
    execFileSync('git', [
      '-C',
      sat,
      'worktree',
      'add',
      '-q',
      '.worktrees/shared-sync',
      '-b',
      'chore/sync-shared',
      'origin/trunk',
    ])
    const program = `cd ${JSON.stringify(sat)}\n${preamble()}\nreclaim_sync_branch . "$(pwd)/.worktrees/shared-sync" test-label\n`
    const { code, out } = run(program)

    expect(code).toBe(0)
    expect(out).not.toContain('reclaiming')
    const list = execFileSync('git', ['-C', sat, 'worktree', 'list'], { encoding: 'utf8' })
    expect(list).toContain('.worktrees/shared-sync')
  })

  it('force-removes a FOREIGN worktree holding chore/sync-shared, freeing the branch', () => {
    const sat = makeSatellite()
    // The real-world shape: an unrelated worktree, at an unrelated path,
    // happens to be sitting on chore/sync-shared (biffo-template#1785's
    // `.worktrees/pr379-gh-fix`).
    execFileSync('git', [
      '-C',
      sat,
      'worktree',
      'add',
      '-q',
      '.worktrees/pr379-gh-fix',
      '-b',
      'chore/sync-shared',
      'origin/trunk',
    ])
    const program = `cd ${JSON.stringify(sat)}\n${preamble()}\nreclaim_sync_branch . "$(pwd)/.worktrees/shared-sync" test-label\n`
    const { code, out } = run(program)

    expect(code).toBe(0)
    expect(out).toContain('reclaiming')
    expect(out).toContain('pr379-gh-fix')
    const list = execFileSync('git', ['-C', sat, 'worktree', 'list'], { encoding: 'utf8' })
    expect(list).not.toContain('pr379-gh-fix')
    // The branch itself is now free for `branch -D` / a fresh `worktree add`.
    const canDelete = run(
      `cd ${JSON.stringify(sat)}\ngit branch -D chore/sync-shared >/dev/null 2>&1; echo $?`,
    )
    expect(canDelete.out.trim()).toBe('0')
  })
})

describe('reset_sync_worktree', () => {
  it('stages cleanly on a repo staging for the first time (no prior branch at all)', () => {
    const sat = makeSatellite()
    const wt = join(sat, '.worktrees', 'shared-sync')
    const program = `cd ${JSON.stringify(sat)}\n${preamble()}\nreset_sync_worktree . ${JSON.stringify(wt)} test-label trunk\n`
    const { code } = run(program)

    expect(code).toBe(0)
    const list = execFileSync('git', ['-C', sat, 'worktree', 'list'], { encoding: 'utf8' })
    expect(list).toContain('shared-sync')
  })

  it('re-stages cleanly on a SECOND round, where its own worktree already holds the branch', () => {
    // The everyday, non-colliding case this file's surrounding code exists to
    // keep working: a second day's round reuses the same branch so the still-
    // open PR gets updated rather than a new one opened.
    const sat = makeSatellite()
    const wt = join(sat, '.worktrees', 'shared-sync')
    execFileSync('git', ['-C', sat, 'worktree', 'add', '-q', wt, '-b', 'chore/sync-shared'])

    const program = `cd ${JSON.stringify(sat)}\n${preamble()}\nreset_sync_worktree . ${JSON.stringify(wt)} test-label trunk\n`
    const { code } = run(program)

    expect(code).toBe(0)
    const list = execFileSync('git', ['-C', sat, 'worktree', 'list'], { encoding: 'utf8' })
    expect(list).toContain('shared-sync')
  })

  it('THE BUG: stages cleanly even when a foreign worktree elsewhere holds chore/sync-shared', () => {
    const sat = makeSatellite()
    execFileSync('git', [
      '-C',
      sat,
      'worktree',
      'add',
      '-q',
      '.worktrees/pr379-gh-fix',
      '-b',
      'chore/sync-shared',
      'origin/trunk',
    ])
    const wt = join(sat, '.worktrees', 'shared-sync')

    const program = `cd ${JSON.stringify(sat)}\n${preamble()}\nreset_sync_worktree . ${JSON.stringify(wt)} test-label trunk\n`
    const { code, out } = run(program)

    // Before the fix this exits non-zero: `fatal: a branch named
    // 'chore/sync-shared' already exists` from the final `worktree add -b`.
    expect(code, out).toBe(0)
    const list = execFileSync('git', ['-C', sat, 'worktree', 'list'], { encoding: 'utf8' })
    expect(list).toContain('shared-sync')
    expect(list).not.toContain('pr379-gh-fix')
  })
})
