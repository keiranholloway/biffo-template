import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `vitest.config.ts`'s scratch-dir sweep, extracted so it is unit-testable
 * (#1864) rather than only exercised implicitly by every `vitest` invocation
 * evaluating the config file.
 *
 * ## The bug this closes
 *
 * The sweep used to have exactly one signal for "is this `run-*` directory
 * safe to remove": its age against a flat `STALE_MS`. That is correct for a
 * run that crashed or was killed — nothing else ever tells the sweep such a
 * run is done — but it is the *only* signal available for a run that exited
 * normally too, and a normal exit is the common case. At measured
 * fleet-invocation frequency (15 runs inside one 2-hour window, #1864) the
 * age of a normally-finished run never crosses a 2-hour bar before more runs
 * have piled up behind it: 247,128 files across 15 `run-*` dirs accumulated,
 * of which only the newest still had a live process — the other 14 had
 * already finished and simply hadn't aged out yet.
 *
 * `markRunComplete` gives a normally-finished run a *positive* signal instead
 * of an inferred one: `sweepScratchRoot` removes a directory carrying the
 * completion marker immediately, regardless of age, so a well-behaved run's
 * fixtures are reclaimed on the very next invocation no matter how tightly
 * packed invocations are. Age (`staleMs`) is kept, unchanged, as the fallback
 * for the one case a marker can never cover — a run that never reaches its
 * own teardown because it was interrupted or killed. That is exactly the
 * #1197 guarantee this must not regress: a live run's own in-progress
 * fixtures (no marker yet, because it hasn't finished) are removed only once
 * they are older than `staleMs`, never because of how many *other* runs have
 * started since.
 */
export const COMPLETION_MARKER = '.complete'

/**
 * Remove every entry directly under `root` that is either marked complete
 * (`markRunComplete` already ran for it) or older than `staleMs`. Tolerates a
 * concurrent sweep — from another `vitest` invocation sharing the same OS
 * tmp root — winning the race and removing an entry first; that is the
 * intended outcome, not an error, so failing the whole suite over it would
 * trade a resource leak for a flaky gate.
 */
export function sweepScratchRoot(root: string, staleMs: number, now: number = Date.now()): void {
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry)
    try {
      const completed = existsSync(join(dir, COMPLETION_MARKER))
      const stale = now - statSync(dir).mtimeMs > staleMs
      if (completed || stale) rmSync(dir, { recursive: true, force: true })
    } catch {
      // A concurrent run swept it first, or removed it out from under us --
      // see the doc comment above.
    }
  }
}

/**
 * Record that `runDir` finished normally, so the next invocation's
 * `sweepScratchRoot` reclaims it immediately instead of waiting for it to
 * age out. Called once, from the `globalSetup` teardown
 * (`scratch-root-global-teardown.ts`) that fires after every test file in a
 * run has finished — never called at all if the process is killed rather
 * than exiting normally, which is deliberate: an unmarked directory is
 * exactly the case the age-based fallback above still exists for.
 *
 * Best-effort: a failed write here only means this run falls back to the
 * age-based sweep, exactly today's behaviour and never worse, so an error is
 * swallowed rather than failing an already-finished test run over its own
 * cleanup bookkeeping.
 */
export function markRunComplete(runDir: string): void {
  try {
    writeFileSync(join(runDir, COMPLETION_MARKER), '')
  } catch {
    // Best-effort -- see doc comment above.
  }
}
