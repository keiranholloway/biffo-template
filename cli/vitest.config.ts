import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'
import { RUN_DIR_ENV } from './src/test-utils/scratch-root-global-teardown.js'
import { sweepScratchRoot } from './src/test-utils/scratch-root.js'

/**
 * Every temp directory this run creates — including ones made by the shell
 * scripts the tests exec — lands under a single per-run directory, and stale
 * directories from earlier runs are reclaimed here.
 *
 * ## Why #1197's sweep was not enough
 *
 * `sweepTmpDirs` removes what the *current process* created, from `afterAll`.
 * That covers the ordinary path and nothing else:
 *
 *   - A run that is interrupted or killed never reaches `afterAll`, so
 *     everything it created leaks **permanently**.
 *   - Nothing has ever removed what a *previous* run leaked. There is no
 *     reclaim path at all, so the leak is monotonic.
 *   - Directories created by the shell scripts under test (`shared-sync.sh`
 *     and friends call `mktemp -d` themselves) were never tracked by
 *     `makeTmpDir`, so no in-process sweep could have seen them.
 *
 * The result, measured on 2026-08-03: **21,280 leaked fixture directories** in
 * `/tmp`, and a tmpfs at **100% of its 1,048,576 inodes with 7.5 GB still
 * free**. Every test that then tried to create a file failed with `ENOSPC`,
 * which reads as "disk full" and is not — so the failures looked like flaky
 * parallel interference, landed on a different set of tests each run, and cost
 * hours of investigation aimed at the wrong layer.
 *
 * ## Why TMPDIR rather than another cleanup hook
 *
 * Setting `TMPDIR` moves the problem from cleanup to *containment*: `tmpdir()`
 * reads it, so `makeTmpDir` lands here without changing a single call site, and
 * child processes inherit it, so scripts calling `mktemp -d` land here too —
 * the one class no in-process hook could reach. Cleanup then needs no
 * cooperation from the dying process, because the next run reclaims whatever
 * was left behind.
 *
 * ## Why age alone stopped being enough (#1864)
 *
 * `STALE_MS` used to be the *only* signal a `run-*` directory was safe to
 * remove, at a flat 2 hours: "several worktrees run this suite concurrently,
 * and a cutoff shorter than a run would let one run delete another's
 * fixtures mid-test." That reasoning is still correct for a run that never
 * reaches its own teardown (killed, interrupted) — nothing else can ever
 * tell the sweep such a run is done, so age stays its only signal and
 * `STALE_MS` stays unchanged for it.
 *
 * It stops being enough once invocations arrive faster than the window: 15
 * separate `vitest` runs landed inside one 2-hour span on 2026-09-02, so
 * nothing was ever old enough to sweep and 247,128 files piled up across 15
 * `run-*` dirs — 14 of which had already finished; only the newest still had
 * a live process. Age cannot distinguish "finished 90 minutes ago" from
 * "started 90 minutes ago and still running" without a window comfortably
 * longer than any real run, and that same window is what let 14 *finished*
 * runs sit unreclaimed.
 *
 * The fix is a second, *positive* signal a normal exit can leave behind that
 * a killed process cannot: `markRunComplete` (wired below via `globalSetup`)
 * writes a marker into this run's directory once every test file has
 * finished, and `sweepScratchRoot` removes a marked directory immediately,
 * regardless of age. A well-behaved run is now reclaimed on the very next
 * invocation no matter how tightly packed invocations are; a killed run
 * falls back to exactly the age-gated removal this file has always done. See
 * `test-utils/scratch-root.ts`'s doc comment for the full reasoning and unit
 * tests.
 */
const TMP_ROOT = join(tmpdir(), 'biffo-tests')
const STALE_MS = 2 * 60 * 60 * 1000

mkdirSync(TMP_ROOT, { recursive: true })
sweepScratchRoot(TMP_ROOT, STALE_MS)

const runDir = join(TMP_ROOT, `run-${process.pid}-${Date.now()}`)
mkdirSync(runDir, { recursive: true })
// Read back by scratch-root-global-teardown.ts's `teardown`, in the same
// main-thread process, once this run's test files have all finished.
process.env[RUN_DIR_ENV] = runDir

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test-setup.ts'],
    // Fires once, after every test file in this run has finished -- see this
    // file's "Why age alone stopped being enough" comment above and
    // scratch-root-global-teardown.ts for what it does (#1864).
    globalSetup: ['src/test-utils/scratch-root-global-teardown.ts'],
    // Vitest's 5s default is sized for in-process unit tests. This suite is
    // dominated by tests that shell out -- `git init`, `git clone`, a real
    // `shared-sync` round, `verify.sh` against a fixture repo -- and since
    // #1220 turned caching off, `turbo run test` runs it concurrently with
    // five other packages. Twelve of those subprocess tests then landed at
    // 5.0-7.3s and failed, having done nothing wrong.
    //
    // A timeout that depends on how busy the machine is reports a scheduling
    // delay as a defect, and a suite that fails only under load is one people
    // learn to re-run rather than read.
    testTimeout: 20_000,
    // Inherited by every worker and every process they spawn. TMP/TEMP are set
    // alongside it because `mktemp` and `os.tmpdir()` consult different names
    // across platforms, and a script that misses the override silently writes
    // back into /tmp — which is the leak, restored.
    env: { TMPDIR: runDir, TMP: runDir, TEMP: runDir },
  },
})
