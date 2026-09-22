import { describe, expect, it } from 'vitest'
import type { CommandResult, CommandRunner } from './command-runner.js'
import { raisePostgres } from './raise-postgres.js'

/**
 * `raisePostgres` shells to the already-distributed `pg-test-db.sh` and
 * expects it to print only the DSN on stdout (biffo-template#1924). These
 * exercise the three outcomes that script's own doc distinguishes: a clean
 * DSN, a non-zero exit, and the "exited 0 but printed nothing" edge that
 * would otherwise hand an empty DSN downstream as a confusing Postgres
 * connection error instead of a clear one here.
 */
class FakeRunner implements CommandRunner {
  constructor(private readonly result: CommandResult) {}
  calls: Array<{ cmd: string; args: string[]; opts: { cwd: string; captureStdout: boolean } }> = []
  run(cmd: string, args: string[], opts: { cwd: string; captureStdout: boolean }): CommandResult {
    this.calls.push({ cmd, args, opts })
    return this.result
  }
}

describe('raisePostgres', () => {
  it('returns the trimmed DSN on a clean exit with stdout', () => {
    const runner = new FakeRunner({ status: 0, stdout: 'postgres://localhost/test\n' })
    const result = raisePostgres(runner, 'scripts/pg-test-db.sh', '/repo')
    expect(result).toEqual({ dsn: 'postgres://localhost/test', status: 0 })
    expect(runner.calls).toEqual([
      { cmd: 'scripts/pg-test-db.sh', args: [], opts: { cwd: '/repo', captureStdout: true } },
    ])
  })

  it('passes a non-zero exit status through with no DSN', () => {
    const runner = new FakeRunner({ status: 1, stdout: '' })
    expect(raisePostgres(runner, 'scripts/pg-test-db.sh', '/repo')).toEqual({
      dsn: null,
      status: 1,
    })
  })

  it('maps a signal-killed child (null status) to 2, never a pass', () => {
    const runner = new FakeRunner({ status: null, stdout: '' })
    expect(raisePostgres(runner, 'scripts/pg-test-db.sh', '/repo')).toEqual({
      dsn: null,
      status: 2,
    })
  })

  it('treats a clean exit with empty stdout as a failure, not an empty DSN', () => {
    const runner = new FakeRunner({ status: 0, stdout: '   \n' })
    expect(raisePostgres(runner, 'scripts/pg-test-db.sh', '/repo')).toEqual({
      dsn: null,
      status: 1,
    })
  })
})
