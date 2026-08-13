import { execFileSync } from 'node:child_process'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * `claim` refuses to write a claim it cannot prove is yours (#1562).
 *
 * ## Why
 *
 * `--as <token>` was optional, and the claim comment interpolated it with
 * `${HOLDER:+ …}` — so omitting the flag produced a claim with no holder, no
 * warning and exit 0. The safe variant existed and nothing steered anyone to
 * it: on 2026-08-13 `--as` appeared **zero** times in the `AGENTS.md` of every
 * satellite in the estate, and two concurrent sessions in one plugin repo
 * produced four claims that read identically and could not be attributed.
 *
 * An optional flag that carries the deciding information is a fail-open. So the
 * default is now a refusal that prints the command to run instead.
 */

const script = join(import.meta.dirname, '..', '..', '..', 'scripts', 'claim.sh')

/**
 * A `gh` stub for an issue that is entirely free.
 *
 * If the requirement under test ever regresses, these tests must not pass by
 * accident because the network was unavailable — the stub makes the claim path
 * fully reachable, so a missing refusal shows up as a *successful claim*.
 */
function stub(): { dir: string; callLog: string } {
  const dir = makeTmpDir('claim-as-required')
  const callLog = join(dir, 'calls.log')
  writeFileSync(callLog, '')
  const gh = [
    '#!/usr/bin/env bash',
    `echo "gh $*" >> ${JSON.stringify(callLog)}`,
    'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then echo "owner/repo"; exit 0; fi',
    'if [ "$1" = "issue" ] && [ "$2" = "view" ]; then',
    '  case "$*" in',
    '    *comments*) echo "" ;;',
    '    *updatedAt*) echo "2026-08-13T00:00:00Z" ;;',
    "    *) printf 'OPEN\\ta free issue\\t\\n' ;;",
    '  esac',
    '  exit 0',
    'fi',
    'exit 0',
  ].join('\n')
  writeFileSync(join(dir, 'gh'), gh)
  chmodSync(join(dir, 'gh'), 0o755)
  // No remote branches, so signal 3 stays quiet.
  const git = [
    '#!/usr/bin/env bash',
    'if [ "$1" = "ls-remote" ]; then exit 0; fi',
    'if [ "$1" = "rev-parse" ]; then echo "feat/1562-claim-as-mandatory"; exit 0; fi',
    'if [ "$1" = "config" ]; then echo "a person"; exit 0; fi',
    'exit 0',
  ].join('\n')
  writeFileSync(join(dir, 'git'), git)
  chmodSync(join(dir, 'git'), 0o755)
  return { dir, callLog }
}

function run(dir: string, args: string[]) {
  try {
    const out = execFileSync('sh', [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    })
    return { code: 0, out }
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string }
    return { code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

describe('--as is required', () => {
  it('refuses to claim without a token, and changes nothing', () => {
    const { dir, callLog } = stub()
    const { code, out } = run(dir, ['1562'])
    expect(code, out).toBe(2)
    expect(out).toMatch(/--as <token> is required/)
    // Exit 2 is "cannot tell", never "free" — and nothing was written.
    expect(readFileSync(callLog, 'utf8')).not.toMatch(/add-label|issue comment/)
  })

  it('refuses --check too, because an untokened check gives the WRONG answer', () => {
    // A delegate running --check without its orchestrator's token reads the
    // orchestrator's own claim as a stranger's and stalls. That is #1279's
    // failure, and it does not need a write to happen.
    const { code, out } = run(stub().dir, ['1562', '--check'])
    expect(code, out).toBe(2)
    expect(out).toMatch(/--as <token> is required/)
  })

  it('names the flag AND prints a runnable command with a derived token', () => {
    // "Useful" means an agent that hits this knows exactly what to type.
    const { out } = run(stub().dir, ['1562'])
    const suggestion = out.match(/claim 1562 --as (\S+)/)
    expect(suggestion, out).not.toBeNull()
    expect(suggestion![1]).toMatch(/^[a-z0-9][a-z0-9.-]*-\d{4}-[0-9a-f]+$/)
    // The branch is what makes it unique per unit of work, so it is in there.
    expect(suggestion![1]).toContain('1562-claim-as-mandatory')
    // And the release form uses the same token — no second thing to invent.
    expect(out).toContain(`--release ${suggestion![1]}`)
  })

  it('refuses a role word that every session would share', () => {
    // A mandatory field satisfied estate-wide with `--as agent` is worse than
    // an optional one: it manufactures a column that identifies nobody.
    for (const token of ['agent', 'bot', 'me', 'claude', 'x']) {
      const { code, out } = run(stub().dir, ['1562', '--as', token, '--check'])
      expect(code, `${token}: ${out}`).toBe(2)
      expect(out).toMatch(/does not identify a session/)
    }
  })

  it('accepts an ordinary session token', () => {
    const { code, out } = run(stub().dir, ['1562', '--as', 'tpl-groom-0813', '--check'])
    expect(code, out).toBe(0)
    expect(out).toMatch(/Free/)
  })

  it('writes the holder token into the claim comment, unconditionally', () => {
    const { dir, callLog } = stub()
    const { code, out } = run(dir, ['1562', '--as', 'tpl-groom-0813'])
    expect(code, out).toBe(0)
    expect(readFileSync(callLog, 'utf8')).toMatch(/claim-holder:tpl-groom-0813/)
  })
})

describe('the two paths that must stay untokened', () => {
  it('--guard runs with no token — it is the pre-push hook on every push', () => {
    // `.githooks/pre-push` calls `claim --guard "$branch"` in every repo, with
    // no token and no issue argument. Requiring one here would break `git push`
    // estate-wide to enforce a rule this path deliberately does not use: it
    // never compares identity, by design.
    const { code, out } = run(stub().dir, ['--guard', 'feat/1562-claim-as-mandatory'])
    expect(code, out).toBe(0)
    expect(out).not.toMatch(/--as <token> is required/)
  })

  it('--guard on a branch naming no issue is still silent', () => {
    const { code, out } = run(stub().dir, ['--guard', 'security/brace-expansion-5-0-9'])
    expect(code, out).toBe(0)
    expect(out).toBe('')
  })

  it('--release carries its own token and is unaffected', () => {
    const { code, out } = run(stub().dir, ['1562', '--release'])
    expect(code, out).toBe(1)
    expect(out).toMatch(/--release needs the token you claimed with/)
    expect(out).not.toMatch(/--as <token> is required/)
  })
})
