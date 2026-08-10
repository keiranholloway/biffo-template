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
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
 * `TABSII_TEST_PG_DSN` and `BIFFO_TEST_PG_DSN` are stripped from the child's
 * environment unless a test sets one.
 *
 * Without that, the suite's verdict depends on whether the developer running it
 * happens to have a database exported — the same machine-dependence that made
 * the `gitleaks` assertion in verify-no-ci.test.ts pass in CI and fail on a
 * workstation, and cost real trust when it was blamed on an innocent PR.
 */
function runIn(files: Record<string, string>, env: Record<string, string> = {}): Run {
  const dir = makeTmpDir('biffo-verify-pg')
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir })
    let hasStubBin = false
    for (const [rel, body] of Object.entries(files)) {
      const full = join(dir, rel)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, body)
      // `_stub-bin/` stands in for a real `uv` (and, for the timeout tests,
      // `timeout` itself) resolved off PATH -- unlike the `scripts/biffo.sh`
      // stub above, which verify.sh invokes as `sh scripts/biffo.sh ...` and
      // so never needs an exec bit, `command -v uv` / a bare `uv run ...`
      // requires the file to actually be executable.
      if (rel.startsWith('_stub-bin/')) {
        chmodSync(full, 0o755)
        hasStubBin = true
      }
    }
    const childEnv = { ...process.env, ...env }
    if (!('TABSII_TEST_PG_DSN' in env)) delete childEnv.TABSII_TEST_PG_DSN
    if (!('BIFFO_TEST_PG_DSN' in env)) delete childEnv.BIFFO_TEST_PG_DSN
    // Stub executables win over the real tools, without dropping the PATH the
    // rest of verify.sh needs (git, find, sed, date, ...) -- only when the
    // caller has not already pinned PATH itself (the "no uv installed" test
    // below relies on a deliberately narrow one).
    if (hasStubBin && !('PATH' in env)) {
      childEnv.PATH = `${join(dir, '_stub-bin')}:${process.env.PATH ?? ''}`
    }
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

  it('warns even on a machine with no uv, which is what CI runners are', () => {
    // Pins the ordering. The first version checked `uv not installed` BEFORE the
    // DSN, so a runner without uv skipped quietly and the gap warning never
    // printed: these tests passed on a workstation and failed in CI, for a
    // reason unconnected to the change under test. `uv` is needed to RUN the
    // lane, not to know the repo has one and nothing is checking it.
    const run = runIn(withLane, { PATH: '/usr/bin:/bin' })

    expect(run.stdout).toContain('NOT RUN')
    expect(run.stdout).not.toContain('uv not installed')
  })
})

describe('verify.sh provisions the database rather than asking you to remember', () => {
  // A gate that only runs when you exported the right variable is a gate that
  // runs on the days you did not need it, so the gate provisions the database
  // itself. Since #1109 it does that through `scripts/biffo.sh pg-test-db`
  // rather than a per-repo copy of the helper, so these fixtures stub the
  // BRIDGE — the contract being pinned is unchanged: the last stdout line is a
  // DSN, and anything else means the lane did not run.
  const lane = {
    'package.json': PASSING,
    'services/api/tests/test_rls_pg.py': PG_TEST,
  }

  it('uses the DSN the helper prints', () => {
    const run = runIn({
      ...lane,
      // Stands in for the real helper: the contract is "last stdout line is a
      // DSN", and that contract is what this pins.
      'scripts/biffo.sh': 'echo "postgresql+asyncpg://u:p@localhost:1/db"\n',
    })

    expect(run.stdout).not.toContain('NOT RUN')
  })

  it('falls back to the warning when the helper cannot provision one', () => {
    // No Docker, no server, no schema all end here — and the gate must say the
    // lane did not run rather than pretending a broken helper is a DSN.
    const run = runIn({
      ...lane,
      'scripts/biffo.sh': 'echo "pg-test-db: no Postgres and no docker" >&2\nexit 1\n',
    })

    expect(run.stdout).toContain('NOT RUN')
  })

  it('rejects helper output that is not a DSN', () => {
    // A helper that logs to stdout instead of stderr would otherwise hand the
    // gate a sentence and have it reported as a configured database.
    const run = runIn({ ...lane, 'scripts/biffo.sh': 'echo "ready"\n' })

    expect(run.stdout).toContain('NOT RUN')
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

describe('verify.sh blocks a NOT-RUN pg-test lane when the push is relevant (#656)', () => {
  // `BIFFO_PGTEST_DIFF_RELEVANT` is `.githooks/pre-push`'s signal, computed
  // from the actual ref list via `scripts/pgtest-diff-check.sh` (see
  // pgtest-diff-check.test.ts for that half). Setting it directly here pins
  // verify.sh's OWN response to the signal, independent of the hook that
  // produces it -- the same split `checkout_health` uses elsewhere in this
  // file: the detector and the decision are tested apart.
  const lane = {
    'package.json': PASSING,
    'services/api/tests/test_rls_pg.py': PG_TEST,
    // No `scripts/biffo.sh` stub here: verify.sh's own self-provisioning
    // attempt (`sh scripts/biffo.sh pg-test-db`) will fail with "command not
    // found" in this fixture and fall straight through to NOT RUN, same as a
    // real repo with no Docker reachable.
  }

  it('blocks when applicable, not run, and the diff touches db/imports/**', () => {
    const run = runIn(lane, { BIFFO_PGTEST_DIFF_RELEVANT: '1' })

    expect(run.status).toBe(1)
    expect(run.stdout).toContain('BLOCKED')
    expect(run.stdout).toContain('pg-test')
  })

  it('names both the DSN path and the escape hatch in the block message', () => {
    const run = runIn(lane, { BIFFO_PGTEST_DIFF_RELEVANT: '1' })

    expect(run.stdout).toContain('scripts/pg-test-db.sh')
    expect(run.stdout).toContain('BIFFO_TEST_PG_DSN')
    expect(run.stdout).toContain('BIFFO_SKIP_PGTEST=1')
  })

  it('does NOT block when the signal is absent (an unrelated diff)', () => {
    // The ordinary case: `.githooks/pre-push` never sets the variable for a
    // push that does not touch db/imports/** or a *_pg.py module, so this is
    // what every routine push through this fixture looks like.
    const run = runIn(lane)

    expect(run.status).toBe(0)
    expect(run.stdout).toContain('NOT RUN')
    expect(run.stdout).not.toContain('BLOCKED')
  })

  it('does not block once a DSN is set, even with the signal on', () => {
    // A configured DSN takes verify.sh past the `elif [ -z "$PG_TEST_DSN" ]`
    // branch this block lives in entirely -- here it lands on `skip pg-test
    // "no pyproject.toml..."` rather than running the lane for real (no
    // pyproject.toml fixture exists, deliberately -- see the file header: one
    // would make ruff/pyright/bandit run against a project that is not there
    // and fail for reasons unconnected to this test). Either way is "not the
    // NOT-RUN gap", and the point is the same: once a DSN reaches verify.sh,
    // `BIFFO_PGTEST_DIFF_RELEVANT` has nothing left to escalate.
    const run = runIn(lane, {
      BIFFO_PGTEST_DIFF_RELEVANT: '1',
      BIFFO_TEST_PG_DSN: 'postgresql+asyncpg://u:p@localhost:1/db',
    })

    expect(run.stdout).not.toContain('NOT RUN')
    expect(run.stdout).not.toContain('BLOCKED')
  })

  it('BIFFO_SKIP_PGTEST=1 overrides the block, and still reports NOT RUN honestly', () => {
    const run = runIn(lane, {
      BIFFO_PGTEST_DIFF_RELEVANT: '1',
      BIFFO_SKIP_PGTEST: '1',
    })

    expect(run.status).toBe(0)
    expect(run.stdout).toContain('NOT RUN')
    expect(run.stdout).not.toContain('BLOCKED')
  })
})

describe('verify.sh reports a killed pg-test lane as inconclusive, not failed (#703)', () => {
  // A `pyproject.toml` fixture is what every OTHER describe block above avoids
  // (see the file header) because it would make the general Python lane run
  // ruff/pyright/bandit/pytest for real. That is not a risk here: none of
  // these fixtures carry `.github/workflows/ci.yml`, and `ci_has()` gates
  // every one of those checks on a step existing there -- so with no CI file
  // they stay skipped and the fixture's real business, actually driving
  // `pg_test_run` to completion through a stubbed `uv`, is undisturbed.
  const lane = {
    'package.json': PASSING,
    'services/api/pyproject.toml': '',
    'services/api/tests/test_rls_pg.py': PG_TEST,
  }
  const dsn = { BIFFO_TEST_PG_DSN: 'postgresql+asyncpg://u:p@localhost:1/db' }

  it('exits 2 -- cannot tell, never a pass -- when the lane is killed by its own budget', () => {
    const run = runIn(
      {
        ...lane,
        // Never actually reached: the stub `timeout` below returns 124
        // immediately, so this only has to exist for `command -v uv`.
        '_stub-bin/uv': '#!/bin/sh\nexit 0\n',
        // Stands in for a REAL timeout(1) killing an overlong lane -- exit
        // 124 is the fact being pinned, not how a genuine test suite would
        // produce it.
        '_stub-bin/timeout': '#!/bin/sh\nexit 124\n',
      },
      { ...dsn, BIFFO_VERIFY_PG_BUDGET: '5' },
    )

    expect(run.status).toBe(2)
    expect(run.stdout).toContain('TIMED OUT after')
    expect(run.stdout).toContain('budget 5s')
    expect(run.stdout).toContain('INCONCLUSIVE')
    expect(run.stdout).toContain('verify inconclusive:')
    expect(run.stdout).toContain('pg-test')
    // The estate-wide contract this is joining: cannot-tell must never read
    // as either verdict.
    expect(run.stdout).not.toContain('verify failed:')
    expect(run.stdout).not.toContain('verify passed')
  })

  it('still exits 1 -- a real failure -- when the lane runs and a test genuinely fails', () => {
    const run = runIn(
      {
        ...lane,
        '_stub-bin/uv': '#!/bin/sh\necho "1 failed, 2 passed in 0.10s"\nexit 1\n',
      },
      dsn,
    )

    expect(run.status).toBe(1)
    expect(run.stdout).toContain('verify failed:')
    expect(run.stdout).toContain('pg-test')
    expect(run.stdout).toContain('1 failed')
    expect(run.stdout).not.toContain('INCONCLUSIVE')
    expect(run.stdout).not.toContain('TIMED OUT')
  })

  it('exits 0 when the lane runs for real and passes', () => {
    const run = runIn(
      {
        ...lane,
        '_stub-bin/uv': '#!/bin/sh\necho "3 passed in 0.10s"\nexit 0\n',
      },
      dsn,
    )

    expect(run.status).toBe(0)
    expect(run.stdout).toContain('verify passed')
    expect(run.stdout).toContain('pg-test')
  })
})

describe('verify.sh runs the pg lane concurrently where that is safe (#703)', () => {
  // Same reasoning as the block above for why a `pyproject.toml` is safe here.
  const lane = {
    'package.json': PASSING,
    'services/api/pyproject.toml': '',
    'services/api/tests/test_rls_pg.py': PG_TEST,
  }
  const dsn = { BIFFO_TEST_PG_DSN: 'postgresql+asyncpg://u:p@localhost:1/db' }

  // Every stub answers the `import xdist` probe first, because that is a real
  // `uv run` too -- a stub that treated it as a pytest invocation would report
  // one pass more than actually happened.
  const XDIST_OK = 'case "$*" in *"import xdist"*) exit 0 ;; esac\n'

  it('gives the parallel pass --dist loadfile, which is what keeps a file on one worker', () => {
    const run = runIn(
      {
        ...lane,
        // Fails on purpose: verify.sh only prints the lane's own output when it
        // fails, so failing is how the argv becomes observable at all.
        '_stub-bin/uv': `#!/bin/sh\n${XDIST_OK}echo "ARGV: $*"\necho "1 failed, 0 passed"\nexit 1\n`,
      },
      dsn,
    )

    expect(run.status).toBe(1)
    expect(run.stdout).toContain('--dist loadfile')
    expect(run.stdout).toContain('-m not serial')
  })

  it('runs a SECOND, serial pass once the parallel one is green', () => {
    const run = runIn(
      {
        ...lane,
        // Dispatched on argv, NOT on a marker file counting invocations: the
        // general `pytest(services/api)` check runs this same stub twice
        // before the pg lane starts, so a counter would report the serial pass
        // as having already happened. Matching `-m serial` also pins the
        // selection itself rather than merely that something ran twice.
        '_stub-bin/uv': [
          '#!/bin/sh',
          XDIST_OK.trim(),
          'case "$*" in',
          '  *"-m not serial"*) echo "3 passed"; exit 0 ;;',
          // Fails on purpose -- verify.sh prints the lane's output only on
          // failure, so this is how the second pass becomes observable.
          '  *"-m serial"*) echo "SECOND PASS ARGV: $*"; echo "1 failed, 0 passed"; exit 1 ;;',
          'esac',
          'echo "3 passed"',
          'exit 0',
          '',
        ].join('\n'),
      },
      dsn,
    )

    expect(run.status).toBe(1)
    expect(run.stdout).toContain('SECOND PASS ARGV:')
    expect(run.stdout).toContain('-m serial')
  })

  it('treats "no tests collected" from the serial pass as fine, not as a failure', () => {
    // The state of a repo that has adopted the split but marked nothing serial
    // yet. pytest exits 5 there, and reading that as a failure would break
    // every such repo on the day it takes the upgrade.
    const run = runIn(
      {
        ...lane,
        '_stub-bin/uv': [
          '#!/bin/sh',
          XDIST_OK.trim(),
          'case "$*" in *"-m serial"*) exit 5 ;; esac',
          'echo "3 passed"',
          'exit 0',
          '',
        ].join('\n'),
      },
      dsn,
    )

    expect(run.status).toBe(0)
    expect(run.stdout).toContain('verify passed')
    expect(run.stdout).not.toContain('verify failed:')
  })

  it('treats "no tests collected" from the PARALLEL pass as fine too, and still runs the serial pass', () => {
    // The mirror-image state (biffo-template#1453): every test in the only
    // test_*_pg.py file this repo currently has is marked serial, so
    // `-m 'not serial'` matches nothing and pytest exits 5 there instead.
    // Before this, a bare exit-5 read as a real failure and the serial pass
    // -- which DOES have tests -- never even ran, breaking this repo's own
    // pg lane the moment its first pg module went all-serial.
    const run = runIn(
      {
        ...lane,
        '_stub-bin/uv': [
          '#!/bin/sh',
          XDIST_OK.trim(),
          'case "$*" in',
          '  *"-m not serial"*) exit 5 ;;',
          '  *"-m serial"*) echo "3 passed"; exit 0 ;;',
          'esac',
          'echo "3 passed"',
          'exit 0',
          '',
        ].join('\n'),
      },
      dsn,
    )

    expect(run.status).toBe(0)
    expect(run.stdout).toContain('verify passed')
    expect(run.stdout).not.toContain('verify failed:')
  })

  it('falls back to one undivided pass, loudly, when pytest-xdist is missing', () => {
    // A repo that has taken the script but not re-run `uv sync`. `-n` would
    // abort with a usage error -- the gate failing over its own dependency
    // rather than over the code, which is what teaches people to skip it.
    const run = runIn(
      {
        ...lane,
        '_stub-bin/uv': [
          '#!/bin/sh',
          'case "$*" in *"import xdist"*) exit 1 ;; esac',
          'case "$*" in *"-n auto"*) echo "ERROR: unrecognized arguments: -n"; exit 4 ;; esac',
          'echo "3 passed"',
          'exit 0',
          '',
        ].join('\n'),
      },
      dsn,
    )

    expect(run.status).toBe(0)
    expect(run.stdout).toContain('pytest-xdist is not installed')
    expect(run.stdout).toContain('verify passed')
  })
})
