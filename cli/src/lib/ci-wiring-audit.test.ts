import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, cpSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * The audit distinguishes "the file landed" from "something calls it", and the
 * case that matters is the one that actually happened: on 2026-07-29
 * `shared-sync.sh` put the hardened dependency-audit scripts into twelve
 * satellites, eleven PRs merged, `--check` went clean — and **every one of
 * those repos carried on running the raw command**. Drift reached zero while
 * the outcome had not moved at all (#884).
 *
 * So the two cases that must not be confused are:
 *
 *   holds the script AND runs the raw command  -> UNWIRED, exit 1
 *   holds the script AND calls it              -> wired,   exit 0
 *
 * plus the trap that makes a naive implementation useless: both skeleton
 * workflows **name the raw command in a comment** directly above the step that
 * replaces it, so any check that greps the whole file reports every correctly
 * wired repo as broken.
 */
const script = join(import.meta.dirname, '..', '..', '..', 'scripts', 'ci-wiring-audit.sh')
const template = join(import.meta.dirname, '..', '..', '..')

function estate(repos: Record<string, { hasScript: boolean; ci: string }>) {
  const dir = makeTmpDir('ciwiring')
  for (const [name, spec] of Object.entries(repos)) {
    const d = join(dir, name)
    mkdirSync(join(d, '.github', 'workflows'), { recursive: true })
    execFileSync('git', ['-C', d, 'init', '-q', '-b', 'dev'])
    writeFileSync(join(d, '.github', 'workflows', 'ci.yml'), spec.ci)
    if (spec.hasScript) {
      mkdirSync(join(d, 'scripts'), { recursive: true })
      for (const s of ['js-dependency-audit.sh', 'py-dependency-audit.sh']) {
        writeFileSync(join(d, 'scripts', s), '#!/usr/bin/env sh\nexit 0\n')
      }
    }
  }
  return dir
}

function audit(dir: string) {
  try {
    // cwd is the template, because the script reads ITS shared-files.json for
    // the mapping — the manifest is the thing under test as much as the shell.
    const stdout = execFileSync('bash', [script, '--estate', dir], {
      encoding: 'utf8',
      cwd: template,
    })
    return { code: 0, stdout }
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string }
    return { code: err.status, stdout: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

const RAW_JS = `jobs:
  js:
    defaults:
      run:
        working-directory: apps/frontend
    steps:
      - name: Dependency audit
        run: pnpm audit --audit-level=high
`

const WIRED_JS = `jobs:
  js:
    defaults:
      run:
        working-directory: apps/frontend
    steps:
      # Replaces the raw \`pnpm audit --audit-level=high\`: fails on a real
      # advisory, INCONCLUSIVE on an unreachable registry (#591, #743).
      - name: Dependency audit
        run: sh ../../scripts/js-dependency-audit.sh
`

describe('ci-wiring-audit', () => {
  it('fails a repo that holds the script and still runs the raw command', () => {
    const { code, stdout } = audit(estate({ sat: { hasScript: true, ci: RAW_JS } }))
    expect(stdout).toContain('UNWIRED')
    // Exit code, not just text. An audit that reports a problem and exits 0
    // gets wired into a pipeline that ignores it — the daily collector renders
    // exit 0 as `OK`.
    expect(code).toBe(1)
  })

  it('passes a repo that calls the script, despite the comment naming the raw command', () => {
    // The trap. Both shipped skeletons look exactly like this.
    const { code, stdout } = audit(estate({ sat: { hasScript: true, ci: WIRED_JS } }))
    expect(stdout).toContain('wired')
    expect(stdout).not.toContain('UNWIRED')
    expect(code).toBe(0)
  })

  it('stays silent about a repo shared-sync has not reached yet', () => {
    // That repo IS broken, but it is shared-sync's finding. Reporting it here
    // too would count one defect twice and make both audits look worse than
    // the estate is — and the fix is a different command.
    const { code, stdout } = audit(estate({ sat: { hasScript: false, ci: RAW_JS } }))
    expect(stdout).toContain('holds no shared script')
    expect(stdout).not.toContain('UNWIRED')
    expect(code).toBe(0)
  })

  it('reports every offending repo, not just the first', () => {
    const { stdout } = audit(
      estate({
        a: { hasScript: true, ci: RAW_JS },
        b: { hasScript: true, ci: WIRED_JS },
        c: { hasScript: true, ci: RAW_JS },
      }),
    )
    expect(stdout.match(/UNWIRED/g)?.length).toBe(2)
    expect(stdout).toMatch(/b\s+.*wired/)
  })

  it('exits 2 — not 0 — when the manifest declares no mapping', () => {
    // The fail-open in the fail-open detector. An empty map means this audit
    // checked NOTHING, and 0 is what the daily collector renders as `OK`, so
    // deleting the map would turn the whole estate green.
    const dir = estate({ sat: { hasScript: true, ci: RAW_JS } })
    const fake = makeTmpDir('ciwiring-manifest')
    execFileSync('git', ['-C', fake, 'init', '-q', '-b', 'dev'])
    mkdirSync(join(fake, 'scripts'), { recursive: true })
    writeFileSync(join(fake, 'shared-files.json'), JSON.stringify({ version: 1, files: [] }))
    try {
      execFileSync('bash', [script, '--estate', dir], { encoding: 'utf8', cwd: fake })
      throw new Error('expected a non-zero exit')
    } catch (e) {
      const err = e as { status: number; stderr: string }
      expect(err.status).toBe(2)
      expect(err.stderr).toContain('checked nothing')
    } finally {
      rmSync(fake, { recursive: true, force: true })
    }
  })

  it('is clean against the real skeletons, which is the shipped form', () => {
    // A new satellite must be born wired. If this fails, every repo scaffolded
    // from now on inherits the defect #884 exists to close.
    //
    // The skeletons are COPIED into a temp estate and `git init`-ed rather than
    // audited in place. Pointing the audit at `_skeletons/` directly looks
    // right and asserts nothing: the estate walk skips any directory without a
    // `.git`, and a skeleton is a directory of files, not a repo — so the audit
    // sees zero repos and reports clean no matter what the workflows say. That
    // version of this test passed against a deliberately broken audit, which is
    // how it was caught.
    const dir = makeTmpDir('ciwiring-skel')
    let found = 0
    for (const skel of ['sibling-template', 'plugin-template']) {
      const src = join(template, '_skeletons', skel)
      if (!existsSync(join(src, '.github', 'workflows', 'ci.yml'))) continue
      found += 1
      const d = join(dir, skel)
      cpSync(src, d, { recursive: true })
      execFileSync('git', ['-C', d, 'init', '-q', '-b', 'dev'])
    }
    // Guards the guard: if the skeleton layout moves, this must fail loudly
    // rather than silently checking nothing again.
    expect(found, 'no skeleton ci.yml found — this test would assert nothing').toBe(2)

    const { code, stdout } = audit(dir)
    expect(stdout).toMatch(/sibling-template\s+.*wired/)
    expect(stdout).not.toContain('UNWIRED')
    expect(code).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })
})
