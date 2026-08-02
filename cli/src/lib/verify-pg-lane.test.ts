/**
 * `verify.sh` must not be blind to a Postgres lane the repo demonstrably has.
 *
 * On 2026-08-02, **9 of 13** locally-catchable failing CI steps across the
 * estate were tabsii-platform's `rls-test` lane — a *required* check with no
 * local counterpart at all, because `verify.sh` contained no reference to
 * Postgres in any form. Every one of those failures was a genuine assertion
 * failure on a feature branch that a local run would have caught first.
 *
 * The lane costs a full CI round trip to discover. Locally it is ~2s to build
 * the schema and ~30s to run, so the arithmetic is not close.
 *
 * These tests drive the real script, because the defect is in its OUTPUT — what
 * it says when it cannot run the lane — and a test asserting on source text
 * would be the substring-guard mistake #957 exists to stop. The path that needs
 * a live Postgres is deliberately not unit-tested; what is pinned here is
 * everything that decides *whether* the lane runs and *how the gap is reported*,
 * which is where the fail-open lives.
 */

import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SCRIPT = join(repoRoot, 'scripts/verify.sh')

interface Run {
  stdout: string
  status: number
}

/**
 * `TABSII_TEST_PG_DSN` and `BIFFO_TEST_PG_DSN` are stripped from the child's
 * environment unless a test sets one.
 *
 * Without that, the suite's verdict depends on whether the developer running it
 * happens to have a database exported — the same machine-dependence that made
 * the `gitleaks` assertion in verify-no-ci.test.ts pass in CI and fail on a
 * workstation, and cost real trust when it was blamed on an innocent PR.
 */
function runIn(files: Record<string, string>, env: Record<string, string> = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), 'biffo-verify-pg-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir })
    for (const [rel, body] of Object.entries(files)) {
      const full = join(dir, rel)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, body)
    }
    const childEnv = { ...process.env, ...env }
    if (!('TABSII_TEST_PG_DSN' in env)) delete childEnv.TABSII_TEST_PG_DSN
    if (!('BIFFO_TEST_PG_DSN' in env)) delete childEnv.BIFFO_TEST_PG_DSN
    const opts: ExecFileSyncOptions = { cwd: dir, encoding: 'utf8', stdio: 'pipe', env: childEnv }
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

const PG_TEST = 'def test_rls():\n    assert True\n'
// A passing check, so these assertions reach the normal summary rather than the
// "ran NOTHING" branch, which exits before the summary is printed.
const PASSING = '{"name":"p","scripts":{"lint":"true"}}\n'

// No `pyproject.toml` in any fixture, deliberately. Adding one makes `verify.sh`
// try to run ruff/pyright/bandit/pytest in a throwaway venv that has none of
// them, so every Python check FAILS and the run never reaches the summary these
// tests are about. The lane is detected from the test filenames alone, and the
// no-DSN branch returns before any project directory is resolved, so the file
// buys nothing here except a machine-dependent failure.

describe('verify.sh finds Postgres-dependent tests by convention', () => {
  it('is n/a in a repo that has none', () => {
    const run = runIn({ 'package.json': PASSING })

    expect(run.stdout).toContain('no Postgres-dependent tests')
    // A repo without the lane must NOT be told it is missing coverage.
    expect(run.stdout).not.toContain('NOT RUN')
  })

  it('finds them by the *_pg.py convention the CI lane selects by', () => {
    // Convention, not a hand-maintained list: adding a Postgres test and
    // forgetting to register it is a fail-open waiting to happen.
    const run = runIn({
      'package.json': PASSING,
      'services/api/tests/test_territories_pg.py': PG_TEST,
    })

    expect(run.stdout).toContain('1 Postgres module(s) present')
  })
})

describe('verify.sh reports a lane it cannot run as a GAP, not as inapplicable', () => {
  // The whole defect class: absence and blindness printing identically. A repo
  // that HAS the lane and a repo that does not must not produce the same line.
  const withLane = {
    'package.json': PASSING,
    'services/api/tests/test_rls_pg.py': PG_TEST,
  }

  it('warns loudly when the modules exist but no DSN is set', () => {
    const run = runIn(withLane)

    expect(run.stdout).toContain('NOT RUN')
    expect(run.stdout).toContain('nothing local is checking them')
  })

  it('does NOT file it under "not applicable here"', () => {
    const run = runIn(withLane)

    const summary = run.stdout.split('\n').find((l) => l.includes('not applicable here')) ?? ''
    expect(summary).not.toContain('pg-test')
    expect(run.stdout).toContain('APPLICABLE BUT NOT RUN')
  })

  it('does not block the push over a database being down', () => {
    // Deliberately a warning rather than a failure. A gate that fails because
    // Docker is not running is one people learn to bypass, and a bypassed gate
    // is the counter-metric H4 pre-registered as refuting itself.
    expect(runIn(withLane).status).toBe(0)
  })

  it('names the variable that fixes it', () => {
    expect(runIn(withLane).stdout).toContain('BIFFO_TEST_PG_DSN')
  })
})

describe('verify.sh ignores nested checkouts when counting the lane', () => {
  it('skips agent worktrees kept inside the repo under .claude/', () => {
    // Measured wrong before this exclusion existed: tabsii-platform reported 66
    // modules where its CI lane runs 40, because an agent tool keeps worktrees
    // in `.claude/worktrees/`. Running a stale nested copy would fail a push
    // over code that is not being pushed.
    const run = runIn({
      'package.json': PASSING,
      'services/api/tests/test_rls_pg.py': PG_TEST,
      '.claude/worktrees/agent-1/services/api/tests/test_rls_pg.py': PG_TEST,
      '.worktrees/other/services/api/tests/test_rls_pg.py': PG_TEST,
    })

    expect(run.stdout).toContain('1 Postgres module(s) present')
  })
})
