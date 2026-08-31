import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * `scripts/doctor-sweep.sh` (#1682, milestone 3 — the periodic-sweep half),
 * driven end to end as a real subprocess. It is a thin discovery loop over
 * `scripts/biffo.sh doctor --fix`, so the thing worth proving is the loop
 * itself — which repos it calls into, which it skips, and that one repo's
 * outcome never stops the sweep from reaching the next — not `doctor --fix`'s
 * own judgement (that is `doctor-reaper.test.ts`'s job).
 *
 * `scripts/biffo.sh` is stubbed per fake repo rather than faked wholesale, so
 * the assertion is "the sweep invoked THIS repo's own biffo.sh with `doctor
 * --fix`, from THIS repo's own directory" — the exact two facts a real
 * `scripts/biffo.sh` needs to resolve the right pinned CLI.
 */
const SCRIPT = join(import.meta.dirname, '..', '..', '..', 'scripts', 'doctor-sweep.sh')

let estate: string

beforeEach(() => {
  estate = makeTmpDir('biffo-doctor-sweep-estate')
})
afterEach(() => {
  rmSync(estate, { recursive: true, force: true })
})

/** A fake repo: a `.git` marker and, unless `withCli` is false, a stub
 * `scripts/biffo.sh` that records its own invocation and exits `exitCode`. */
function makeFakeRepo(
  name: string,
  opts: { withCli?: boolean; exitCode?: number; callLog: string },
): void {
  const dir = join(estate, name)
  mkdirSync(join(dir, '.git'), { recursive: true })
  if (opts.withCli === false) return
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  const stub = join(dir, 'scripts', 'biffo.sh')
  writeFileSync(
    stub,
    `#!/bin/sh\necho "CALLED name=${name} cwd=$(pwd) args=$*" >> "${opts.callLog}"\nexit ${String(opts.exitCode ?? 0)}\n`,
  )
  chmodSync(stub, 0o755)
}

function runSweep(): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('sh', [SCRIPT, '--estate', estate], { encoding: 'utf8' })
    return { stdout, status: 0 }
  } catch (err) {
    const e = err as { stdout?: string; status?: number }
    return { stdout: e.stdout ?? '', status: e.status ?? 1 }
  }
}

describe('doctor-sweep.sh', () => {
  it('calls scripts/biffo.sh doctor --fix from within each repo that has one', () => {
    const callLog = join(estate, 'calls.log')
    writeFileSync(callLog, '')
    makeFakeRepo('repo-a', { callLog })
    makeFakeRepo('repo-b', { callLog })

    const { status } = runSweep()
    expect(status).toBe(0)

    const calls = execFileSync('cat', [callLog], { encoding: 'utf8' })
    expect(calls).toContain(`CALLED name=repo-a cwd=${join(estate, 'repo-a')} args=doctor --fix`)
    expect(calls).toContain(`CALLED name=repo-b cwd=${join(estate, 'repo-b')} args=doctor --fix`)
  })

  it('skips a git repo with no scripts/biffo.sh, and reports it as skipped, not failed', () => {
    const callLog = join(estate, 'calls.log')
    writeFileSync(callLog, '')
    makeFakeRepo('no-cli-repo', { withCli: false, callLog })

    const { stdout, status } = runSweep()
    expect(status).toBe(0)
    expect(stdout).toContain('1 skipped')
    expect(stdout).not.toContain('CALLED')
  })

  it('never enters a directory with no .git at all', () => {
    mkdirSync(join(estate, 'not-a-repo'), { recursive: true })
    const { stdout, status } = runSweep()
    expect(status).toBe(0)
    expect(stdout).toContain('0 repo(s) swept')
    expect(stdout).toContain('0 skipped')
  })

  it("one repo's non-zero doctor exit does not stop the sweep from reaching the next repo", () => {
    const callLog = join(estate, 'calls.log')
    writeFileSync(callLog, '')
    makeFakeRepo('repo-broken', { exitCode: 1, callLog })
    makeFakeRepo('repo-fine', { exitCode: 0, callLog })

    const { stdout } = runSweep()

    const calls = execFileSync('cat', [callLog], { encoding: 'utf8' })
    expect(calls).toContain('CALLED name=repo-broken')
    expect(calls).toContain('CALLED name=repo-fine')
    expect(stdout).toContain('1 repo(s) swept, 1 reported findings')
  })

  it('refuses without --estate', () => {
    expect(() => execFileSync('sh', [SCRIPT], { encoding: 'utf8', stdio: 'pipe' })).toThrow()
  })
})
