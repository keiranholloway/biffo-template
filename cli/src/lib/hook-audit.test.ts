import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The audit's only job is to distinguish a hook that will run from one that
 * will not, and the case that matters is `DEAD` — `core.hooksPath` set to a
 * directory that is missing. Git skips every hook, says nothing, and exits 0.
 *
 * That is the state the whole estate was in: 5 of 37 working trees on
 * 2026-07-29, including the one where the RLS work was being done. So the audit
 * must **exit non-zero** on it. An audit that reports a problem in text and
 * exits 0 gets wired into a pipeline that ignores it.
 */
const script = join(import.meta.dirname, '..', '..', '..', 'scripts', 'hook-audit.sh')

function repo(hooksPath?: string, withHooks = false) {
  const dir = mkdtempSync(join(tmpdir(), 'hookaudit-'))
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'dev'])
  if (hooksPath) {
    execFileSync('git', ['-C', dir, 'config', 'core.hooksPath', hooksPath])
    if (withHooks) {
      mkdirSync(join(dir, hooksPath), { recursive: true })
      for (const h of ['pre-commit', 'pre-push', 'commit-msg']) {
        writeFileSync(join(dir, hooksPath, h), '#!/usr/bin/env sh\nexit 0\n')
        chmodSync(join(dir, hooksPath, h), 0o755)
      }
    }
  }
  return dir
}

function audit(estate: string) {
  try {
    const stdout = execFileSync('bash', [script, '--estate', estate], { encoding: 'utf8' })
    return { code: 0, stdout }
  } catch (e) {
    const err = e as { status: number; stdout: string }
    return { code: err.status, stdout: err.stdout }
  }
}

describe('hook-audit', () => {
  it('fails on a tree whose hooksPath points at nothing', () => {
    const estate = mkdtempSync(join(tmpdir(), 'estate-'))
    const r = repo('.githooks') // configured, directory never created
    execFileSync('cp', ['-r', r, join(estate, 'dead-repo')])
    const { code, stdout } = audit(estate)
    expect(stdout).toContain('DEAD')
    // Non-zero is the point. A report nobody can gate on is a report nobody reads.
    expect(code).toBe(1)
  })

  it('passes a tree whose hooks are present', () => {
    const estate = mkdtempSync(join(tmpdir(), 'estate-'))
    const r = repo('.githooks', true)
    execFileSync('cp', ['-r', r, join(estate, 'armed-repo')])
    const { code, stdout } = audit(estate)
    expect(stdout).toContain('ARMED')
    expect(code).toBe(0)
  })

  /**
   * A repo with no hooks is honest — it makes no claim to be protected. It is
   * reported so the gap is visible, but it does not fail the audit, or the
   * twenty-five sibling and plugin trees would drown the five that are lying.
   */
  it('reports an unconfigured tree without failing', () => {
    const estate = mkdtempSync(join(tmpdir(), 'estate-'))
    const r = repo()
    execFileSync('cp', ['-r', r, join(estate, 'bare-repo')])
    const { code, stdout } = audit(estate)
    expect(stdout).toContain('NO-HOOKS')
    expect(code).toBe(0)
  })

  /**
   * git's own .sample files are never executed. Counting the default hooks
   * directory as armed because it is non-empty would manufacture exactly the
   * false comfort this script exists to remove.
   */
  it('does not count git’s .sample files as hooks', () => {
    const estate = mkdtempSync(join(tmpdir(), 'estate-'))
    const r = repo()
    execFileSync('cp', ['-r', r, join(estate, 'sample-repo')])
    const { stdout } = audit(estate)
    expect(stdout).toContain('NO-HOOKS')
    expect(stdout).not.toContain('ARMED')
  })
})

/**
 * #715: an audit that cannot see must never report health.
 *
 * The first version of `protection-audit.sh` read only stdout and matched with
 * `case`. On an unprotected branch `gh` prints its 404 JSON *to stdout*, which
 * fell through to the wildcard and was reported `ok` — so the audit passed
 * three genuinely unprotected branches and exited 0 on its very first run.
 *
 * Writing a fail-open into a check built to catch fail-open is the reason these
 * assertions exist. It was found by running it and reading every line, not by
 * trusting the summary.
 */
describe('protection-audit', () => {
  const script = readFileSync(
    join(import.meta.dirname, '..', '..', '..', 'scripts', 'protection-audit.sh'),
    'utf8',
  )

  it('believes the exit status, not the text gh printed', () => {
    expect(script).toMatch(/rc=\$\?/)
    expect(script).toMatch(/\[ "\$rc" -ne 0 \] && n=""/)
  })

  it('rejects a non-numeric response rather than treating it as a count', () => {
    // `gh`'s 404 body is not a number; matching it as one is what reported
    // "ok ... {"message":"Branch not protected"} required checks".
    expect(script).toMatch(/\*\[!0-9\]\*/)
  })

  it('refuses to report anything when gh is not authenticated', () => {
    expect(script).toContain('gh auth status')
    expect(script).toContain('exit 2')
    expect(script).toContain('Refusing to report health that was not observed')
  })

  it('counts a protected branch with zero required checks as a failure', () => {
    // Protected-but-requiring-nothing reads as protected in the GitHub UI and
    // gates nothing at all.
    expect(script).toContain('protected but 0 required checks')
  })
})
