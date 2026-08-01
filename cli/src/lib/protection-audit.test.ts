import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `protection-audit.sh` answers two questions that look like one.
 *
 * "Is the branch protected" it has answered since #715. "Does that protection
 * bind anybody" it did not, and for ~3 weeks the answers differed on 11 of 12
 * estate repos: `enforce_admins: false` makes every required check advisory for
 * a repo admin, and every merge here is made by an admin. The audit reported
 * `OK  protection  19 branches checked, all protected` every single morning
 * while that was true.
 *
 * So the case that matters is `ADVISORY` — full required-check list, protection
 * present, binds nobody — and the audit must **exit non-zero** on it. An audit
 * that prints a problem and exits 0 gets wired into a pipeline that ignores it,
 * which is the defect this file's subject already committed once (it reported
 * `ok` on three genuinely unprotected branches by reading 404 JSON off stdout).
 */
const script = join(import.meta.dirname, '..', '..', '..', 'scripts', 'protection-audit.sh')

/** A `gh` that answers only what the audit asks, keyed `owner/repo#branch`. */
function ghStub(dir: string, responses: Record<string, string>) {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'auth') process.exit(0)
const responses = ${JSON.stringify(responses)}
const m = String(args[1] || '').match(/^repos\\/(.+)\\/branches\\/(.+)\\/protection$/)
const value = m ? responses[m[1] + '#' + m[2]] : undefined
if (value === undefined) {
  // What GitHub really does on an unprotected branch: 404 JSON on STDOUT.
  console.log(JSON.stringify({ message: 'Branch not protected' }))
  process.exit(1)
}
console.log(value)
`,
  )
  chmodSync(join(bin, 'gh'), 0o755)
  return bin
}

function estateWith(slugs: string[]) {
  const estate = mkdtempSync(join(tmpdir(), 'protaudit-'))
  for (const slug of slugs) {
    const dir = join(estate, slug.split('/')[1])
    mkdirSync(dir, { recursive: true })
    execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'dev'])
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://github.com/${slug}.git`])
    execFileSync('git', [
      '-C',
      dir,
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    ])
    execFileSync('git', ['-C', dir, 'update-ref', 'refs/remotes/origin/dev', 'HEAD'])
  }
  return estate
}

function audit(estate: string, responses: Record<string, string>) {
  const bin = ghStub(estate, responses)
  const opts = {
    encoding: 'utf8' as const,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  }
  try {
    return { code: 0, stdout: execFileSync('bash', [script, '--estate', estate], opts) }
  } catch (e) {
    const err = e as { status: number; stdout: string }
    return { code: err.status, stdout: err.stdout }
  }
}

describe('protection-audit: does the protection bind anyone', () => {
  it('passes a branch whose protection binds admins', () => {
    const estate = estateWith(['acme/bound'])
    const { code, stdout } = audit(estate, { 'acme/bound#dev': '6 true' })

    expect(stdout).toContain('binds admins')
    expect(stdout).toContain('all protected and binding')
    expect(code).toBe(0)
  })

  it('FAILS a fully-gated branch that does not bind admins', () => {
    // The regression that matters: before this, `6 false` was reported `ok`.
    const estate = estateWith(['acme/advisory'])
    const { code, stdout } = audit(estate, { 'acme/advisory#dev': '6 false' })

    expect(stdout).toContain('ADVISORY')
    expect(stdout).toContain('does NOT bind admins')
    expect(code).toBe(1)
  })

  it('does not conflate "cannot read enforce_admins" with "false"', () => {
    // A null/absent field is an unknown. Reporting it as a definite `false`
    // would invent a finding; reporting it as `true` would hide one. Neither.
    const estate = estateWith(['acme/murky'])
    const { code, stdout } = audit(estate, { 'acme/murky#dev': '6 null' })

    expect(stdout).toContain('UNKNOWN')
    expect(stdout).toContain('enforce_admins unreadable')
    expect(stdout).not.toContain('does NOT bind admins')
    expect(code).toBe(1)
  })

  it('keeps the "branches checked" summary the daily dashboard greps for', () => {
    // scripts/practices-daily.sh matches this audit's summary with the literal
    // /branches checked/. A reworded summary silently reports "no summary line"
    // on the dashboard every morning, which is how a working audit goes blind.
    const estate = estateWith(['acme/advisory'])
    const { stdout } = audit(estate, { 'acme/advisory#dev': '6 false' })

    expect(stdout).toMatch(/branches checked/)
    expect(stdout).toContain('not binding admins')
  })

  it('still catches the cases it caught before', () => {
    const estate = estateWith(['acme/open', 'acme/gateless'])
    const { code, stdout } = audit(estate, { 'acme/gateless#dev': '0 true' })

    expect(stdout).toContain('UNPROTECTED')
    expect(stdout).toContain('NO CHECKS')
    expect(code).toBe(1)
  })
})
