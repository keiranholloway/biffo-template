import { execFileSync } from 'node:child_process'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * `claim.sh` must CREATE the `in-progress` label, not merely use it (#1289).
 *
 * ## Why
 *
 * AGENTS.md §1 requires the label, and nothing ever created it. On 2026-08-04 it
 * was absent in **12 of 16** estate repos, so `gh issue edit --add-label` failed
 * and `claim.sh` exited 2 — "cannot tell" — on every issue in those repos, for
 * ever. The coordination gate was structurally unable to pass across three
 * quarters of the estate.
 *
 * It went unnoticed because the two repos where claiming is exercised most,
 * `biffo-template` and `tabsii-platform`, were among the four that had it. The
 * mechanism worked exactly where it was watched.
 *
 * The knowledge was not missing — the `groom-backlog` skill has always created
 * the label defensively before claiming. It lived in a skill and not in the
 * tool, which is the same shape as the claim rule itself living in 4 of 11
 * skills until #1209 moved it into AGENTS.md. A rule enforced only where
 * somebody remembered it is not enforced.
 *
 * Creating it on the claim path (rather than in a setup step) means the
 * mechanism repairs itself in any repo where it is used, including one
 * scaffolded tomorrow that nobody thinks to bootstrap.
 */

const script = join(import.meta.dirname, '..', '..', '..', 'scripts', 'claim.sh')

/**
 * A `gh` stub that logs every call and reports an issue nobody has claimed, so
 * `claim.sh` reaches its claim path.
 */
function stubGh(): { dir: string; callLog: string } {
  const dir = makeTmpDir('claim-label')
  const callLog = join(dir, 'calls.log')
  writeFileSync(callLog, '')

  const gh = [
    '#!/usr/bin/env bash',
    `echo "gh $*" >> ${JSON.stringify(callLog)}`,
    // An open, unlabelled issue -> free. claim.sh passes --jq, so this must
    // emit what the real gh would AFTER jq: state<TAB>title<TAB>labels.
    'if [ "$1" = "issue" ] && [ "$2" = "view" ]; then',
    "  printf 'OPEN\\ta free issue\\t\\n'",
    '  exit 0',
    'fi',
    // No open or merged PRs reference it, and no remote branch names it.
    'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then exit 0; fi',
    // `label create` succeeds the first time; the real one exits non-zero when
    // the label already exists, which is why claim.sh must not treat it as fatal.
    'exit 0',
  ].join('\n')
  writeFileSync(join(dir, 'gh'), gh)
  chmodSync(join(dir, 'gh'), 0o755)

  const git = ['#!/usr/bin/env bash', 'exit 0'].join('\n')
  writeFileSync(join(dir, 'git-stub-ls-remote'), git)
  return { dir, callLog }
}

function runClaim(binDir: string) {
  try {
    // `--as` is mandatory since #1562; this file is about the label, so it
    // passes a fixed token and says so.
    const stdout = execFileSync('sh', [script, '4242', '--as', 'label-test-0813'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    })
    return { code: 0, out: stdout }
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string }
    return { code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

describe('claim.sh ensures the in-progress label exists (#1289)', () => {
  it('creates the label before trying to apply it', () => {
    const { dir, callLog } = stubGh()
    runClaim(dir)
    const calls = readFileSync(callLog, 'utf8')

    const createAt = calls.indexOf('label create in-progress')
    const addAt = calls.indexOf('--add-label')

    expect(
      createAt,
      `claim.sh never ran "gh label create in-progress". In a repo without the label, ` +
        `--add-label fails and claim exits 2 on every issue, for ever (#1289). Calls were:\n${calls}`,
    ).toBeGreaterThan(-1)
    expect(
      addAt === -1 || createAt < addAt,
      'the label must be created BEFORE it is applied, or the first claim in a fresh repo still fails',
    ).toBe(true)
  })

  it('passes the shared colour and description, so the label means the same thing everywhere', () => {
    const { dir, callLog } = stubGh()
    runClaim(dir)
    const calls = readFileSync(callLog, 'utf8')
    expect(calls).toContain('FBCA04')
    expect(calls).toMatch(/do not start work on this/i)
  })
})
