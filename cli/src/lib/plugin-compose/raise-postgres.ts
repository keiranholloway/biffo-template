import type { CommandRunner } from './command-runner.js'

export interface RaisedPostgres {
  /** `null` when provisioning failed — `status` names why. */
  dsn: string | null
  status: number
}

/**
 * Raises the local Postgres test database by shelling to the EXISTING,
 * already-distributed `scripts/pg-test-db.sh` (`cli/package.json`'s `files`)
 * — biffo-template#1924's spine deliberately does not write a new one.
 *
 * `pg-test-db.sh` prints ONLY the DSN on stdout (its own doc: "Only the DSN
 * reaches stdout, so it is safe to capture; progress goes to stderr") — no
 * `--export` flag here, since this process consumes the DSN directly rather
 * than needing it as a shell-sourceable `export` statement.
 */
export function raisePostgres(runner: CommandRunner, script: string, cwd: string): RaisedPostgres {
  const { status, stdout } = runner.run(script, [], { cwd, captureStdout: true })
  if (status !== 0) {
    return { dsn: null, status: status ?? 2 }
  }
  const dsn = stdout.trim()
  if (!dsn) {
    // pg-test-db.sh exited 0 but printed nothing on stdout -- treat exactly
    // like a failure rather than handing an empty DSN downstream, where it
    // would surface as a confusing Postgres connection error instead of a
    // clear one here.
    return { dsn: null, status: 1 }
  }
  return { dsn, status: 0 }
}
