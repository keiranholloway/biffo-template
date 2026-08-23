import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * `ship_repo` must refuse to run against a staged worktree that is not there,
 * and say so in its own words.
 *
 * On 2026-08-02 two repos in a 13-repo round reached phase 2 with the worktree
 * gone. Every `git -C "$wt" ...` failed with `fatal: cannot change to '<path>':
 * No such file or directory`, and the run reported `push failed` — attributing
 * the fatals to the last step it attempted rather than the first thing that was
 * wrong. That wording cost a session spent on push and permission theories.
 *
 * The cause is still unknown (#1160) and this does not fix it. It makes the
 * failure name itself, which is worth having whichever mechanism turns out to
 * remove the worktree.
 *
 * ## Why this extracts the function instead of running the script
 *
 * The condition is unreachable through the front door by construction: phase 2
 * only runs when phase 1 staged cleanly, and every route that removes the
 * worktree also stops the repo reaching phase 2. Driving the whole script to
 * reproduce it would mean stubbing `git` so `worktree add` reports success
 * without creating anything — at which point the test is asserting against a
 * fiction, not the guard.
 *
 * So the guard is a small, self-contained function taking only its arguments,
 * and this evaluates that function alone. `usage()` in the same file already
 * reads itself by line range, so extracting a delimited block from this script
 * is an established shape here rather than a new one.
 */
const script = join(import.meta.dirname, '..', '..', '..', 'scripts', 'shared-sync.sh')

/** The `require_staged_worktree` definition, lifted out of the script. */
function guardSource(): string {
  const lines = readFileSync(script, 'utf8').split('\n')
  const start = lines.findIndex((l) => l === 'require_staged_worktree() {')
  expect(start, 'require_staged_worktree() not found — has it been renamed?').toBeGreaterThan(-1)
  const end = lines.findIndex((l, i) => i > start && l === '}')
  expect(end, 'no closing brace for require_staged_worktree()').toBeGreaterThan(start)
  return lines.slice(start, end + 1).join('\n')
}

/** `wt_log` stubbed to a no-op, the same way `shared-sync-stage-lock.test.ts`
 * stubs it: `require_staged_worktree` calls it on the failure path, but this
 * file extracts that function alone, not the script that defines `wt_log`
 * above it. Without the stub, `bash -c` reports `wt_log: command not found`
 * on stderr — real output from a real defect (#1664), not a hypothetical:
 * the missing-worktree tests below call it every time and printed exactly
 * that line before this stub existed. The function still returns its correct
 * exit code and message either way, so no assertion here ever caught it. */
function callGuard(path: string) {
  const program = `wt_log() { :; }\n${guardSource()}\nrequire_staged_worktree ${JSON.stringify(path)} "some-repo"\n`
  try {
    const stdout = execFileSync('bash', ['-c', program], { encoding: 'utf8' })
    return { code: 0, out: stdout }
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string }
    return { code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

describe('require_staged_worktree', () => {
  it('passes silently when the staged worktree is there', () => {
    const dir = makeTmpDir('ship-guard')
    const { code, out } = callGuard(dir)

    expect(code).toBe(0)
    // The happy path is every repo in every run; it must add nothing to the output.
    expect(out).toBe('')
  })

  it('fails when the staged worktree is missing', () => {
    const { code } = callGuard(join(tmpdir(), 'ship-guard-definitely-not-here'))

    // Non-zero is what makes `ship_repo` return before its four `git -C` calls,
    // and what counts the repo as failed rather than shipped.
    expect(code).toBe(1)
  })

  it('names the condition rather than blaming the push', () => {
    const { out } = callGuard(join(tmpdir(), 'ship-guard-definitely-not-here'))

    expect(out).toContain('staged worktree missing')
    // The exact wording that misled: it must not reappear here.
    expect(out).not.toContain('push failed')
  })

  it('says nothing was pushed, so nobody goes looking for a half-open PR', () => {
    const { out } = callGuard(join(tmpdir(), 'ship-guard-definitely-not-here'))

    expect(out).toContain('Nothing was')
    expect(out).toContain('no PR was opened')
  })

  it('names the fixed concurrency cause and warns against assuming a repeat', () => {
    // The concurrency mechanism this guard was originally written against is
    // now established and fixed (acquire_stage_lock/release_stage_lock,
    // proven in shared-sync-concurrent-runs.test.ts). The guard stays as
    // defense-in-depth for any OTHER way the tree could vanish, so its
    // message no longer claims the cause is unknown -- but it still points at
    // #1160 and still warns that a future firing is not automatically the
    // same bug.
    const { out } = callGuard(join(tmpdir(), 'ship-guard-definitely-not-here'))

    expect(out).toContain('#1160')
    expect(out).not.toContain('Cause unknown')
    expect(out).toContain('fixed (#1160)')
    expect(out).toContain('Do not assume a repeat')
  })

  it('prints the path, since which repo it is is the first question', () => {
    const missing = join(tmpdir(), 'ship-guard-definitely-not-here')
    const { out } = callGuard(missing)

    expect(out).toContain(missing)
  })
})

describe('ship_repo', () => {
  it('calls the guard before any git command that needs the worktree', () => {
    const body = readFileSync(script, 'utf8')
    const shipRepo = body.slice(body.indexOf('\nship_repo() {'))

    const guardAt = shipRepo.indexOf('require_staged_worktree')
    const firstGitAt = shipRepo.indexOf('git -C "$wt"')

    expect(guardAt).toBeGreaterThan(-1)
    expect(firstGitAt).toBeGreaterThan(-1)
    // A guard that runs after the first `git -C "$wt"` would still emit the raw
    // fatal it exists to replace.
    expect(guardAt).toBeLessThan(firstGitAt)
  })
})
