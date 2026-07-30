#!/usr/bin/env node
/**
 * The morning standup: **what hurt throughput most in the last 24 hours**, ranked,
 * with yesterday's chosen fix marked as it landed or did not (#918).
 *
 * ## Why this is not the dashboard
 *
 * `practices-dashboard.mjs` answers "how are we doing" — shares and rates, trended.
 * This answers a different and narrower question: *what should I spend the next
 * one to three hours on, and did the last one to three hours work?*
 *
 * Two shapes drove the largest losses on record and **neither is visible to a share
 * or a rate**, which is every metric the dashboard has:
 *
 * - **Amplification** — one upstream action multiplied across the estate. On
 *   2026-07-29 that was 35% of all merges, and every tile reported it as a busy
 *   day. See {@link summariseAmplification}.
 * - **Recurrence** — a lesson the corpus already recorded, happening again. A
 *   third instance renders identically to a first, so the compounding failures
 *   never rise. The corpus holds 11 explicit recurrences and 111 unresolved rows.
 *
 * ## The score, and its declared bias
 *
 * `score = costMinutes × recurrenceMultiplier`, then **any finding with three or
 * more prior corpus rows is promoted into the top three regardless of cost**.
 *
 * That promotion is a policy, not a number: it encodes "a third recurrence
 * matters even when we cannot price it". The alternative was imputing a cost for
 * unpriced findings, which would be inventing evidence — the failure this whole
 * programme exists to remove. Unpriced findings therefore say `cost unmeasured`
 * and are never silently scored as zero.
 *
 * ## Closing the loop is the point
 *
 * A daily ritual that cannot show whether yesterday's fix worked does not
 * compound, it just feels productive. Every run appends its chosen intervention
 * and that metric's value to `docs/practices/standup.jsonl`; the next run reads it
 * back and reports the delta. **An intervention whose metric did not move is a
 * finding in its own right** and is reported as one.
 *
 * Usage:
 *   node scripts/practices-standup.mjs
 *   node scripts/practices-standup.mjs --choose 2 --note "batch shared-sync"
 *   node scripts/practices-standup.mjs --json
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * CI cost of one round trip, in minutes, by repo class.
 *
 * Measured 2026-07-29 from GitHub Actions run durations (p50 over the last 50 CI
 * runs per repo) and recorded in `docs/practices/experiments/H5-gate-residuals.md`.
 * Reused rather than re-derived so the two documents cannot drift into two
 * different prices for the same thing.
 */
export const CI_MINUTES = { template: 2.4, plugin: 7.0, sibling: 7.0, instance: 8.4, default: 7.0 }

/**
 * A finding's shape, and the corpus terms that make it a recurrence.
 *
 * The corpus query is **declared here, not inferred**. Keyword-matching a
 * free-text summary against a free-text finding produces confident nonsense; an
 * explicit term list is auditable and can be tested. Every entry must state what
 * it would take for the finding to be absent, or it is not a finding.
 */
export const FINDING_KINDS = {
  amplification: {
    label: 'Unbatched distribution — one change, many rounds',
    terms: ['shared-sync', 'shared file', 'distribut', 'per repo', 'satellite', 'core upgrade'],
  },
  contention: {
    label: 'Merge contention — correct work that could not land',
    terms: ['merge race', 'behind', 'strict', 'auto-merge', 'green-but-unmerged', 'raced'],
  },
  redBranch: {
    label: 'Integration branch red — everyone blocked at once',
    terms: ['integration branch', 'red dev', 'blocks every', 'green-by-absence'],
  },
  caughtSecond: {
    label: 'CI caught it second — a local gate could have been first',
    terms: ['fail-open', 'hook', 'gate', 'locally catchable', 'verify.sh', 'armed'],
  },
  armingRegression: {
    label: 'Gates configured but not executing',
    terms: ['hooksPath', 'husky', 'skips ALL hooks', 'armed', 'DEAD'],
  },
}

/** Nearest-rank helper kept local: this script must run on bare node. */
const round1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10)

/**
 * How many prior corpus rows describe this shape.
 *
 * Counts rows whose summary contains any declared term. Rows already `fixed` still
 * count: a shape that was fixed and returned is *more* interesting than one that
 * never has been, and the multiplier is about how well-known the shape is, not
 * about whether a ticket is open.
 *
 * @param {Array<Record<string, any>>} corpus
 * @param {string[]} terms
 */
export function countPriorRows(corpus, terms) {
  const lowered = terms.map((t) => t.toLowerCase())
  let rows = 0
  let explicitRecurrences = 0
  for (const row of corpus) {
    const summary = String(row.summary ?? '').toLowerCase()
    if (!lowered.some((t) => summary.includes(t))) continue
    rows += 1
    if (/recurrence/i.test(String(row.summary ?? ''))) explicitRecurrences += 1
  }
  return { rows, explicitRecurrences }
}

/**
 * Recurrence multiplier from prior-row count.
 *
 * Capped at 2.5. Uncapped, a shape with forty corpus rows — `fail-open` has sixty
 * — would dominate every ranking forever on the strength of being well
 * documented, which is the opposite of the intent: the multiplier exists to raise
 * *cheap repeats*, not to entrench whatever is best recorded.
 *
 * @param {{rows: number, explicitRecurrences: number}} prior
 */
export function recurrenceMultiplier(prior) {
  const base = 1 + 0.25 * Math.min(prior.rows, 4)
  const explicit = 0.25 * Math.min(prior.explicitRecurrences, 2)
  return round1(Math.min(base + explicit, 2.5))
}

/**
 * Build the findings for one window of one snapshot.
 *
 * @param {Record<string, any>} snapshot
 * @param {Array<Record<string, any>>} corpus
 * @param {Array<Record<string, any>>} audits
 */
export function buildFindings(snapshot, corpus, audits = []) {
  const win = snapshot.windows?.['1'] ?? {}
  const repos = win.repos ?? {}
  /** @type {Array<Record<string, any>>} */
  const findings = []

  const add = (kind, detail) => {
    const spec = FINDING_KINDS[kind]
    const prior = countPriorRows(corpus, spec.terms)
    const multiplier = recurrenceMultiplier(prior)
    findings.push({
      kind,
      label: spec.label,
      ...detail,
      priorRows: prior.rows,
      explicitRecurrences: prior.explicitRecurrences,
      multiplier,
      score: detail.costMinutes === null ? null : round1(detail.costMinutes * multiplier),
    })
  }

  const classOf = (slug) => {
    const r = repos[slug]
    if (r?.role === 'template') return 'template'
    if (r?.role && CI_MINUTES[r.role]) return r.role
    return 'default'
  }
  const ciCost = (slug) => CI_MINUTES[classOf(slug)] ?? CI_MINUTES.default

  // --- 1. Amplification. Priced at one CI round trip per avoidable merge.
  const amp = win.amplification
  if (amp?.avoidableMerges > 0) {
    const perMerge = CI_MINUTES.default
    add('amplification', {
      costMinutes: round1(amp.avoidableMerges * perMerge),
      headline: `${amp.avoidableMerges} of ${amp.totalMerges} merges did not need to happen (${amp.avoidableShare}%)`,
      evidence: amp.top.slice(0, 3).map(
        (g) => `"${g.subject}" — ${g.merges} merges across ${g.repos} repos, ${g.rounds} rounds`,
      ),
      // A FLOOR, and deliberately so. This counts runner minutes only. It excludes
      // the review-and-merge cycle each unnecessary PR consumed, and the merge-race
      // re-entry H5 already notes it does not count. Amplification will therefore
      // usually rank below a red branch or a contention pile even when it dominates
      // the *share* of merges — which is the honest answer, not a reason to inflate
      // the weight until it wins. Share is not cost.
      costBasis: `${amp.avoidableMerges} avoidable merges × ${perMerge} min CI p50 — a floor: excludes review time and merge-race re-entry`,
      metric: 'windows.1.amplification.avoidableMerges',
      metricValue: amp.avoidableMerges,
    })
  }

  // --- 2. Contention, attributed to the worst repo rather than the estate total,
  // because the fix is per-repo (branch protection) and an estate number names
  // nobody.
  const byContention = Object.entries(repos)
    .filter(([, r]) => !r.error && r.contention?.greenButUnmergedHours)
    .sort((a, b) => b[1].contention.greenButUnmergedHours - a[1].contention.greenButUnmergedHours)
  if (byContention.length) {
    const [slug, r] = byContention[0]
    const total = byContention.reduce((t, [, x]) => t + x.contention.greenButUnmergedHours, 0)
    add('contention', {
      costMinutes: round1(r.contention.greenButUnmergedHours * 60),
      headline: `${slug.split('/')[1]} held ${r.contention.greenButUnmergedHours}h of ${round1(total)}h green-but-unmerged (${rateOf(r.contention.greenButUnmergedHours, total)}% of the estate)`,
      evidence: [
        `raced ${r.contention.racedShare}% · repush ${r.contention.repushRate}% · ${r.mergedPrs} merges`,
        `integration failures ${r.integration?.failures ?? '—'} · red minutes ${r.integration?.redMinutes ?? '—'}`,
      ],
      costBasis: 'green-but-unmerged hours, the correct work that could not land',
      metric: `windows.1.repos["${slug}"].contention.greenButUnmergedHours`,
      metricValue: r.contention.greenButUnmergedHours,
      repo: slug,
    })
  }

  // --- 3. A red integration branch, priced at its own red minutes because that is
  // literally the time it blocked everyone.
  const byRed = Object.entries(repos)
    .filter(([, r]) => !r.error && r.integration?.redMinutes)
    .sort((a, b) => b[1].integration.redMinutes - a[1].integration.redMinutes)
  if (byRed.length) {
    const [slug, r] = byRed[0]
    add('redBranch', {
      costMinutes: round1(r.integration.redMinutes),
      headline: `${slug.split('/')[1]} kept dev red for ${r.integration.redMinutes} min across ${r.integration.failures} failure(s)`,
      evidence: [
        `unresolved failures: ${r.integration.unresolvedFailures ?? '—'}`,
        'a red integration branch blocks every agent at once — multiply by concurrency',
      ],
      costBasis: 'measured red minutes on the integration branch',
      metric: `windows.1.repos["${slug}"].integration.redMinutes`,
      metricValue: r.integration.redMinutes,
      repo: slug,
    })
  }

  // --- 4. H4's metric, priced with H5's own model: a locally-catchable failure
  // costs one round trip to discover and one to confirm.
  const gates = win.estate?.gates
  if (gates && !gates.error && gates.locallyCatchable > 0) {
    const perStep = CI_MINUTES.default * 2
    add('caughtSecond', {
      costMinutes: round1(gates.locallyCatchable * perStep),
      headline: `${gates.locallyCatchable} of ${gates.locallyCatchable + gates.notLocallyCatchable} failing CI steps were locally catchable (${gates.share}%)`,
      evidence: [
        Object.entries(gates.byKind ?? {})
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([k, n]) => `${k} ${n}`)
          .join(' · '),
        gates.unclassified ? `${gates.unclassified} unclassified — the metric may be going blind` : 'classifier covered every step',
      ],
      costBasis: `${gates.locallyCatchable} steps × 2 round trips × ${CI_MINUTES.default} min (H5's pricing)`,
      metric: 'windows.1.estate.gates.share',
      metricValue: gates.share,
    })
  }

  // --- 5. Arming, from the audit rather than the snapshot. Deliberately unpriced:
  // a disarmed hook has no cost until it lets something through, and inventing one
  // would be exactly the fabrication this programme refuses. It rises by
  // recurrence alone, which is the promotion rule earning its place.
  const arming = audits.find((a) => a.name === 'arming')
  if (arming && !arming.ok) {
    add('armingRegression', {
      costMinutes: null,
      headline: `arming audit failing — ${arming.summary}`,
      evidence: [
        'a gate believed to be running is worse than no gate (H4)',
        'unpriced by design: the cost appears only when a disarmed hook lets something through',
      ],
      costBasis: 'unmeasured — see note',
      metric: 'estate-audits.arming.ok',
      metricValue: false,
    })
  }

  return rank(findings)
}

const rateOf = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null)

/**
 * Rank by score, then promote well-known shapes.
 *
 * The promotion is applied *after* sorting so its effect is visible in the output
 * rather than folded invisibly into a number: a promoted finding says so.
 *
 * @param {Array<Record<string, any>>} findings
 */
export function rank(findings) {
  const priced = findings.filter((f) => f.score !== null).sort((a, b) => b.score - a.score)
  const unpriced = findings.filter((f) => f.score === null).sort((a, b) => b.multiplier - a.multiplier)

  const ordered = [...priced, ...unpriced]
  // Promotion: three or more prior rows earns a top-three slot even unpriced.
  const promoted = ordered.filter((f) => f.priorRows >= 3 && ordered.indexOf(f) >= 3)
  for (const f of promoted) {
    f.promoted = true
    ordered.splice(ordered.indexOf(f), 1)
    ordered.splice(2, 0, f)
  }
  return ordered.map((f, i) => ({ rank: i + 1, ...f }))
}

/**
 * Compare today's value of a previously-chosen metric against the day it was
 * chosen.
 *
 * `verdict` is deliberately blunt. "Moved the wrong way" and "did not move" are
 * different failures — the first suggests the intervention backfired, the second
 * that it missed — and collapsing them would lose the distinction that decides
 * what to do next.
 *
 * @param {Record<string, any> | null} last previous standup entry
 * @param {Record<string, any>} snapshot today's snapshot
 */
export function closeLoop(last, snapshot) {
  if (!last) return null
  // A choice made outside the ranking never had a metric to move. Reporting that
  // as `unmeasurable today` would claim the measurement broke, when in truth none
  // was ever taken -- and that difference decides whether to suspect the fix or
  // the instrument. It is also the difference between "we did directed work and
  // did not measure it" and "nothing happened", which is the whole reason to
  // record a directed choice at all.
  if (!last.metric) {
    return { ...last, now: null, delta: null, verdict: 'no metric recorded' }
  }
  const now = readPath(snapshot, last.metric)
  if (now === undefined || now === null) {
    return { ...last, now: null, verdict: 'unmeasurable today', delta: null }
  }
  if (typeof now !== 'number' || typeof last.metricValue !== 'number') {
    return { ...last, now, verdict: now === last.metricValue ? 'unchanged' : 'changed', delta: null }
  }
  const delta = round1(now - last.metricValue)
  let verdict = 'did not move'
  if (delta < 0) verdict = 'improved'
  else if (delta > 0) verdict = 'moved the wrong way'
  return { ...last, now, delta, verdict }
}

/**
 * Is the newest snapshot actually about the last 24 hours?
 *
 * **This guard exists because the tool failed it on its own first real use.** Run
 * from the primary checkout with default arguments, the newest file in
 * `docs/practices/data/` was `2026-07-28.json` — today's snapshot lives on the
 * `chore/practices-snapshots` branch, in the daily worktree, and is deliberately
 * never merged to `dev`. The standup printed a confident ranking of two-day-old
 * numbers with no indication anything was wrong.
 *
 * That is the fail-open shape this whole programme exists to remove, committed by
 * the tool built to find it. A ranking of stale data is worse than no ranking: it
 * spends the day's budget on yesterday's problem and reports success.
 *
 * Returns the staleness in whole days, so the caller can refuse.
 *
 * @param {string} file snapshot filename, `YYYY-MM-DD.json`
 * @param {Date} now
 */
export function snapshotAgeDays(file, now = new Date()) {
  const match = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(file)
  if (!match) return null
  const snapshotDay = Date.parse(`${match[1]}T00:00:00Z`)
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`)
  return Math.round((today - snapshotDay) / 864e5)
}

/** Read `windows.1.repos["o/r"].x.y` out of a snapshot. */
export function readPath(object, path) {
  if (!path) return undefined
  const parts = String(path)
    .replace(/\["([^"]+)"\]/g, '.$1')
    .split('.')
    .filter(Boolean)
  let node = object
  for (const part of parts) {
    if (node === null || typeof node !== 'object') return undefined
    node = node[part]
  }
  return node
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function latestSnapshot(dir) {
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
  if (!files.length) throw new Error(`no snapshots in ${dir}`)
  return { file: files[files.length - 1], data: JSON.parse(readFileSync(join(dir, files[files.length - 1]), 'utf8')) }
}

function readCorpus(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function readLastChoice(file) {
  if (!existsSync(file)) return null
  const rows = readCorpus(file)
  return rows.length ? rows[rows.length - 1] : null
}

const BOLD = '[1m'
const DIM = '[90m'
const RED = '[31m'
const GREEN = '[32m'
const YELLOW = '[33m'
const OFF = '[0m'

function main() {
  const argv = process.argv.slice(2)
  const arg = (name) => {
    const i = argv.indexOf(name)
    return i === -1 ? null : argv[i + 1]
  }
  const dataDir = arg('--data') ?? 'docs/practices/data'
  // Outside the repo by default, for the same reason the effort log is (#940):
  // appending a choice must not dirty whatever checkout you happen to run this
  // from, and it must not need a PR per entry. `practices-daily.sh` copies it onto
  // the snapshot branch, which is what version-controls the history.
  //
  // It used to default to `docs/practices/standup.jsonl`, i.e. relative to cwd —
  // so the record of what was chosen landed in the primary checkout as an
  // untracked file and was never committed anywhere.
  const logFile =
    arg('--log') ?? join(process.env.HOME ?? '.', '.practices-standup.jsonl')
  const { file, data: snapshot } = latestSnapshot(dataDir)

  // Refuse stale data rather than ranking it. Fatal by default: the whole point of
  // this tool is to direct the day's effort, and directing it at a two-day-old
  // problem is the most expensive thing it could do.
  const ageDays = snapshotAgeDays(file)
  if (ageDays !== null && ageDays > 0 && !argv.includes('--allow-stale')) {
    process.stderr.write(
      `\n${RED}FATAL${OFF}: newest snapshot in ${dataDir} is ${file} — ${ageDays} day(s) old.\n` +
        `Ranking stale data would spend today's budget on an old problem.\n\n` +
        `Today's snapshot is written by the daily cron on the chore/practices-snapshots\n` +
        `branch and is deliberately never merged to dev, so the primary checkout does\n` +
        `not carry it. Point at the daily worktree:\n\n` +
        `  node scripts/practices-standup.mjs --data .worktrees/practices-daily/docs/practices/data\n\n` +
        `Or collect fresh data (~5 min):\n\n` +
        `  node scripts/practices-metrics.mjs --windows 1,7,90 --out ${dataDir} --repos-root ~/code\n\n` +
        `--allow-stale overrides this, for reading a historical snapshot on purpose.\n`,
    )
    process.exit(1)
  }
  const corpus = readCorpus(arg('--corpus') ?? 'docs/practices/evidence.jsonl')
  const auditsFile = join(dataDir, 'estate-audits.json')
  const audits = existsSync(auditsFile) ? JSON.parse(readFileSync(auditsFile, 'utf8')).audits ?? [] : []

  const findings = buildFindings(snapshot, corpus, audits)
  const loop = closeLoop(readLastChoice(logFile), snapshot)

  // Work chosen outside the ranking -- the operator names it, or the backlog
  // dictates it -- still needs recording, or tomorrow's loop closure cannot tell
  // a directed day from an idle one. `--choose` alone could not express this:
  // it resolves a rank, and directed work has none (#953-adjacent; found when a
  // whole day of throughput work left no record at all).
  const directedLabel = arg('--choose-directed')
  if (directedLabel) {
    const metric = arg('--metric') ?? null
    let metricValue = null
    if (metric) {
      metricValue = readPath(snapshot, metric)
      if (metricValue === undefined || metricValue === null) {
        // Fail loudly rather than store a metric that reads null and then reports
        // `no metric recorded` tomorrow, which would look like it was never given.
        process.stderr.write(`--metric ${metric} does not resolve in ${file}\n`)
        process.exit(1)
      }
    }
    const entry = {
      date: new Date().toISOString().slice(0, 10),
      chosenAt: new Date().toISOString(),
      kind: 'directed',
      label: directedLabel,
      metric,
      metricValue,
      costMinutes: null,
      note: arg('--note') ?? '',
    }
    appendFileSync(logFile, `${JSON.stringify(entry)}\n`)
    process.stdout.write(
      `recorded (directed): ${directedLabel}\n` +
        (metric
          ? `  metric ${metric} = ${metricValue}\n`
          : `  no metric -- tomorrow will say so rather than claim nothing happened\n`),
    )
    return
  }

  const choose = arg('--choose')
  if (choose) {
    const picked = findings.find((f) => f.rank === Number(choose))
    if (!picked) {
      process.stderr.write(`no finding ranked ${choose}\n`)
      process.exit(1)
    }
    const entry = {
      date: new Date().toISOString().slice(0, 10),
      chosenAt: new Date().toISOString(),
      kind: picked.kind,
      label: picked.label,
      metric: picked.metric,
      metricValue: picked.metricValue,
      costMinutes: picked.costMinutes,
      note: arg('--note') ?? '',
    }
    appendFileSync(logFile, `${JSON.stringify(entry)}\n`)
    process.stdout.write(`recorded: ${picked.label}\n  metric ${picked.metric} = ${picked.metricValue}\n`)
    return
  }

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ snapshot: file, loop, findings }, null, 2)}\n`)
    return
  }

  process.stdout.write(`\n${BOLD}practices standup${OFF} ${DIM}— ${file}, last 24h${OFF}\n\n`)

  if (loop) {
    const colour = loop.verdict === 'improved' ? GREEN : loop.verdict === 'did not move' ? YELLOW : RED
    process.stdout.write(
      `${BOLD}Yesterday you chose:${OFF} ${loop.label}${loop.kind === 'directed' ? ` ${DIM}(directed)${OFF}` : ''}\n`,
    )
    if (loop.metric) {
      process.stdout.write(`  ${loop.metric}\n`)
      process.stdout.write(
        `  ${loop.metricValue} → ${loop.now ?? '—'}   ${colour}${loop.verdict}${OFF}` +
          `${loop.delta === null ? '' : ` (${loop.delta > 0 ? '+' : ''}${loop.delta})`}\n`,
      )
    } else {
      process.stdout.write(
        `  ${colour}${loop.verdict}${OFF} ${DIM}-- directed work, so there is nothing to close.` +
          ` This is not the same as an idle day.${OFF}\n`,
      )
    }
    if (loop.note) process.stdout.write(`  ${DIM}note: ${loop.note}${OFF}\n`)
    if (loop.verdict === 'no metric recorded') {
      process.stdout.write(
        `  ${YELLOW}Nothing to conclude either way. If work like this should be measurable,` +
          ` name a metric at choose time: --choose-directed "..." --metric <path>.${OFF}\n`,
      )
    } else if (loop.verdict !== 'improved') {
      process.stdout.write(
        `  ${YELLOW}An intervention whose metric did not move is a finding. Decide before picking a new one.${OFF}\n`,
      )
    }
    process.stdout.write('\n')
  } else {
    process.stdout.write(`${DIM}No previous choice recorded — nothing to close the loop on.${OFF}\n\n`)
  }

  for (const f of findings.slice(0, 3)) {
    const cost = f.costMinutes === null ? `${YELLOW}cost unmeasured${OFF}` : `${round1(f.costMinutes / 60)}h`
    process.stdout.write(`${BOLD}${f.rank}. ${f.label}${OFF}${f.promoted ? ` ${YELLOW}[promoted: ${f.priorRows} prior rows]${OFF}` : ''}\n`)
    process.stdout.write(`   ${f.headline}\n`)
    process.stdout.write(
      `   ${DIM}cost ${cost} · recurrence ×${f.multiplier} (${f.priorRows} prior rows, ${f.explicitRecurrences} explicit) · score ${f.score ?? '—'}${OFF}\n`,
    )
    for (const line of f.evidence ?? []) process.stdout.write(`   ${DIM}· ${line}${OFF}\n`)
    process.stdout.write(`   ${DIM}basis: ${f.costBasis}${OFF}\n\n`)
  }

  // Ranks 4+ get a line each, not a comma-separated list of bare kind names. A
  // finding worth 30% of the day's merges was hidden behind the word
  // "amplification" in the first version of this output, which is the same
  // visibility failure the tool exists to fix, committed by the tool.
  if (findings.length > 3) {
    process.stdout.write(`${DIM}below the cut:${OFF}\n`)
    for (const f of findings.slice(3)) {
      const cost = f.costMinutes === null ? 'cost unmeasured' : `${round1(f.costMinutes / 60)}h`
      process.stdout.write(`  ${DIM}${f.rank}. ${f.label} — ${f.headline} (${cost}, ×${f.multiplier})${OFF}\n`)
    }
  }
  process.stdout.write(
    `\n${DIM}Pick one:  node scripts/practices-standup.mjs --choose <rank> --note "<plan>"${OFF}\n` +
      `${DIM}Directed:  node scripts/practices-standup.mjs --choose-directed "<what>" [--metric <path>] --note "<plan>"${OFF}\n\n`,
  )
}

if (process.argv[1] && process.argv[1].endsWith('practices-standup.mjs')) {
  main()
}
