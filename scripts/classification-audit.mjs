#!/usr/bin/env node
//
// Is the locally-catchable metric still measuring what it claims to? (#1167)
//
// ## Why this exists
//
// H4's primary outcome metric — `gates.share`, the locally-catchable share of
// failing CI steps — is computed over **classified** steps. A step whose name no
// pattern in `STEP_KINDS` matches is counted as `unclassified` and dropped from
// the ratio entirely. That is the right call for the ratio itself: a default of
// `false` would improve the headline every time CI grew a step the list had
// never seen, i.e. the metric would get better by going blind.
//
// But it means the metric degrades **silently**, and `unclassified` sat on the
// dashboard next to the share for weeks with nothing asserting on it.
//
// On 2026-08-03 that produced a real misreading. Twelve of seventeen estate
// failing steps were unclassified — every one of them in `tabsii-platform`, and
// every one an ordinary step name:
//
//   Apply DDL imports (5)         Error-branch coverage (3)
//   Initialise database schema (2)  Sync portal to S3 (1)
//   ADR numbering guard (1)
//
// The dashboard read **80% locally catchable**. Over all seventeen steps the
// honest figure was **47%**. H4's review was two days away.
//
// ## The shape, because it is not really about step names
//
// This is the estate's most-repeated defect one level out: **a check that cannot
// evaluate an input silently shrinks its own scope and reports the remainder as
// the whole.** `protection-audit.sh` skipped repos with no `dev` branch and
// reported "27 branches checked, all protected" about a set that excluded the
// four least likely to be protected (#1145). `shared-sync.sh` distributes only
// what is already listed and nothing flags what *should* be (#1108). Here the
// denominator shrank rather than the repo list.
//
// The fix is the same each time: make the blind spot **fail** rather than
// abstain. The pattern list will always lag CI — the point is that the lag is
// loud on the morning it appears, not found by a human eyeballing `byKind`.
//
// ## Why a threshold rather than zero
//
// A brand-new step name is normal estate churn, and a guard that is red every
// morning trains people to stop reading it — the argument `protection-audit.sh`
// makes at length, and why `mustBeUniform` ratchets from a baseline. See
// `BLINDNESS_THRESHOLD` in `practices-metrics.mjs`.
//
// Usage:
//   node scripts/classification-audit.mjs [--data docs/practices/data]
//
// Exits 0 when classification is healthy, 1 when the metric has gone blind,
// 2 when it cannot tell (no snapshot, unreadable, unmeasured window) — which
// audit_json reports as a FAIL, because "cannot tell" is never a pass.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { classificationBlindness } from './practices-metrics.mjs'

const args = process.argv.slice(2)
const dataDir = args.includes('--data') ? args[args.indexOf('--data') + 1] : 'docs/practices/data'

/** @param {string} message */
function cannotTell(message) {
  process.stderr.write(`classification: ${message}\n`)
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

// The 1-day window is the one the standup ranks and the one H4 reads daily.
const gates = snapshot?.windows?.['1']?.estate?.gates
if (!gates) cannotTell(`${newest} has no 1-day estate gates`)

const result = classificationBlindness(gates)
process.stdout.write(`${result.ok ? 'OK' : 'BLIND'}  ${newest}: ${result.summary}\n`)
if (!result.ok) {
  process.stdout.write(
    '\nThe locally-catchable share is computed over CLASSIFIED steps only, so\n' +
      'these steps are not in it. Add a pattern for each to STEP_KINDS in\n' +
      'scripts/practices-metrics.mjs — classifying from what the step RUNS, not\n' +
      'from what it is called.\n',
  )
}
process.exit(result.ok ? 0 : 1)
