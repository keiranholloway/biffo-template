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

  it('an unreadable comment list is NOT treated as yours', () => {
    // Otherwise the flag becomes a way to steal a claim by breaking the lookup.
    const { dir } = stub({ comments: [], commentsExit: 1 })
    const { code, out } = run(dir, ['77', '--as', 'sess-abc', '--check'])
    expect(code, out).toBe(1)
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
})
