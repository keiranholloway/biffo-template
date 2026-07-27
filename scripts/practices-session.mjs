/**
 * Record what one unit of work actually cost, and where it went.
 *
 * ## Why this is the one metric a human has to produce
 *
 * Everything else on the practices dashboard is derived from merge metadata, so
 * the clock only starts when a pull request opens. The experience that prompted
 * this programme — "a five-minute change turns into an hour" — happens almost
 * entirely *before* that, and git will never record it.
 *
 * ## What it is really for
 *
 * Not to add a number, but to **falsify the merge proxy**. The platform/product
 * split and the toil ratio are inferred from commit types and repo names; they
 * are free, and they might be wrong. If recorded effort consistently disagrees
 * with the merge-derived figure, the proxy is wrong and the dashboard's headline
 * needs rebuilding.
 *
 * ## The unit is one task, not one day and not one session
 *
 * Record after **each unit of work**, from whichever session did it. Entries are
 * **agent-effort minutes** and are therefore additive: five sessions working
 * thirty minutes in parallel is 150 minutes of capacity spent, and all five
 * should log it.
 *
 * That is deliberate, and it is what makes the comparison valid. The merge proxy
 * counts merges produced by *every* agent, so it measures capacity too. Logging
 * the operator's personal wall-clock instead would compare a single human's
 * afternoon against the output of five parallel workers — apples to oranges, and
 * it would make the proxy look wrong for the wrong reason.
 *
 * The log is append-only and each line carries its date, so a day's total is
 * simply the sum of that day's lines. Nothing needs to be merged or mutated.
 *
 * ## Why it is deliberately coarse
 *
 * Three buckets and a total, in whole minutes, from memory, at the end of a
 * task. A finer instrument would be more accurate and would not get used — and a
 * metric nobody records is indistinguishable from one that does not exist.
 * Estimates are expected; honesty matters more than precision, because a
 * systematically flattering estimate breaks the falsification test above.
 *
 * Usage:
 *   node scripts/practices-session.mjs --minutes 45 --platform 30 --toil 15 \
 *     --note "core upgrade into tabsii; lost 15m to the publish race"
 *
 *   node scripts/practices-session.mjs --summary
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Outside the repo on purpose.
 *
 * Appending to a tracked file would leave the primary checkout dirty on `dev`
 * after every entry, and committing each one through its own PR would add more
 * merges to the very contention this programme is measuring. The daily job
 * copies it onto the snapshot branch instead, so the history is still
 * version-controlled without a PR per entry.
 */
export const DEFAULT_LOG = `${process.env.HOME}/.practices-sessions.jsonl`

/**
 * The three buckets, chosen to line up with the merge-derived work mix so the
 * two can be compared directly.
 *
 * - `delivery` — building the product someone pays for
 * - `platform` — deliberately building the machine (a chosen investment)
 * - `toil`     — fighting the toolchain, CI, releases, environments (unchosen)
 *
 * The distinction between `platform` and `toil` is intent: shipping a planned
 * core feature is platform; losing forty minutes to a red pipeline is toil.
 */
export const BUCKETS = ['delivery', 'platform', 'toil']

/**
 * Validate and normalise one session entry.
 *
 * Returns `{ entry }` or `{ error }` — never a partially-valid entry. A session
 * log that silently accepts a malformed row is worse than one that rejects it,
 * because the aggregate then quietly under-reports.
 *
 * @param {Record<string, any>} input
 */
export function buildEntry(input, now = new Date()) {
  const minutes = Number(input.minutes)
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { error: '--minutes must be a positive number of minutes' }
  }

  const parts = {}
  let allocated = 0
  for (const bucket of BUCKETS) {
    const value = input[bucket] === undefined ? 0 : Number(input[bucket])
    if (!Number.isFinite(value) || value < 0) {
      return { error: `--${bucket} must be a non-negative number of minutes` }
    }
    parts[bucket] = value
    allocated += value
  }

  if (allocated === 0) {
    return { error: `allocate the time across: ${BUCKETS.map((b) => `--${b}`).join(' ')}` }
  }
  // Allow a little slack for estimating in round numbers, but not so much that
  // the buckets stop describing the session.
  if (Math.abs(allocated - minutes) > Math.max(10, minutes * 0.15)) {
    return {
      error: `buckets total ${allocated}m but session is ${minutes}m — they should roughly agree`,
    }
  }

  return {
    entry: {
      date: now.toISOString().slice(0, 10),
      recordedAt: now.toISOString(),
      minutes,
      ...parts,
      note: String(input.note ?? '').slice(0, 240),
    },
  }
}

/**
 * Roll a set of entries into the comparison the log exists to enable.
 *
 * @param {Array<Record<string, any>>} entries
 */
export function summariseSessions(entries) {
  if (entries.length === 0) {
    return {
      tasks: 0, days: 0, sessions: 0, minutes: 0, hours: 0,
      delivery: null, platform: null, toil: null, toilRatio: null, lastDate: null,
    }
  }
  const total = entries.reduce((sum, e) => sum + e.minutes, 0)
  const dates = [...new Set(entries.map((e) => e.date).filter(Boolean))].sort()
  const share = (bucket) => {
    const n = entries.reduce((sum, e) => sum + (e[bucket] ?? 0), 0)
    return total ? Math.round((n / total) * 1000) / 10 : null
  }
  return {
    // Entries are units of work, not days and not agent sessions.
    tasks: entries.length,
    days: dates.length,
    // Kept so existing callers (the dashboard, the nudge) keep working.
    sessions: entries.length,
    minutes: total,
    hours: Math.round((total / 60) * 10) / 10,
    delivery: share('delivery'),
    platform: share('platform'),
    toil: share('toil'),
    // Directly comparable with the merge-derived toilRatio: both are
    // capacity-weighted across every agent, not one person's wall-clock.
    toilRatio: share('toil'),
    lastDate: dates[dates.length - 1] ?? null,
  }
}

/**
 * How stale is the ground truth?
 *
 * A calibration that stopped two months ago is not calibration — the working
 * pattern it validated has moved on. This is what the daily job nudges on, and
 * what the dashboard shows beside the comparison.
 *
 * @param {string | null} lastDate ISO date of the most recent session
 * @param {Date} now
 */
export function daysSince(lastDate, now = new Date()) {
  if (!lastDate) return null
  const then = Date.parse(`${lastDate}T00:00:00Z`)
  if (Number.isNaN(then)) return null
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`)
  return Math.max(0, Math.round((today - then) / 864e5))
}

/**
 * The line the daily cron job prints.
 *
 * Deliberately states *why* rather than just nagging: a reminder that does not
 * say what it is protecting gets ignored, and then the thing it protects
 * silently stops happening — which is exactly how the worktree-hygiene rule
 * lapsed and left nine orphans behind.
 *
 * @param {{sessions: number, lastDate: string | null}} summary
 * @param {number} staleAfterDays
 */
export function nudge(summary, staleAfterDays = 3, now = new Date()) {
  if (!summary || summary.sessions === 0) {
    return 'no sessions ever recorded — every dashboard figure is unvalidated inference. One command at the end of your next session fixes that: scripts/practices-session.mjs --minutes N --delivery N --platform N --toil N'
  }
  const age = daysSince(summary.lastDate, now)
  if (age === null || age < staleAfterDays) return null
  return `last session logged ${age} days ago (${summary.lastDate}) — the proxy comparison is going stale; ${summary.sessions} recorded so far`
}

/** @param {string} file */
export function readSessions(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function parseArgs(argv) {
  const args = { file: DEFAULT_LOG }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (!flag.startsWith('--')) continue
    const key = flag.slice(2)
    if (key === 'summary') args.summary = true
    else if (key === 'nudge') args.nudge = true
    else args[key] = argv[++i]
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.nudge) {
    const message = nudge(summariseSessions(readSessions(args.file)))
    if (message) process.stdout.write(`practices: ${message}\n`)
    return
  }

  if (args.summary) {
    const s = summariseSessions(readSessions(args.file))
    if (s.tasks === 0) {
      process.stdout.write('no work recorded yet\n')
      return
    }
    process.stdout.write(
      `${s.tasks} tasks over ${s.days} days · ${s.hours}h of effort\n` +
        `  delivery ${s.delivery}%  platform ${s.platform}%  toil ${s.toil}%\n`,
    )
    return
  }

  const { entry, error } = buildEntry(args)
  if (error) {
    process.stderr.write(`${error}\n`)
    process.exitCode = 1
    return
  }

  mkdirSync(dirname(args.file), { recursive: true })
  appendFileSync(args.file, `${JSON.stringify(entry)}\n`)
  process.stdout.write(
    `recorded ${entry.minutes}m — delivery ${entry.delivery} · platform ${entry.platform} · toil ${entry.toil}\n`,
  )
}

if (process.argv[1] && process.argv[1].endsWith('practices-session.mjs')) {
  main()
}
