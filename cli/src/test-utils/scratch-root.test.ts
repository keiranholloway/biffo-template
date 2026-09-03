import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMPLETION_MARKER, markRunComplete, sweepScratchRoot } from './scratch-root.js'
import { makeTmpDir } from './tmp.js'

const HOUR = 60 * 60 * 1000

/**
 * `vi.hoisted` because `vi.mock` factories are hoisted above ordinary
 * top-level declarations -- same pattern as `toctou-atomic-create.test.ts`.
 * Pass-through for every other `node:fs` consumer in this file (including
 * `makeTmpDir`) unless a test names a path to fail `statSync` on, so a real
 * "this entry vanished between readdirSync and statSync" race can be
 * exercised without touching real timing.
 */
const race = vi.hoisted(() => ({ statThrowsFor: null as string | null }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    statSync: (p: Parameters<typeof actual.statSync>[0]): ReturnType<typeof actual.statSync> => {
      if (race.statThrowsFor !== null && p === race.statThrowsFor) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${p}'`), {
          code: 'ENOENT',
        })
      }
      return actual.statSync(p)
    },
  }
})

afterEach(() => {
  race.statThrowsFor = null
})

/** `mkdirSync` under a fresh fixture root, with `mtimeMs` back-dated so age
 * assertions don't depend on real wall-clock sleeps in a test. `utimesSync`
 * would work too, but a directory's mtime is bumped by writing into it, so
 * `markRunComplete` calls below must run *after* this to be observed. */
function makeAgedDir(root: string, name: string): string {
  const dir = join(root, name)
  mkdirSync(dir)
  return dir
}

describe('sweepScratchRoot', () => {
  // Case matrix (issue #1864): a `run-*` directory's fate must depend on
  // completion state first, age second -- never on how many *other*
  // invocations have started since it was created.

  it('removes a marked-complete directory immediately, even though it is fresh (#1864)', () => {
    // This is the reported bug: 14 of 15 run-dirs had already finished and
    // were still well within STALE_MS when the sweep ran. A completion
    // marker must let a finished run go regardless of its age.
    const root = makeTmpDir('scratch-root-complete-fresh')
    const dir = makeAgedDir(root, 'run-1')
    markRunComplete(dir)

    sweepScratchRoot(root, HOUR, Date.now()) // "now" == dir's own mtime: as fresh as it gets

    expect(existsSync(dir)).toBe(false)
  })

  it('removes an unmarked directory once it is older than staleMs (unchanged #1197 fallback)', () => {
    const root = makeTmpDir('scratch-root-stale-unmarked')
    const dir = makeAgedDir(root, 'run-2')

    // Simulate a killed run: no marker was ever written, and enough wall time
    // has passed that the age fallback must still catch it.
    sweepScratchRoot(root, HOUR, Date.now() + 2 * HOUR)

    expect(existsSync(dir)).toBe(false)
  })

  it('does NOT remove a fresh, unmarked directory -- a live run in progress (#1197 guarantee)', () => {
    // The correctness constraint this must never regress: a concurrent run
    // that has not finished yet (no marker) and is not stale must survive,
    // no matter how many *other* sweeps run in the meantime.
    const root = makeTmpDir('scratch-root-live-run')
    const dir = makeAgedDir(root, 'run-3')

    sweepScratchRoot(root, HOUR, Date.now())

    expect(existsSync(dir)).toBe(true)
  })

  it('tolerates a directory a concurrent sweep removes between readdir and stat', () => {
    // A second `vitest` invocation sharing the same OS tmp root can win the
    // race and remove an entry between this process's `readdirSync` and its
    // `statSync` -- exactly what `race.statThrowsFor` simulates here, rather
    // than the weaker "call sweep twice" proxy for it.
    const root = makeTmpDir('scratch-root-race')
    const raced = makeAgedDir(root, 'run-4')
    const other = makeAgedDir(root, 'run-5') // must still be swept normally

    race.statThrowsFor = raced
    expect(() => sweepScratchRoot(root, HOUR, Date.now() + 2 * HOUR)).not.toThrow()

    expect(existsSync(other)).toBe(false) // the race was scoped to `raced` only
  })

  it('an empty root sweeps cleanly', () => {
    const root = makeTmpDir('scratch-root-empty')
    expect(() => sweepScratchRoot(root, HOUR)).not.toThrow()
  })
})

describe('markRunComplete', () => {
  it('writes the completion marker inside the run directory', () => {
    const runDir = makeTmpDir('scratch-root-mark')
    markRunComplete(runDir)
    expect(existsSync(join(runDir, COMPLETION_MARKER))).toBe(true)
    expect(readFileSync(join(runDir, COMPLETION_MARKER), 'utf8')).toBe('')
  })

  it('does not throw when the run directory no longer exists (best-effort)', () => {
    const runDir = makeTmpDir('scratch-root-mark-missing')
    // Simulate the directory already being gone (e.g. swept concurrently
    // before this run's own teardown ran) -- writeFileSync into a
    // nonexistent parent must not crash the process exiting the test run.
    const missing = join(runDir, 'already-removed-parent', 'run-x')
    expect(() => markRunComplete(missing)).not.toThrow()
  })

  it('a marked directory with no other activity is picked up by the next sweep', () => {
    // End-to-end shape of the fix: mark, then sweep, with nothing else
    // touching the directory in between -- proves the two functions agree on
    // the marker's name and location without hardcoding it twice.
    const root = makeTmpDir('scratch-root-roundtrip')
    const dir = join(root, 'run-5')
    mkdirSync(dir)
    writeFileSync(join(dir, 'fixture.txt'), 'still needed while running')

    markRunComplete(dir)
    sweepScratchRoot(root, HOUR, Date.now())

    expect(existsSync(dir)).toBe(false)
  })
})
