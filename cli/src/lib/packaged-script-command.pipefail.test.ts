import { execFileSync, spawnSync as realSpawnSync } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'
import { runPackagedScript } from './packaged-script-command.js'

/**
 * #1723's evidence bar, matching #1709's own: a real minimal-shell
 * environment, not a mocked `spawnSync` and not a static syntax check.
 * `packaged-script-command.test.ts` mocks `node:child_process` module-wide
 * for its argument-shape assertions, which is the right tool for "did we
 * call spawnSync with the right arguments" but cannot prove the argument
 * shape actually avoids the failure — that requires a real process tree and
 * a real shell that rejects `set -o pipefail` at runtime, which no build on
 * this workstation does (Ubuntu 26.04's dash tolerates it). This file is
 * separate and does NOT mock `child_process`, so it can drive the exported
 * `runPackagedScript` through a REAL `spawnSync` end to end.
 *
 * The real minimal shell comes from a real `docker run ubuntu:24.04` — the
 * same base image the GitHub-hosted runner uses, and the same one
 * `scripts/branch-health-workflow-run-attribution.test.sh` and
 * `scripts/practices-daily-sh-invocation.test.sh` cite for #1709's own
 * verification. Its dash (0.5.12-6ubuntu5) rejects `set -o pipefail` with
 * "Illegal option -o pipefail", exit 2 — confirmed live for this PR:
 *
 *   $ docker run --rm -v "$DIR:/w" ubuntu:24.04 sh /w/repro.sh
 *   /w/repro.sh: 2: set: Illegal option -o pipefail    (exit 2)
 *   $ docker run --rm -v "$DIR:/w" ubuntu:24.04 /w/repro.sh
 *   ran ok                                             (exit 0)
 *
 * — where `repro.sh` is `#!/usr/bin/env bash` + `set -uo pipefail`, the same
 * shape `branch-health.sh`, `gate-coverage.sh` and `hook-audit.sh` carry.
 * The first invocation is the OLD `packagedScriptCommand` behaviour (force
 * `sh`, discarding the script's own shebang); the second is bare-exec, what
 * `runPackagedScript` does after this fix. `dash -n`/`bash -n` pass on
 * `repro.sh` unchanged in both cases — this is a runtime option-parse
 * failure, not a syntax error, which is exactly why a static check cannot
 * catch it.
 *
 * `runPackagedScript` itself always execs directly on the HOST (no shell
 * indirection), so it cannot be pointed at a script living only inside a
 * container. Instead the "packaged script" handed to it here is a small
 * bash+pipefail WRAPPER — safe to run on this host, since native bash never
 * rejects `pipefail` (only some `sh`/dash builds do) — whose own job is to
 * shell out to the two `docker run` invocations above and compare their exit
 * codes against what the fix predicts. That keeps the assertion on the real,
 * exported `runPackagedScript` function while still requiring the real
 * minimal shell to agree.
 */

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const hasDocker = dockerAvailable()
if (!hasDocker) {
  // Loud, not silent (AGENTS.md's own complaint about a quiet skip: "a runner
  // without uv skipped quietly and the gap warning never printed"). This
  // prints even though the test below is also marked skipped, so a CI log
  // shows plainly that the strongest check in this file did not run.
  console.error(
    'packaged-script-command.pipefail.test.ts: no docker on PATH -- skipping the real ' +
      'minimal-shell reproduction. This is the ONLY test in this repo that reproduces the ' +
      '#1723/#1709 class against a real ubuntu-24.04 dash rather than a mock or a static ' +
      'syntax check; its absence here is not evidence the fix is correct.',
  )
}

describe('runPackagedScript against a real minimal shell (#1723)', () => {
  it.skipIf(!hasDocker)(
    "dispatches a bash-shebang + pipefail script the way the GitHub runner's real dash accepts, not the way it rejects",
    () => {
      const dir = makeTmpDir('biffo-pipefail-repro')

      const payload = join(dir, 'repro.sh')
      writeFileSync(payload, '#!/usr/bin/env bash\nset -uo pipefail\necho "ran ok"\n')
      chmodSync(payload, 0o755)

      const wrapper = join(dir, 'wrapper.sh')
      writeFileSync(
        wrapper,
        [
          '#!/usr/bin/env bash',
          'set -uo pipefail',
          '',
          '# OLD packagedScriptCommand dispatch: force sh, discarding the',
          "# script's own bash shebang. Must fail on a real ubuntu-24.04 dash.",
          'docker run --rm -v "$1:/w" ubuntu:24.04 sh /w/repro.sh >/tmp/old.out 2>/tmp/old.err',
          'old_rc=$?',
          '',
          '# NEW dispatch (this fix): bare-exec, kernel reads the shebang.',
          '# Must succeed on the same real dash.',
          'docker run --rm -v "$1:/w" ubuntu:24.04 /w/repro.sh >/tmp/new.out 2>/tmp/new.err',
          'new_rc=$?',
          '',
          'if [ "$old_rc" -eq 2 ] && grep -q "Illegal option" /tmp/old.err && [ "$new_rc" -eq 0 ] && grep -q "ran ok" /tmp/new.out; then',
          '  exit 0',
          'fi',
          'echo "old_rc=$old_rc new_rc=$new_rc" >&2',
          'cat /tmp/old.err /tmp/new.out /tmp/new.err >&2',
          'exit 1',
          '',
        ].join('\n'),
      )
      chmodSync(wrapper, 0o755)

      // Exercise the REAL exported function with a REAL (unmocked) spawnSync.
      const status = runPackagedScript(wrapper, [dir], dir)

      expect(status).toBe(0)

      // Sanity: prove the harness itself is real by driving spawnSync
      // directly too, independent of runPackagedScript's own plumbing.
      const direct = realSpawnSync(wrapper, [dir], { cwd: dir, encoding: 'utf8' })
      expect(direct.status).toBe(0)
    },
    30_000,
  )
})
