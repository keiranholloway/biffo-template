import { execFileSync } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * `--reaffirm <token>` — biffo-template#1849.
 *
 * A PR can promise, in its own body, that it will not touch an issue's
 * `in-progress` claim — and then the same session's ordinary end-of-session
 * `--release` fires anyway, because AGENTS.md's own convention ("release it
 * ... on merge, or if you stop") is unconditional and has no carve-out for a
 * `Refs`-only PR that explicitly wants the issue to stay claimed through a
 * review window. PR #1848 made exactly that promise and broke it 21 seconds
 * later.
 *
 * `--reaffirm` gives a session making that promise something to actually RUN
 * as a last step: it re-applies the label and posts a claim comment
 * regardless of the four-signal check a fresh claim would run, because the
 * caller is asserting "stays taken", not asking "is this taken". The one
 * thing it refuses is clobbering a claim that already names a DIFFERENT,
 * live holder — that would turn "restore my own claim" into "steal someone
 * else's".
 */

const script = join(import.meta.dirname, '..', '..', '..', 'scripts', 'claim.sh')

function stub(opts: { holder: string; labels: string; state?: string }): string {
  const dir = makeTmpDir('claim-reaffirm')
  const gh = [
    '#!/usr/bin/env bash',
    'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then echo "owner/repo"; exit 0; fi',
    'if [ "$1" = "issue" ] && [ "$2" = "view" ]; then',
    '  case "$*" in',
    `    *comments*) echo "Claimed at 2026-08-21T00:00:00Z. claim-holder:${opts.holder} x" ;;`,
    '    *updatedAt*) echo "2026-08-21T00:00:00Z" ;;',
    `    *) printf '${opts.state ?? 'OPEN'}\\ta claimed issue\\t${opts.labels}\\n' ;;`,
    '  esac',
    '  exit 0',
    'fi',
    'if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then echo "edited: $*" >> "$CLAIM_TEST_LOG"; exit 0; fi',
    'if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then echo "commented: $*" >> "$CLAIM_TEST_LOG"; exit 0; fi',
    'if [ "$1" = "label" ] && [ "$2" = "create" ]; then exit 1; fi',
    'exit 0',
  ].join('\n')
  writeFileSync(join(dir, 'gh'), gh)
  chmodSync(join(dir, 'gh'), 0o755)
  const git = [
    '#!/usr/bin/env bash',
    'if [ "$1" = "config" ]; then echo "a person"; exit 0; fi',
    'if [ "$1" = "rev-parse" ]; then echo "agent/1083"; exit 0; fi',
    'exit 0',
  ].join('\n')
  writeFileSync(join(dir, 'git'), git)
  chmodSync(join(dir, 'git'), 0o755)
  return dir
}

function run(dir: string, args: string[]) {
  const log = join(dir, 'log')
  writeFileSync(log, '')
  try {
    const out = execFileSync('sh', [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CLAIM_TEST_LOG: log },
    })
    return { code: 0, out }
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string }
    return { code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

describe("--reaffirm keeps a claim alive past this session's own stop", () => {
  it('restores the label after a false release (the exact #1849 shape)', () => {
    const dir = stub({ holder: 'foreman-1083-r2', labels: 'meta,parked,lane:in-repo' })
    const { code, out } = run(dir, ['1083', '--reaffirm', 'foreman-1083-r2', '-R', 'owner/repo'])
    expect(code).toBe(0)
    expect(out).toContain('Reaffirmed')
    expect(out).toContain('foreman-1083-r2')
  })

  it('re-affirms an already-labeled claim it holds, idempotently', () => {
    const dir = stub({ holder: 'foreman-1083-r2', labels: 'in-progress' })
    const { code, out } = run(dir, ['1083', '--reaffirm', 'foreman-1083-r2', '-R', 'owner/repo'])
    expect(code).toBe(0)
    expect(out).toContain('Reaffirmed')
  })

  it('refuses to overwrite a claim already held by a DIFFERENT holder', () => {
    const dir = stub({ holder: 'someone-else-r1', labels: 'in-progress' })
    const { code, out } = run(dir, ['1083', '--reaffirm', 'foreman-1083-r2', '-R', 'owner/repo'])
    expect(code).toBe(1)
    expect(out).toContain('does not take over')
  })

  it('accepts --reaffirm --as <token>, the same order --release fixed', () => {
    const dir = stub({ holder: 'foreman-1083-r2', labels: 'meta,parked' })
    const { out } = run(dir, ['1083', '--reaffirm', '--as', 'foreman-1083-r2', '-R', 'owner/repo'])
    expect(out).toContain('Reaffirmed')
    // The specific mangling --release fixed: the flag becoming the holder and
    // the token falling through to overwrite the issue number.
    expect(out).not.toContain("'--as'")
  })

  it('refuses a reaffirm with no token, same message shape as an ordinary claim', () => {
    const dir = stub({ holder: 'foreman-1083-r2', labels: 'meta,parked' })
    const { code, out } = run(dir, ['1083', '--reaffirm', '-R', 'owner/repo'])
    expect(code).toBe(2)
    expect(out).toContain('--as <token> is required')
  })

  it('refuses to reaffirm a closed issue', () => {
    const dir = stub({ holder: 'foreman-1083-r2', labels: 'meta', state: 'CLOSED' })
    const { code, out } = run(dir, ['1083', '--reaffirm', 'foreman-1083-r2', '-R', 'owner/repo'])
    expect(code).toBe(1)
    expect(out).toContain('Already CLOSED')
  })
})
