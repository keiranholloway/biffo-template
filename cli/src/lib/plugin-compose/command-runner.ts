import { spawnSync } from 'node:child_process'

/**
 * The one seam `biffo plugin verify` spawns processes through (biffo-template#1924).
 *
 * Injectable so the composition in `run-plugin-verify.ts` — raise Postgres, run the
 * conformance checks twice, react to each exit code — is testable without a real
 * `uv`, a real Python, or a real database. `RealCommandRunner` is what `plugin-verify.ts`
 * (the command) wires up for an actual invocation.
 */
export interface CommandResult {
  /** `null` means the child was killed by a signal, never a clean exit. */
  status: number | null
  stdout: string
}

export interface CommandRunner {
  run(
    cmd: string,
    args: string[],
    opts: { cwd: string; captureStdout: boolean; env?: Record<string, string> },
  ): CommandResult
}

export class RealCommandRunner implements CommandRunner {
  run(
    cmd: string,
    args: string[],
    opts: { cwd: string; captureStdout: boolean; env?: Record<string, string> },
  ): CommandResult {
    const result = spawnSync(cmd, args, {
      cwd: opts.cwd,
      ...(opts.env ? { env: opts.env } : {}),
      // Progress/errors always go to the terminal so a human watching a local
      // run (or CI's own log) sees them as they happen; stdout is captured only
      // when the caller needs the value back (pg-test-db.sh's DSN) — capturing
      // it unconditionally would silence the conformance checks' own printed
      // denominators, which are the whole point of this feature (#1363's shape).
      stdio: ['ignore', opts.captureStdout ? 'pipe' : 'inherit', 'inherit'],
      encoding: 'utf8',
    })
    // A signal-terminated child has a null status; the caller decides how to
    // treat that (never as a pass — same convention as packaged-script-command.ts).
    return { status: result.status, stdout: result.stdout ?? '' }
  }
}
