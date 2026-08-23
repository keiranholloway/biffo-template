import { execFileSync } from 'node:child_process'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * A claim can be proved to be YOURS (#1279).
 *
 * ## Why
 *
 * A claim recorded WHEN and WHO, and every session on this workstation claims
 * under the same GitHub actor. So a delegated agent could not distinguish
 * "my orchestrator claimed this on my behalf" from "a stranger claimed it 90
 * seconds ago" — and the rules it follows say never steal a fresh claim, so the
 * safe reading is to stop.
 *
 * On 2026-08-04 four agents were dispatched onto pre-claimed issues. One ran the
 * check before starting and correctly refused, producing nothing; the other
 * three had not reached the check when a correction arrived. **Whether a
 * delegate worked or stalled depended on whether it happened to check first** —
 * timing-dependent and silent.
 *
 * The token is opaque and identifies a SESSION, not a person. It is not a
 * secret: it appears in a public comment, and it only ever grants the right to
 * treat your own reservation as your own.
 */

const script = join(import.meta.dirname, '..', '..', '..', 'scripts', 'claim.sh')

/** A `gh` stub whose issue carries the label and the given claim comments. */
function stub(opts: { comments: string[]; commentsExit?: number }): {
  dir: string
  callLog: string
} {
  const dir = makeTmpDir('claimholder')
  const callLog = join(dir, 'calls.log')
  writeFileSync(callLog, '')
  const fixture = join(dir, 'comments.json')
  writeFileSync(fixture, JSON.stringify({ comments: opts.comments.map((body) => ({ body })) }))

  const gh = [
    '#!/usr/bin/env bash',
    `echo "gh $*" >> ${JSON.stringify(callLog)}`,
    'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then echo "owner/repo"; exit 0; fi',
    'if [ "$1" = "issue" ] && [ "$2" = "view" ]; then',
    '  case "$*" in',
    // The comment lookup claim_held_by makes — forward the real --jq.
    '    *comments*)',
    ...(opts.commentsExit
      ? [`      exit ${opts.commentsExit} ;;`]
      : [
          '      for a in "$@"; do if [ "$prev" = "--jq" ]; then jqexpr="$a"; fi; prev="$a"; done',
          `      jq -r "$jqexpr" ${JSON.stringify(fixture)} ;;`,
        ]),
    '    *updatedAt*) echo "2026-08-04T00:00:00Z" ;;',
    // Labelled, so the label signal fires and the holder check decides.
    "    *) printf 'OPEN\\ta claimed issue\\tin-progress\\n' ;;",
    '  esac',
    '  exit 0',
    'fi',
    'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then exit 0; fi',
    'exit 0',
  ].join('\n')
  writeFileSync(join(dir, 'gh'), gh)
  chmodSync(join(dir, 'gh'), 0o755)
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

const claimedBy = (token: string) =>
  `Claimed at 2026-08-04T00:00:00Z by \`agent\`. claim-holder:${token} Release it...`

describe('claim holder identity (#1279)', () => {
  it('a claim carrying MY token is not a collision', () => {
    const { dir } = stub({ comments: [claimedBy('sess-abc')] })
    const { code, out } = run(dir, ['77', '--as', 'sess-abc', '--check'])
    expect(code, out).toBe(0)
    expect(out).toMatch(/that is you/i)
  })

  it("a claim carrying SOMEONE ELSE's token still blocks", () => {
    const { dir } = stub({ comments: [claimedBy('sess-other')] })
    const { code, out } = run(dir, ['77', '--as', 'sess-abc', '--check'])
    expect(code, out).toBe(1)
    expect(out).toMatch(/in-progress|label/i)
  })

  it('a claim with NO token still blocks — ownership cannot be assumed', () => {
    // Backward compatible: every claim made before this existed carries none,
    // and an untokened claim must not become claimable by anyone passing --as.
    const { dir } = stub({
      comments: ['Claimed at 2026-08-04T00:00:00Z by `agent`. Release it...'],
    })
    const { code, out } = run(dir, ['77', '--as', 'sess-abc', '--check'])
    expect(code, out).toBe(1)
  })

  /**
   * #1691: an unreadable comment list must NOT be treated as yours (that half
   * was always safe -- otherwise the flag becomes a way to steal a claim by
   * breaking the lookup), and it must ALSO not be reported as a confident
   * "Taken". Both facts used to collapse onto the same `claim_held_by`
   * `return 1`, so `claim.sh` refused for the right reason (never grant a
   * claim on an unreadable check) but told a false story about why: "Taken"
   * implies the label's holder was actually determined and is someone else,
   * when in fact the read simply failed. Distinguishing the two matters for
   * anyone acting on the message, and this repo's own convention already
   * reserves exit 2 for exactly this ("cannot tell", `wait-for-checks.sh`,
   * `branch-health.sh`) -- `claim.sh` just never used it for this signal.
   */
  it('an unreadable comment list reports CANNOT TELL, not a confident Taken or yours', () => {
    const { dir } = stub({ comments: [], commentsExit: 1 })
    const { code, out } = run(dir, ['77', '--as', 'sess-abc', '--check'])
    expect(code, out).toBe(2)
    expect(out).toMatch(/cannot tell/i)
    expect(out).not.toMatch(/that is you/i)
    expect(out).not.toMatch(/^Taken\./m)
  })

  it('the newest claim wins, so a re-claim supersedes an older session', () => {
    const { dir } = stub({ comments: [claimedBy('sess-old'), claimedBy('sess-new')] })
    expect(run(dir, ['77', '--as', 'sess-new', '--check']).code).toBe(0)
    expect(run(dir, ['77', '--as', 'sess-old', '--check']).code).toBe(1)
  })

  it('--release refuses when the token does not match', () => {
    const { dir, callLog } = stub({ comments: [claimedBy('sess-other')] })
    const { code, out } = run(dir, ['77', '--release', 'sess-abc'])
    expect(code, out).toBe(1)
    expect(out).toMatch(/refusing to release/i)
    expect(readFileSync(callLog, 'utf8')).not.toContain('--remove-label')
  })

  it('--release removes the label when the token matches', () => {
    const { dir, callLog } = stub({ comments: [claimedBy('sess-abc')] })
    const { code, out } = run(dir, ['77', '--release', 'sess-abc'])
    expect(code, out).toBe(0)
    expect(readFileSync(callLog, 'utf8')).toContain('--remove-label')
  })

  /**
   * #826: `--release` with NO token at all — the trailing-flag form
   * `claim.sh <issue> --release`, which is exactly where the untokened
   * `claim <issue>` form (this file's own first documented usage) leads a
   * session that later wants to release what it claimed.
   *
   * The arg parser did `shift 2` to consume `--release` and its value; with
   * nothing left after the flag that shifts past the end of `$@`. Under real
   * `sh` on this workstation (dash), `shift` is a POSIX SPECIAL builtin, and
   * dash aborts the whole script on its error — non-interactively, before a
   * single line of this script's own error handling runs. That is a crash,
   * not the silent success the flag's caller sees reported: the exit status
   * is nonzero, but nothing here CHOSE it, and the message
   * ("shift: can't shift that many") explains a shell mechanism, not what the
   * caller did wrong or what to do about it.
   *
   * Run through `sh` exactly like the real invocation (`run()` above), so
   * this exercises dash's actual abort, not a bash-shaped guess at it.
   */
  it('--release with NO token refuses deliberately, not via a shell crash', () => {
    const { dir, callLog } = stub({ comments: [claimedBy('sess-abc')] })
    const { code, out } = run(dir, ['77', '--release'])
    expect(code, out).toBe(1)
    expect(out).toMatch(/token/i)
    expect(out).not.toMatch(/can't shift/i)
    expect(readFileSync(callLog, 'utf8')).not.toContain('--remove-label')
  })
})
