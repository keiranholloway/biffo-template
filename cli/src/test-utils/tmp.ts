import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `mkdtempSync(join(tmpdir(), '<prefix>-'))` called directly at 171+ sites
 * across the CLI test suite (#1197), most with no matching cleanup. `/tmp` is
 * a 16 GB tmpfs recreated at boot, and on a workstation running the suite via
 * the pre-push hook across several worktrees that reached tens of thousands
 * of leaked directories in days — RAM, not disk, filling until unrelated
 * tooling broke with `ENOSPC`.
 *
 * `makeTmpDir` is the one place a test creates a temp directory. It does not
 * rely on `afterEach`/`onTestFinished` being wired correctly at each of 71
 * call sites — including several that create a directory in `beforeAll`
 * (outlives any single test) or inside a nested helper (several frames from
 * the `it()` block) — because that is exactly the shape that already leaked.
 * Instead every directory it creates is tracked in module state, and
 * `sweepTmpDirs` (wired into `test-setup.ts`'s `afterAll`) removes everything
 * this process created once a test file's suite finishes, regardless of which
 * hook created it or whether the test that created it failed first.
 *
 * `no-raw-mkdtemp.test.ts` enforces that this is the ONLY call site: it walks
 * the AST of every `*.test.ts` file and fails on a direct `mkdtempSync` call.
 */
const created = new Set<string>()

/** Create a fresh temp directory under the OS tmp root, prefixed for easy
 * identification on disk. Registered for automatic cleanup — callers do not
 * need their own `rmSync`. */
export function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`))
  created.add(dir)
  return dir
}

/**
 * Recursively remove a directory a test is done with, tolerating a
 * transient `EBUSY`/`ENOTEMPTY`/`EPERM` removing a fixture that a real `git`
 * subprocess just wrote to. CI hit
 * `ENOTEMPTY: directory not empty, rmdir '.../.git/info'` removing a project
 * fixture immediately after `git commit` in
 * `plugin-install.integration.test.ts`, on the very next commit after this
 * one, and re-running the same check failed the same way twice.
 *
 * Not reproduced locally despite ~150 attempts (sequential, CPU-loaded,
 * and up to 6-way concurrent, all on this workstation's tmpfs `/tmp`) — a
 * `git` subprocess `execa` has already awaited to exit cannot still be
 * writing (POSIX write()s are durable in the VFS the instant the writing
 * process exits), so a *continuously racing writer* is not the mechanism.
 * The more plausible cause is the CI runner's real (non-tmpfs) disk taking
 * measurable time to apply a just-finished directory mutation under the I/O
 * load this suite's own `vitest.config.ts` docstring already documents
 * (several subprocess-heavy packages running concurrently) — a *bounded*
 * catch-up delay, not an indefinitely-growing directory. A synthetic repro
 * confirmed the distinction matters: `maxRetries`/`retryDelay` does **not**
 * reliably recover a directory some other process keeps writing new entries
 * into for the entire retry budget, but that isn't the shape this fix
 * targets — `maxRetries`/`retryDelay` are Node's own `fs.rmSync` options
 * built for exactly a brief, bounded ENOTEMPTY/EBUSY, which is the shape a
 * one-off metadata-write delay actually has.
 *
 * This is a plausible, principled fix for the documented error class — not
 * a confirmed-by-local-reproduction one. Every fixture directory this suite
 * recursively removes right after a real `git` subprocess should go through
 * this rather than a bare `rmSync(dir, { recursive: true, force: true })`.
 */
export function removeTmpDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

/** Remove every directory `makeTmpDir` has created in this process and forget
 * them. Called once per test file from `test-setup.ts`; exported separately
 * so the guard/unit tests can exercise it directly. */
export function sweepTmpDirs(): void {
  for (const dir of created) {
    removeTmpDir(dir)
  }
  created.clear()
}
