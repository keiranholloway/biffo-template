/**
 * Record where a working session's wall-clock actually went.
 *
 * ## Why this is the one metric a human has to produce
 *
 * Everything else on the practices dashboard is derived from merge metadata, so
 * the clock only starts when a pull request opens. The experience that prompted
 * this whole programme — "a five-minute change turns into an hour" — happens
 * almost entirely *before* that, and git will never record it.
 *
 * ## What it is really for
 *
 * Not to add a number, but to **falsify the merge proxy**. The platform/product
 * split and the toil ratio are inferred from commit types and repo names; they
 * are free, and they might be wrong. If the recorded wall-clock split
 * consistently disagrees with the merge-derived one, the proxy is wrong and the
 * dashboard's headline needs rebuilding. That check is impossible without
 * ground truth, and this is the cheapest ground truth available.
 *
 * ## Why it is deliberately coarse
 *
 * Three buckets and a total, in whole minutes, from memory, at the end of a
 * session. A finer instrument would be more accurate and would not get used —
 * and a metric nobody records is indistinguishable from one that does not
 * exist. Estimates are expected; honesty matters more than precision, because
 * a systematically flattering estimate breaks the falsification test above.
 *
 * Usage:
 *   node scripts/practices-session.mjs --minutes 180 --delivery 60 --platform 40 --toil 80 \
 *     --note "idea-scout fan-in; lost an hour to the plugin skeleton"
 *
 *   node scripts/practices-session.mjs --summary
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const DEFAULT_LOG = 'docs/practices/sessions.jsonl'

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
    return { sessions: 0, minutes: 0, delivery: null, platform: null, toil: null, toilRatio: null }
  }
  const total = entries.reduce((sum, e) => sum + e.minutes, 0)
  const share = (bucket) => {
    const n = entries.reduce((sum, e) => sum + (e[bucket] ?? 0), 0)
    return total ? Math.round((n / total) * 1000) / 10 : null
  }
  return {
    sessions: entries.length,
    minutes: total,
    hours: Math.round((total / 60) * 10) / 10,
    delivery: share('delivery'),
    platform: share('platform'),
    toil: share('toil'),
    // Directly comparable with the merge-derived toilRatio on the dashboard.
    toilRatio: share('toil'),
  }
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
    else args[key] = argv[++i]
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.summary) {
    const s = summariseSessions(readSessions(args.file))
    if (s.sessions === 0) {
      process.stdout.write('no sessions recorded yet\n')
      return
    }
    process.stdout.write(
      `${s.sessions} sessions · ${s.hours}h\n` +
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
