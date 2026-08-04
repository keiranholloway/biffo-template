#!/usr/bin/env node
/**
 * Assemble `estate-audits.json` from the per-audit result lines that
 * `practices-daily.sh` accumulates, in a single atomic write.
 *
 * Why this exists rather than the shell streaming its own JSON.
 *
 * The audit block used to `printf` an opening brace, then each audit, then a
 * comma, straight into `estate-audits.json`. That form has no valid partial
 * state: anything that ends the run mid-block leaves a syntactically truncated
 * file. On 2026-08-04 a `grep` miss inside `audit_json` did exactly that under
 * `set -o pipefail` — the file was left at 129 bytes ending in a comma, nine of
 * ten audits never ran, and `practices-standup.mjs` threw
 * `SyntaxError: Unexpected end of JSON input` and blocked the morning standup.
 *
 * A truncated file is worse than a missing one, because every reader's guard is
 * `existsSync` and a half-written file passes it. So the invariant here is:
 * **whatever happens, the file on disk is well-formed JSON listing every audit
 * that was supposed to run.**
 *
 * The second half of that invariant is `--expected`. An audit that never ran is
 * recorded as a failure with `ranNot: true` rather than being silently absent —
 * the difference between a check that answered "no problem" and one nobody
 * asked. Because it lands as `ok: false`, the failing-audit notification in
 * `practices-daily.sh` picks it up like any other red, with no extra plumbing.
 *
 * That is the same shape AGENTS.md §2 records against `protection-audit.sh`:
 * a check that drops an input it cannot evaluate shrinks its own scope and
 * reports the remainder as the whole.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(name)
  return i === -1 ? null : argv[i + 1]
}

const linesFile = arg('--lines')
const outFile = arg('--out')
const expected = (arg('--expected') ?? '').split(/\s+/).filter(Boolean)
const collectedAt = arg('--collected-at') ?? new Date().toISOString().replace(/\.\d+Z$/, 'Z')

if (!linesFile || !outFile) {
  process.stderr.write('usage: practices-audit-assemble.mjs --lines <f> --out <f> [--expected "a b"] [--collected-at <iso>]\n')
  process.exit(2)
}

/**
 * Read what the audits managed to write.
 *
 * A missing or unreadable accumulator is not fatal: it means every audit is
 * absent, which `--expected` then reports as ten explicit failures. Falling over
 * here would reintroduce the very outage this script exists to prevent.
 */
let raw = ''
try {
  raw = readFileSync(linesFile, 'utf8')
} catch (err) {
  process.stderr.write(`practices-audit-assemble: cannot read ${linesFile}: ${err.message}\n`)
}

const audits = []
const malformed = []
for (const line of raw.split('\n')) {
  if (!line.trim()) continue
  try {
    const parsed = JSON.parse(line)
    if (parsed && typeof parsed.name === 'string') audits.push(parsed)
    else malformed.push(line)
  } catch {
    // One unparseable line must not cost the other nine their results — the
    // whole point of the line-per-audit format is that the failures are
    // independent.
    malformed.push(line)
  }
}

const byName = new Map(audits.map((a) => [a.name, a]))

// Report in the declared order, so the dashboard and the log do not reshuffle
// when an audit fails. Anything produced but not declared is appended rather
// than dropped: an undeclared audit is a bug in `AUDIT_EXPECTED`, and silently
// discarding its result would hide it.
const ordered = []
for (const name of expected) {
  ordered.push(
    byName.get(name) ?? {
      name,
      ok: false,
      exit: null,
      ranNot: true,
      summary: 'did not run — the daily collection ended before this audit',
    },
  )
}
for (const audit of audits) {
  if (!expected.includes(audit.name)) ordered.push(audit)
}

const doc = {
  collectedAt,
  audits: ordered,
  ...(malformed.length ? { malformedLines: malformed.length } : {}),
}

// Write-then-rename: a reader that opens the file while this runs sees either
// the previous document or the new one, never a half-written one. The failure
// being fixed here was precisely a reader meeting a partial write.
const tmp = `${outFile}.tmp.${process.pid}`
writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`)
renameSync(tmp, outFile)

const missing = ordered.filter((a) => a.ranNot).length
if (missing) {
  process.stderr.write(
    `practices-audit-assemble: ${missing} of ${expected.length} audits did not run — recorded as failures in ${outFile}\n`,
  )
}
if (malformed.length) {
  process.stderr.write(`practices-audit-assemble: ${malformed.length} unparseable result line(s) dropped\n`)
}

// Always exit 0. This runs under `set -e` in `practices-daily.sh` and its job is
// to make the run's outcome READABLE, not to decide it — a non-zero here would
// take down the dashboard render and the snapshot push that follow, which is the
// class of failure this file was written to end.
process.exit(0)
