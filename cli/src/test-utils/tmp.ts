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

/** Remove every directory `makeTmpDir` has created in this process and forget
 * them. Called once per test file from `test-setup.ts`; exported separately
 * so the guard/unit tests can exercise it directly. */
export function sweepTmpDirs(): void {
  for (const dir of created) {
    rmSync(dir, { recursive: true, force: true })
  }
  created.clear()
}
