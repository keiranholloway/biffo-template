import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

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
 * The stale cutoff is deliberately hours, not minutes: several worktrees run
 * this suite concurrently, and a cutoff shorter than a run would let one run
 * delete another's fixtures mid-test. A run takes ~15s, so this is four orders
 * of magnitude of headroom.
 */
const TMP_ROOT = join(tmpdir(), 'biffo-tests')
const STALE_MS = 2 * 60 * 60 * 1000

mkdirSync(TMP_ROOT, { recursive: true })
for (const entry of readdirSync(TMP_ROOT)) {
  const dir = join(TMP_ROOT, entry)
  try {
    if (Date.now() - statSync(dir).mtimeMs > STALE_MS) rmSync(dir, { recursive: true, force: true })
  } catch {
    // A concurrent run swept it first, which is the intended outcome, not an
    // error. Failing the whole suite because cleanup raced would trade a
    // resource leak for a flaky gate.
  }
}

const runDir = join(TMP_ROOT, `run-${process.pid}-${Date.now()}`)
mkdirSync(runDir, { recursive: true })

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test-setup.ts'],
    // Inherited by every worker and every process they spawn. TMP/TEMP are set
    // alongside it because `mktemp` and `os.tmpdir()` consult different names
    // across platforms, and a script that misses the override silently writes
    // back into /tmp — which is the leak, restored.
    env: { TMPDIR: runDir, TMP: runDir, TEMP: runDir },
  },
})
