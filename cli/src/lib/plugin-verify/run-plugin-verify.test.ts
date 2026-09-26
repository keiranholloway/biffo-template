import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandResult, CommandRunner } from '../plugin-compose/command-runner.js'
import { type PluginVerifyDeps, runPluginVerify } from './run-plugin-verify.js'

vi.mock('../logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), step: vi.fn() },
}))

/**
 * `runPluginVerify` is the spine's composition (biffo-template#1924): raise
 * Postgres via `pg-test-db.sh`, run the discovered checks TWICE against that
 * same database, and react to each exit code. It owns no check logic of its
 * own, so these fake both seams (`CommandRunner`, `findScript`) rather than
 * spawning `uv` or a real Postgres — the injectability documented on
 * `PluginVerifyDeps` is exactly for this.
 *
 * The scripted responses are keyed on the invoked module/verb so the fake can
 * tell `pg-test-db.sh` apart from the two `python -m
 * biffo_plugin_sdk.conformance run` calls without depending on call order.
 */
class ScriptedRunner implements CommandRunner {
  calls: string[] = []
  constructor(
    private readonly responses: {
      pgTestDb?: CommandResult
      conformanceRuns?: CommandResult[]
      listChecks?: CommandResult
    },
  ) {}

  run(cmd: string, args: string[]): CommandResult {
    if (cmd === 'scripts/pg-test-db.sh') {
      this.calls.push('pg-test-db')
      return this.responses.pgTestDb ?? { status: 0, stdout: 'postgres://x/y\n' }
    }
    if (args.includes('list-checks')) {
      this.calls.push('list-checks')
      return this.responses.listChecks ?? { status: 0, stdout: '' }
    }
    if (args.includes('run')) {
      const index = this.calls.filter((c) => c === 'conformance-run').length
      this.calls.push('conformance-run')
      const runs = this.responses.conformanceRuns ?? [{ status: 0, stdout: '' }]
      return runs[Math.min(index, runs.length - 1)]
    }
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`)
  }
}

function deps(
  runner: CommandRunner,
  script: string | null = 'scripts/pg-test-db.sh',
): PluginVerifyDeps {
  return { runner, findScript: () => script }
}

describe('runPluginVerify', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('--list-checks bypasses Postgres entirely and returns its exit code', async () => {
    const runner = new ScriptedRunner({ listChecks: { status: 0, stdout: '' } })
    const code = await runPluginVerify(
      { cwd: '/repo', listChecks: true, realCore: false },
      deps(runner),
    )
    expect(code).toBe(0)
    expect(runner.calls).toEqual(['list-checks'])
  })

  it('propagates a non-zero --list-checks exit code', async () => {
    const runner = new ScriptedRunner({ listChecks: { status: 1, stdout: '' } })
    const code = await runPluginVerify(
      { cwd: '/repo', listChecks: true, realCore: false },
      deps(runner),
    )
    expect(code).toBe(1)
  })

  it('returns 2 when the packaged pg-test-db.sh script cannot be found', async () => {
    const runner = new ScriptedRunner({})
    const code = await runPluginVerify(
      { cwd: '/repo', listChecks: false, realCore: false },
      deps(runner, null),
    )
    expect(code).toBe(2)
    expect(runner.calls).toEqual([])
  })

  it('surfaces pg-test-db.sh failure without running any checks', async () => {
    const runner = new ScriptedRunner({ pgTestDb: { status: 3, stdout: '' } })
    const code = await runPluginVerify(
      { cwd: '/repo', listChecks: false, realCore: false },
      deps(runner),
    )
    expect(code).toBe(3)
    expect(runner.calls).toEqual(['pg-test-db'])
  })

  it('stops after the first run fails, never attempting the second', async () => {
    const runner = new ScriptedRunner({
      conformanceRuns: [
        { status: 1, stdout: '' },
        { status: 0, stdout: '' },
      ],
    })
    const code = await runPluginVerify(
      { cwd: '/repo', listChecks: false, realCore: false },
      deps(runner),
    )
    expect(code).toBe(1)
    expect(runner.calls).toEqual(['pg-test-db', 'conformance-run'])
  })

  it('fails the job when the second consecutive run fails, even though the first passed', async () => {
    const runner = new ScriptedRunner({
      conformanceRuns: [
        { status: 0, stdout: '' },
        { status: 1, stdout: '' },
      ],
    })
    const code = await runPluginVerify(
      { cwd: '/repo', listChecks: false, realCore: false },
      deps(runner),
    )
    expect(code).toBe(1)
    expect(runner.calls).toEqual(['pg-test-db', 'conformance-run', 'conformance-run'])
  })

  it('is green when both runs pass against the same database', async () => {
    const runner = new ScriptedRunner({
      conformanceRuns: [
        { status: 0, stdout: '' },
        { status: 0, stdout: '' },
      ],
    })
    const code = await runPluginVerify(
      { cwd: '/repo', listChecks: false, realCore: false },
      deps(runner),
    )
    expect(code).toBe(0)
    expect(runner.calls).toEqual(['pg-test-db', 'conformance-run', 'conformance-run'])
  })
})
