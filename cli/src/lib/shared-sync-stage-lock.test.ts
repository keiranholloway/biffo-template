import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * `acquire_stage_lock`/`release_stage_lock` (#1160), evaluated in isolation.
 *
 * ## What these protect against
 *
 * `stage_repo`'s first act used to be an UNCONDITIONAL
 * `git worktree remove --force "$d/.worktrees/shared-sync"` against a FIXED,
 * unclaimed path -- so a second full round touching the same repo at any
 * point between a first round's phase 1 (staged) and phase 2 (shipped) would
 * silently delete the first round's staged tree. `shared-sync-concurrent-
 * runs.test.ts` proves that end to end with two genuinely concurrent
 * processes; this file proves the locking primitive itself, deterministically
 * and without a wall clock, the same way `shared-sync-ship-guard.test.ts`
 * proves `require_staged_worktree` by extracting it rather than driving the
 * whole script.
 *
 * ## Why extraction rather than the whole script
 *
 * The four properties below (atomic first acquire, staleness reclaim, a
 * timeout that names the holder, and release actually freeing the path) are
 * about the primitive's own logic, not about `stage_repo`'s surrounding
 * control flow -- driving the whole script to exercise a stale-lock reclaim
 * would mean killing a real child process at exactly the right instant, which
 * is itself a race. `guardSource`'s technique already establishes that
 * extracting a self-contained function and evaluating it under `bash -c` is a
 * trustworthy way to test shell logic in this file without wrapping the
 * script's own top-level side effects (manifest parsing, the staleness
 * preflight) around every case.
 */
const script = join(import.meta.dirname, '..', '..', '..', 'scripts', 'shared-sync.sh')

/** Extract a named function's body verbatim, the same way `guardSource()`
 * does for `require_staged_worktree` in shared-sync-ship-guard.test.ts. */
function functionSource(name: string): string {
  const lines = readFileSync(script, 'utf8').split('\n')
  const start = lines.findIndex((l) => l === `${name}() {`)
  expect(start, `${name}() not found -- has it been renamed?`).toBeGreaterThan(-1)
  const end = lines.findIndex((l, i) => i > start && l === '}')
  expect(end, `no closing brace for ${name}()`).toBeGreaterThan(start)
  return lines.slice(start, end + 1).join('\n')
}

/** `wt_log` stubbed to a no-op: the real one appends to `$SYNC_WT_LOG` under
 * `$HOME` by default, which these tests must not touch, and its own coverage
 * lives in shared-sync-worktree-log.test.ts. */
function preamble(lockWaitSeconds: number): string {
  return `wt_log() { :; }\nSYNC_LOCK_WAIT=${lockWaitSeconds}\n${functionSource('acquire_stage_lock')}\n${functionSource('release_stage_lock')}\n`
}

function run(program: string, env: NodeJS.ProcessEnv = {}) {
  try {
    const stdout = execFileSync('bash', ['-c', program], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: 15_000,
    })
    return { code: 0, out: stdout }
  } catch (e) {
    const err = e as { status: number | null; stdout: string; stderr: string }
    return { code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

describe('acquire_stage_lock / release_stage_lock', () => {
  it('acquires cleanly against a repo with no .worktrees/ yet, and records this pid', () => {
    const d = makeTmpDir('stage-lock')
    // Deliberately no `.worktrees/` -- a repo's very first sync round.
    const program = `${preamble(5)}\nacquire_stage_lock ${JSON.stringify(d)} some-repo\n`
    const { code } = run(program)

    expect(code).toBe(0)
    const lockDir = join(d, '.worktrees', '.shared-sync.lock')
    expect(existsSync(lockDir)).toBe(true)
    expect(readFileSync(join(lockDir, 'pid'), 'utf8').trim()).toMatch(/^\d+$/)
  })

  it('refuses a second acquire while the first is still live, and names the holder pid', () => {
    const d = makeTmpDir('stage-lock')
    mkdirSync(join(d, '.worktrees'), { recursive: true })
    const lockDir = join(d, '.worktrees', '.shared-sync.lock')
    mkdirSync(lockDir)
    // This TEST process's own pid: definitely alive for the duration of the
    // assertion, which is what `kill -0` is checking.
    writeFileSync(join(lockDir, 'pid'), String(process.pid))

    // SYNC_LOCK_WAIT=0: fail on the first check rather than sleeping in a unit
    // test. The wait loop itself is exercised by the concurrent-process test.
    const program = `${preamble(0)}\nacquire_stage_lock ${JSON.stringify(d)} some-repo\n`
    const { code, out } = run(program)

    expect(code).toBe(1)
    expect(out).toContain('CANNOT STAGE')
    expect(out).toContain(`locked by pid ${process.pid}`)
    // The lock must still be there -- a refused acquire must not clear
    // somebody else's lock on its way out.
    expect(existsSync(lockDir)).toBe(true)
  })

  it('reclaims a lock whose holder pid is no longer running, rather than waiting it out', () => {
    const d = makeTmpDir('stage-lock')
    mkdirSync(join(d, '.worktrees'), { recursive: true })
    const lockDir = join(d, '.worktrees', '.shared-sync.lock')
    mkdirSync(lockDir)
    // A pid that is certainly not a live process on this machine: 2^22-ish is
    // past the default pid_max, and 999999 wrapping back to something real is
    // astronomically unlikely inside a single test run.
    writeFileSync(join(lockDir, 'pid'), '999999')

    const program = `${preamble(0)}\nacquire_stage_lock ${JSON.stringify(d)} some-repo\n`
    const { code, out } = run(program)

    expect(code).toBe(0)
    expect(out).not.toContain('CANNOT STAGE')
    // Reclaimed AS THIS run -- the pid file now names the process that just
    // acquired it, not the dead one.
    expect(readFileSync(join(lockDir, 'pid'), 'utf8').trim()).not.toBe('999999')
  })

  it('release actually removes the lock, so a later acquire is not stuck waiting on it', () => {
    const d = makeTmpDir('stage-lock')
    const lockDir = join(d, '.worktrees', '.shared-sync.lock')
    const program = `${preamble(5)}
acquire_stage_lock ${JSON.stringify(d)} some-repo
[ -d ${JSON.stringify(lockDir)} ] || { echo "did not acquire" >&2; exit 1; }
release_stage_lock ${JSON.stringify(d)} some-repo
`
    const { code } = run(program)

    expect(code).toBe(0)
    expect(existsSync(lockDir)).toBe(false)
  })

  it('release on a lock that was never acquired is a harmless no-op', () => {
    const d = makeTmpDir('stage-lock')
    const program = `${preamble(5)}\nrelease_stage_lock ${JSON.stringify(d)} some-repo\n`
    const { code } = run(program)

    expect(code).toBe(0)
  })
})
