import { execFileSync } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * `--release` must not swallow a FLAG as its holder token.
 *
 * ## Why this one cost days
 *
 * The parser took `$2` unconditionally, so the natural `--release --as <token>`
 * set the holder to the literal string `--as`, and the real token then fell
 * through to the positional slot and **overwrote the issue number**. What came
 * out was:
 *
 *     claim: #foreman-2026-08-21-cron is not held by '--as' — refusing to release it.
 *
 * That reads as *"the holder does not match"*, not *"your flags are in the wrong
 * order"*. So the fleet concluded no claim could ever be released, fell back to
 * removing `in-progress` by hand, and mostly stopped bothering — its own journal
 * records the workaround on 2026-08-20 and cites it again on 2026-08-21.
 *
 * Claims then accumulated, and a claimed issue is undispatchable, so the
 * dispatchable queue drained itself one dispatch at a time.
 * `tabsii-com/tabsii-platform#567` sat claimed from 08-17 to 08-21 with no
 * branch, no PR and no live session.
 *
 * `--release <token>` was always correct and always worked. The defect is that
 * the wrong form was ACCEPTED AND MANGLED rather than refused, and the error it
 * produced pointed away from the real mistake.
 */

const script = join(import.meta.dirname, '..', '..', '..', 'scripts', 'claim.sh')

function stub(holder: string): string {
  const dir = makeTmpDir('claim-release-parse')
  // The issue is claimed by `holder`. A release naming that token must succeed;
  // one naming anything else must be refused. Both outcomes are only reachable
  // if the ISSUE NUMBER survived parsing, which is the point of the test.
  const gh = [
    '#!/usr/bin/env bash',
    'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then echo "owner/repo"; exit 0; fi',
    'if [ "$1" = "issue" ] && [ "$2" = "view" ]; then',
    '  case "$*" in',
    `    *comments*) echo "Claimed at 2026-08-21T00:00:00Z. claim-holder:${holder} x" ;;`,
    '    *updatedAt*) echo "2026-08-21T00:00:00Z" ;;',
    "    *) printf 'OPEN\\ta claimed issue\\tin-progress\\n' ;;",
    '  esac',
    '  exit 0',
    'fi',
    'exit 0',
  ].join('\n')
  writeFileSync(join(dir, 'gh'), gh)
  chmodSync(join(dir, 'gh'), 0o755)
  const git = [
    '#!/usr/bin/env bash',
    'if [ "$1" = "config" ]; then echo "a person"; exit 0; fi',
    'exit 0',
  ].join('\n')
  writeFileSync(join(dir, 'git'), git)
  chmodSync(join(dir, 'git'), 0o755)
  return dir
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

describe('--release does not eat a flag as its token', () => {
  it('accepts --release --as <token>, the form the fleet actually writes', () => {
    const dir = stub('tok-abc')
    const { out } = run(dir, ['892', '--release', '--as', 'tok-abc', '-R', 'owner/repo'])
    expect(out).toContain('Released')
    // The specific mangling: the flag became the holder and the token became
    // the issue. Either string appearing means the parse regressed.
    expect(out).not.toContain("'--as'")
    expect(out).not.toContain('#tok-abc')
  })

  it('still accepts the documented --release <token> form', () => {
    const dir = stub('tok-abc')
    const { out } = run(dir, ['892', '--release', 'tok-abc', '-R', 'owner/repo'])
    expect(out).toContain('Released')
  })

  it('still refuses a token that is not the holder, in BOTH forms', () => {
    // The safety property must survive the fix: a release is not a way to steal
    // somebody else's claim by guessing.
    for (const args of [
      ['892', '--release', 'wrong-tok', '-R', 'owner/repo'],
      ['892', '--release', '--as', 'wrong-tok', '-R', 'owner/repo'],
    ]) {
      const { out } = run(stub('tok-abc'), args)
      expect(out).toContain('not held by')
      expect(out).toContain('#892')
    }
  })
})
