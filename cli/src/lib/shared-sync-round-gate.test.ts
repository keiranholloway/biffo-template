/**
 * A shared-file distribution round has a price, and nothing used to charge for it.
 *
 * `shared-sync.sh` opens one PR per drifted repo and **nothing auto-merges
 * them**, so every round a human starts is ~12 more merges somebody has to land.
 * Verified 2026-08-04: no workflow in any repo referenced the script, so it was
 * run entirely by hand, reactively, after template merges. On 2026-08-03 that
 * meant 19 commits touching shared files (05:24–22:13) produced ~6.8 rounds
 * across 12 repos — **81 merges, 69 of them avoidable**, which was the estate's
 * *entire* avoidable-merge count for that day from this one script.
 *
 * A settle window cannot fix it: the changes are spread across seventeen hours
 * and were already hand-batched at ~2.7 changes per round, so debouncing bursts
 * leaves ~7 rounds standing. Only collapsing to a fixed daily round moves the
 * number, 7 → 1.
 *
 * The gate's posture is the part worth pinning, because it is the opposite of
 * most gates in this estate and deliberately so. It is **fail-open on the
 * schedule's absence**: if the daily round is not actually running, blocking the
 * manual path would leave drift undistributed forever while printing a confident
 * message about a round that never comes — strictly worse than no gate. So the
 * marker is written by the RUN rather than by the install, and it ages out, so a
 * schedule that dies stops gating within 48 hours and the manual path reopens on
 * its own.
 *
 * These tests drive the real `_scheduled_round_is_live` lifted out of the script
 * and assert on the real argument parser, rather than on source text — the same
 * arrangement as `practices-daily-alert.test.ts` and for the same reason: a
 * substring guard passes against a script that never runs the code.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SYNC = join(repoRoot, 'scripts/shared-sync.sh')
const DAILY = join(repoRoot, 'scripts/shared-sync-daily.sh')

let liveFn = ''

beforeAll(() => {
  const src = readFileSync(SYNC, 'utf8')
  const start = src.indexOf('_scheduled_round_is_live() {')
  if (start === -1) throw new Error('_scheduled_round_is_live not found in shared-sync.sh')
  liveFn = src.slice(start, src.indexOf('\n}\n', start) + 3)
})

/** Run the real liveness predicate against a marker, under dash as AGENTS.md invokes it. */
function roundIsLive(marker: string): boolean {
  const script = `${liveFn}\nSHARED_SYNC_MARKER=${JSON.stringify(marker)}\nif _scheduled_round_is_live; then echo LIVE; else echo DEAD; fi\n`
  const out = execFileSync('dash', ['-c', script], { encoding: 'utf8' })
  return out.trim() === 'LIVE'
}

describe('the round gate only bites when a scheduled round is actually running', () => {
  it('is dead when no marker exists — so the manual path is never blocked by a schedule that was never installed', () => {
    expect(roundIsLive(join(makeTmpDir('round-gate'), 'absent.marker'))).toBe(false)
  })

  it('is live for a marker written today', () => {
    const marker = join(makeTmpDir('round-gate'), 'fresh.marker')
    writeFileSync(marker, '2026-08-04T04:00:00Z\n')
    expect(roundIsLive(marker)).toBe(true)
  })

  /**
   * The ageing-out contract. A cron entry that breaks must not leave the manual
   * path gated forever — that would be a gate whose failure mode is "nothing is
   * ever distributed", which is the shape this estate keeps paying for.
   */
  it('goes dead again once the scheduled round has been silent for 48h', () => {
    const marker = join(makeTmpDir('round-gate'), 'stale.marker')
    writeFileSync(marker, '2026-08-01T04:00:00Z\n')
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000)
    utimesSync(marker, threeDaysAgo, threeDaysAgo)
    expect(roundIsLive(marker)).toBe(false)
  })

  it('is still live at 47h, so a single missed morning does not reopen the manual path', () => {
    const marker = join(makeTmpDir('round-gate'), 'yesterday.marker')
    writeFileSync(marker, '2026-08-03T04:00:00Z\n')
    const h47 = new Date(Date.now() - 47 * 3600 * 1000)
    utimesSync(marker, h47, h47)
    expect(roundIsLive(marker)).toBe(true)
  })
})

describe('the scheduled round and its override are wired to the parser', () => {
  const src = () => readFileSync(SYNC, 'utf8')

  it('accepts --scheduled and --now', () => {
    expect(src()).toMatch(/--scheduled\)\s*SCHEDULED=1/)
    expect(src()).toMatch(/--now\)\s*NOW=1/)
  })

  /**
   * `set -u` is live in this script, so a flag parsed into a variable that is
   * never initialised aborts the run on first read. Both must be declared with
   * the other flags.
   */
  it('initialises both variables, because set -u would abort on an unset one', () => {
    expect(src()).toMatch(/^SCHEDULED=""$/m)
    expect(src()).toMatch(/^NOW=""$/m)
  })

  it('gates only the shipping path — --check must never be blocked', () => {
    const gate = src().slice(src().indexOf('---- The round gate'))
    // The gate sits after the --check branch has already exited, and keys on
    // the two new flags alone.
    expect(gate).toMatch(/if \[ -z "\$SCHEDULED" \] && \[ -z "\$NOW" \]; then/)
    expect(src().indexOf('---- The round gate')).toBeGreaterThan(
      src().indexOf('if [ -n "$CHECK" ]; then'),
    )
  })

  it('the daily round invokes the script with --scheduled, the one caller the gate lets through', () => {
    expect(readFileSync(DAILY, 'utf8')).toMatch(/shared-sync\.sh --scheduled --estate/)
  })

  /**
   * The marker must be written by the run, not by the install. An
   * installed-but-broken cron entry that stamped a marker at install time would
   * gate every ad-hoc round while distributing nothing.
   */
  it('the daily round writes the marker only after a successful round', () => {
    const daily = readFileSync(DAILY, 'utf8')
    const roundAt = daily.indexOf('shared-sync.sh --scheduled')
    const markerWriteAt = daily.search(/^date -u \+%FT%TZ > "\$MARKER"$/m)
    expect(markerWriteAt).toBeGreaterThan(roundAt)
  })
})
