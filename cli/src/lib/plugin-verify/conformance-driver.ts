import type { CommandRunner } from '../plugin-compose/command-runner.js'

/**
 * The single Python entry point every conformance check is discovered and run
 * through (`packages/python-sdk/src/biffo_plugin_sdk/conformance/__main__.py`).
 *
 * This is the boundary the plan draws (biffo-template#1924, epic #1523): the
 * CLI owns composition (raise Postgres, invoke this twice, react to the exit
 * code), the SDK package owns what a check is and how it is discovered
 * (glob-and-run, no registry — the `pg_test_modules()` shape). Nothing here
 * re-implements discovery or formats a per-check verdict; both flows below
 * just run the module and pass its exit code through unchanged, the same
 * three-valued-exit discipline `packaged-script-command.ts` documents for the
 * packaged shell scripts.
 *
 * `--no-sync`: this repo's own CI (and a developer's local shell) already runs
 * `uv sync` as an explicit, visible step before `plugin verify` — letting `uv
 * run` silently re-resolve and mutate the environment (or the lockfile) as a
 * side effect of a verification command would make a supposedly read-only
 * gate capable of changing what it is about to check.
 */
const CONFORMANCE_MODULE = 'biffo_plugin_sdk.conformance'

function uvRunPython(runner: CommandRunner, cwd: string, args: string[], captureStdout = false) {
  return runner.run(
    'uv',
    ['run', '--no-sync', '--directory', cwd, 'python', '-m', CONFORMANCE_MODULE, ...args],
    { cwd, captureStdout },
  )
}

/** `--list-checks`: prints every declared #1523 seam and its implemented state. */
export function listChecks(runner: CommandRunner, cwd: string): number {
  const { status } = uvRunPython(runner, cwd, ['list-checks'])
  return status ?? 2
}

/** Runs every implemented check once against `dsn`. */
export function runChecksOnce(runner: CommandRunner, cwd: string, dsn: string): number {
  const { status } = uvRunPython(runner, cwd, ['run', '--repo-root', cwd, '--dsn', dsn])
  return status ?? 2
}
