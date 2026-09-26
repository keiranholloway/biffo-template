import { describe, expect, it } from 'vitest'
import type { CommandResult, CommandRunner } from '../plugin-compose/command-runner.js'
import { listChecks, runChecksOnce } from './conformance-driver.js'

/**
 * `conformance-driver.ts` is the one boundary that shells into
 * `python -m biffo_plugin_sdk.conformance` (biffo-template#1924). These pin
 * the exact invocation — including `--no-sync`, so a supposedly read-only
 * verify command can never silently re-resolve the environment — and the
 * three-valued-exit-code discipline (`packaged-script-command.ts`'s
 * convention: a signal-killed child is never a pass).
 */
class RecordingRunner implements CommandRunner {
  calls: Array<{ cmd: string; args: string[]; opts: { cwd: string; captureStdout: boolean } }> = []
  constructor(private readonly result: CommandResult) {}
  run(cmd: string, args: string[], opts: { cwd: string; captureStdout: boolean }): CommandResult {
    this.calls.push({ cmd, args, opts })
    return this.result
  }
}

describe('listChecks', () => {
  it('invokes list-checks with no DSN and does not capture stdout', () => {
    const runner = new RecordingRunner({ status: 0, stdout: '' })
    expect(listChecks(runner, '/repo')).toBe(0)
    expect(runner.calls).toEqual([
      {
        cmd: 'uv',
        args: [
          'run',
          '--no-sync',
          '--directory',
          '/repo',
          'python',
          '-m',
          'biffo_plugin_sdk.conformance',
          'list-checks',
        ],
        opts: { cwd: '/repo', captureStdout: false },
      },
    ])
  })

  it('maps a signal-killed child (null status) to 2, never a pass', () => {
    const runner = new RecordingRunner({ status: null, stdout: '' })
    expect(listChecks(runner, '/repo')).toBe(2)
  })
})

describe('runChecksOnce', () => {
  it('invokes run with the repo root and DSN', () => {
    const runner = new RecordingRunner({ status: 0, stdout: '' })
    expect(runChecksOnce(runner, '/repo', 'postgres://x/y')).toBe(0)
    expect(runner.calls).toEqual([
      {
        cmd: 'uv',
        args: [
          'run',
          '--no-sync',
          '--directory',
          '/repo',
          'python',
          '-m',
          'biffo_plugin_sdk.conformance',
          'run',
          '--repo-root',
          '/repo',
          '--dsn',
          'postgres://x/y',
        ],
        opts: { cwd: '/repo', captureStdout: false },
      },
    ])
  })

  it('passes a non-zero exit status through unchanged', () => {
    const runner = new RecordingRunner({ status: 1, stdout: '' })
    expect(runChecksOnce(runner, '/repo', 'postgres://x/y')).toBe(1)
  })

  it('maps a signal-killed child (null status) to 2, never a pass', () => {
    const runner = new RecordingRunner({ status: null, stdout: '' })
    expect(runChecksOnce(runner, '/repo', 'postgres://x/y')).toBe(2)
  })
})
