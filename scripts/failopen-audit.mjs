#!/usr/bin/env node
//
// Is the fail-open corpus a worklist, or just a record? (#956)
//
// ## Why this exists
//
// `fail-open` is the largest recorded class in the practices corpus. #956's
// complaint was not that the estate has fail-opens — it is that **recording one
// and converting it into fixable work are different acts, and only the first
// was happening**:
//
//   status `unfiled` is a literal value meaning *written down, no issue ever
//   created*. Three of those rows carried no `refs` at all, so nothing linked
//   them to anything actionable.
//
// The corpus grew a `summariseFailOpenBacklog()` that computes exactly this,
// and it has been written into every snapshot as `failOpenBacklog` — and
// surfaced **nowhere**. Not on the dashboard, not in the audit set. So the
// number that measures whether lessons become work was itself a lesson that
// never became work.
//
// That is the fifth present-but-inert check found on 2026-08-03, after
// `branch-health.sh`, `verify.sh --checkout-health`, the dormant CodeQL
// workflow, and the dead-surface question. The shape is consistent enough to
// be worth naming: **building the detector is the easy half.**
//
// ## Why a ratchet on `unfiled` specifically
//
// `unfixed` is not a target and must not become one — #956 says so directly,
// and a corpus that stops recording defects to keep a number down is worse than
// useless. Some entries are legitimately open for a long time; some describe
// things nobody should fix.
//
// `unfiled` is different. It does not mean "not fixed yet"; it means **nobody
// ever decided**. Whatever else is true, that number should not grow — a new
// fail-open should leave the session with an issue, not a row. So the ratchet
// is on `unfiled` alone, and it fails in both directions: growing means lessons
// are being dropped, shrinking means the baseline is stale and should be
// lowered, because a ratchet that never tightens stops meaning anything (the
// posture `mustBeUniform` and `biffo.orphan-baseline.json` share).
//
// It reports `unfixed` and the oldest age alongside, because a bare `unfiled`
// count without them is not auditable — the same rule the gates metric follows
// for its own denominator.
//
// Usage:
//   node scripts/failopen-audit.mjs [--data docs/practices/data] [--max N]
//
// Exits 0 when the unfiled count is at baseline, 1 when it has moved in either
// direction, 2 when it cannot tell — which is never a pass.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const dataDir = args.includes('--data') ? args[args.indexOf('--data') + 1] : 'docs/practices/data'
const max = args.includes('--max') ? Number(args[args.indexOf('--max') + 1]) : null

/** @param {string} message */
function cannotTell(message) {
  process.stderr.write(`failopen: ${message}\n`)
  process.exit(2)
}

let newest
try {
  newest = readdirSync(dataDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .pop()
} catch (err) {
  cannotTell(`cannot read ${dataDir}: ${/** @type {Error} */ (err).message}`)
}
if (!newest) cannotTell(`no snapshot in ${dataDir}`)

let snapshot
try {
  snapshot = JSON.parse(readFileSync(join(dataDir, newest), 'utf8'))
} catch (err) {
  cannotTell(`cannot parse ${newest}: ${/** @type {Error} */ (err).message}`)
}

const backlog = snapshot?.failOpenBacklog
if (!backlog) cannotTell(`${newest} has no failOpenBacklog`)
// `summariseFailOpenBacklog` returns `{error:'unmeasured'}` when the corpus
// could not be read strictly. Not measuring and measuring zero are different
// claims, and only one of them is good news.
if (backlog.error) cannotTell(`fail-open backlog ${backlog.error} — corpus unreadable`)

const { total, unfixed, unfiled, oldestUnfixedDays, byStatus } = backlog
const age = oldestUnfixedDays === null ? 'n/a' : `${oldestUnfixedDays}d`

process.stdout.write(
  `fail-open backlog: ${unfiled} unfiled, ${unfixed} unfixed of ${total} recorded, oldest ${age}\n`,
)
process.stdout.write(`  by status: ${JSON.stringify(byStatus)}\n`)

if (max === null) process.exit(0)

if (unfiled > max) {
  process.stdout.write(
    `\n${unfiled} unfiled, baseline ${max} — a fail-open was recorded and never converted into an issue.\n` +
      `"unfiled" does not mean unfixed; it means nobody decided. File them, or mark them\n` +
      `deliberately with a status that says what was decided.\n`,
  )
  process.exit(1)
}
if (unfiled < max) {
  process.stdout.write(
    `\n${unfiled} unfiled, baseline ${max} — IMPROVED, lower the baseline to ${unfiled}.\n`,
  )
  process.exit(1)
}
process.stdout.write(`\n${unfiled} unfiled, at baseline ${max}.\n`)
process.exit(0)
