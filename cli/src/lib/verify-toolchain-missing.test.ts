/**
 * `scripts/verify.sh` in a fresh worktree where `pnpm install` has not yet
 * run (biffo-template#1497).
 *
 * Reported failure: `pnpm run lint`/`format:check`/etc. do not fail cleanly
 * when the package's dev dependencies were never installed — pnpm's own
 * recursive runner exits non-zero with `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`
 * (`Command "prettier" not found`), which the OLD `run_check` recorded as an
 * ordinary FAILED. The push gate then printed `Most format failures are one
 * command: pnpm run format` — advice that cannot work, because there is
 * still no formatter to run. The files were correctly formatted the whole
 * time; the tool to check them had simply never been installed.
 *
 * The fix distinguishes a THIRD state — applicable, attempted, could not
 * execute — from "ran and found a real problem". It is filed as
 * INCONCLUSIVE (exit 2), not FAILED (exit 1) and not NOT_RUN (which still
 * lets the rest of the run pass with an amber note): nothing in the
 * directory was verified at all, so the whole run must say "cannot tell",
 * the same convention pg-test's own timeout case already uses.
 *
 * Driven by running the real script against a real fixture repo with no
 * `node_modules`, not by reading the source — the defect is entirely in
 * runtime behaviour (which bucket a failure lands in, what exit code and
 * what advice come out), which a source-text assertion cannot see.
 */

import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SCRIPT = join(repoRoot, 'scripts/verify.sh')

interface Run {
  stdout: string
  status: number
}

/**
 * A package.json declaring a `format:check` script that shells out to a
 * binary that does not exist anywhere on PATH or in `node_modules/.bin` —
 * this is what `prettier --check` looks like from `pnpm run format:check`'s
 * point of view the moment `pnpm install` has not run: the SCRIPT is
 * declared, the BINARY it names is not there. No real prettier install is
 * needed to reproduce this; only the absence has to be genuine, which it is
 * by construction (no `node_modules` directory is ever created).
 */
const PACKAGE_JSON = JSON.stringify({
  name: 'p',
  scripts: {
    'format:check': 'this-binary-does-not-exist-anywhere --check .',
  },
})

function runIn(files: Record<string, string>): Run {
  const dir = makeTmpDir('biffo-verify-toolchain')
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir })
    for (const [rel, body] of Object.entries(files)) {
      const full = join(dir, rel)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, body)
    }
    const opts: ExecFileSyncOptions = { cwd: dir, encoding: 'utf8', stdio: 'pipe' }
    try {
      return { stdout: String(execFileSync('sh', [SCRIPT], opts)), status: 0 }
    } catch (err) {
      const e = err as { stdout?: string; status?: number }
      return { stdout: String(e.stdout ?? ''), status: e.status ?? -1 }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('verify.sh: a JS package with no node_modules is inconclusive, not failed', () => {
  it('reports INCONCLUSIVE and exits 2 — never FAILED/exit 1', () => {
    const run = runIn({ 'package.json': PACKAGE_JSON })

    expect(run.stdout).toContain('INCONCLUSIVE')
    expect(run.stdout).toContain('dependencies not installed')
    expect(run.status).toBe(2)
    expect(run.stdout).not.toContain('FAIL ')
    expect(run.stdout).not.toContain('verify failed')
  })

  it('tells the developer to run pnpm install, not pnpm run format', () => {
    // The reported defect exactly: the printed remedy must be a command that
    // could actually fix the state described (a missing toolchain), not the
    // generic FAILED-bucket advice, which fails identically for the same
    // reason the original check did.
    const run = runIn({ 'package.json': PACKAGE_JSON })

    expect(run.stdout).toContain('pnpm install')
    expect(run.stdout).not.toContain('Most format failures are one command')
  })

  it('does not touch a directory that already has node_modules', () => {
    const dir = makeTmpDir('biffo-verify-toolchain-installed')
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir })
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'p', scripts: { lint: 'true' } }),
      )
      mkdirSync(join(dir, 'node_modules'), { recursive: true })

      const opts: ExecFileSyncOptions = { cwd: dir, encoding: 'utf8', stdio: 'pipe' }
      let run: Run
      try {
        run = { stdout: String(execFileSync('sh', [SCRIPT], opts)), status: 0 }
      } catch (err) {
        const e = err as { stdout?: string; status?: number }
        run = { stdout: String(e.stdout ?? ''), status: e.status ?? -1 }
      }

      expect(run.stdout).not.toContain('dependencies not installed')
      expect(run.stdout).toContain('verify passed')
      expect(run.status).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
