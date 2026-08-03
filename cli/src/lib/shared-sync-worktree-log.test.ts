import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every create and every remove of a staged worktree is logged, with a
 * timestamp and the pid that did it.
 *
 * On 2026-08-02 two repos in a 13-repo round reached phase 2 with their staged
 * worktree gone, and three hypotheses were written and discarded against it: a
 * concurrent SHIP run (there was none — the four overlapping runs were all
 * `--check`, which never reaches `stage_repo`), an unchecked `worktree add`
 * (checked since #856), and a missing base ref (the ship path takes its base
 * from `gh repo view`). Nothing found can remove that directory.
 *
 * So this stops guessing and makes the next occurrence self-explaining. The
 * assertions below are about the properties that make the log *usable* for
 * that: a pid on every line, both ends of a run bracketed, and the
 * `MISSING-AT-SHIP` marker present so the reader can search backwards from it.
 */
const script = join(import.meta.dirname, '..', '..', '..', 'scripts', 'shared-sync.sh')

/**
 * A satellite clone that is genuinely drifted, plus a `gh` stub.
 *
 * The stub is needed because the ship path resolves each repo's base from
 * `gh repo view --json defaultBranchRef`, which a `file://` origin cannot
 * answer — without it every repo reports `cannot resolve default branch` and
 * nothing ever stages. The scaffolding repo lives OUTSIDE the estate so the
 * survey does not pick it up as a second satellite.
 */
function estate(): { dir: string; log: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'wtlog-'))
  const dir = join(root, 'estate')
  const log = join(root, 'worktrees.log')
  mkdirSync(dir, { recursive: true })

  const origin = join(root, 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'dev', origin])

  const seed = join(root, 'seed')
  execFileSync('git', ['init', '-q', '-b', 'dev', seed])
  writeFileSync(join(seed, 'biffo.sibling.json'), '{}\n')
  execFileSync('git', ['-C', seed, 'add', '-A'])
  execFileSync('git', [
    '-C',
    seed,
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    'commit',
    '-qm',
    'seed',
  ])
  execFileSync('git', ['-C', seed, 'remote', 'add', 'origin', origin])
  execFileSync('git', ['-C', seed, 'push', '-q', 'origin', 'dev'])

  execFileSync('git', ['clone', '-q', origin, join(dir, 'satellite')])

  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'gh'),
    [
      '#!/usr/bin/env bash',
      'case "$*" in',
      '  *defaultBranchRef*) echo dev ;;',
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
  )
  chmodSync(join(bin, 'gh'), 0o755)

  return { dir, log, path: bin }
}

function run(e: { dir: string; log: string; path: string }, args: string[]) {
  try {
    execFileSync('bash', [script, '--estate', e.dir, ...args], {
      encoding: 'utf8',
      env: { ...process.env, SHARED_SYNC_WT_LOG: e.log, PATH: e.path + ':' + process.env.PATH },
    })
  } catch {
    // Exit status is not what these tests are about.
  }
  return existsSync(e.log) ? readFileSync(e.log, 'utf8') : ''
}

describe('worktree lifecycle log', () => {
  it('brackets a run at both ends, so overlapping runs are legible', () => {
    const e = estate()
    const out = run(e, ['--check'])

    // Without the end marker you cannot tell whether a second process's events
    // fell inside another run's round — which is the entire question (#1160).
    expect(out).toMatch(/run-start\(check\)/)
    expect(out).toMatch(/run-end\(check\)/)
  })

  it('still logs run-end from the traps set later in the file', () => {
    // `trap ... EXIT` REPLACES any earlier trap, and two are set after the one
    // at the top. A bare trap there is silently dead in exactly the runs worth
    // logging, which is how this nearly shipped.
    const e = estate()
    const out = run(e, ['--candidates'])

    expect(out).toMatch(/run-start\(candidates\)/)
    expect(out).toMatch(/run-end\(candidates\)/)
  })

  it('records the pid on every line, since the culprit is another process', () => {
    const e = estate()
    const out = run(e, ['--check'])
    const lines = out.trim().split('\n').filter(Boolean)

    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).toMatch(/\tpid=\d+\t/)
  })

  it('timestamps in UTC ISO-8601, so two logs can be interleaved by sorting', () => {
    const e = estate()
    const out = run(e, ['--check'])

    for (const line of out.trim().split('\n').filter(Boolean)) {
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\t/)
    }
  })

  it('logs the add and the pre-stage remove when a run actually stages', () => {
    const e = estate()
    const out = run(e, ['--rehearse'])

    expect(out).toContain('remove-pre-stage')
    expect(out).toMatch(/\tadd\s/)
    // The path is what a reader greps for when hunting who removed it.
    expect(out).toContain(join(e.dir, 'satellite', '.worktrees', 'shared-sync'))
  })

  it('names the guard event distinctly, so it can be searched backwards from', () => {
    const body = readFileSync(script, 'utf8')

    // The one event this log exists for. Asserted in the source rather than by
    // running it, because the condition is unreachable by construction — see
    // shared-sync-ship-guard.test.ts.
    expect(body).toContain('wt_log MISSING-AT-SHIP')
    const guardAt = body.indexOf('wt_log MISSING-AT-SHIP')
    const returnAt = body.indexOf('return 1', guardAt)
    expect(guardAt).toBeLessThan(returnAt)
  })

  it('logs every worktree removal in the file, with none left unlogged', () => {
    const body = readFileSync(script, 'utf8')
    const removals = body.split('\n').filter((l) => l.includes('worktree remove --force'))
    const logged = body.split('\n').filter((l) => l.trim().startsWith('wt_log remove'))

    // A removal that is not logged is a blind spot exactly where the answer is.
    expect(removals.length).toBeGreaterThan(0)
    expect(logged.length).toBe(removals.length)
  })
})
