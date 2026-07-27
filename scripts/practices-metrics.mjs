/**
 * Collect development-practices metrics across every Biffo and tabsii repo.
 *
 * ## Why this exists
 *
 * `docs/guides/development-practices.md` is a 38-row corpus of real failures,
 * and it cannot rank any of them. Exactly one row carries a cost figure and none
 * carries a date, so "highest impact first" is currently an opinion. Worse, the
 * page's own headline conclusion ("fail-open is the dominant shape — three of
 * the five filed issues") was written against a 5-row sample and never revised;
 * across all 38 rows `fail-open` is the *least* common class. Hand-narrated
 * conclusions drift from their own evidence.
 *
 * This script is the other half of the fix: numbers nobody has to remember to
 * write down. It reads what GitHub and git already know, so a snapshot cannot be
 * biased by the agent being measured.
 *
 * ## Why plain .mjs rather than TypeScript
 *
 * Same reasoning as `destructive-plan.mjs`: it runs on bare node with no
 * dependency install, so it can be invoked from a scheduled workflow that sets
 * up nothing. The pure logic is exported and tested from
 * `cli/src/lib/practices-metrics.test.ts`, so it has one home rather than a
 * TypeScript copy that can drift.
 *
 * ## The one rule this file obeys about its own results
 *
 * **"Could not measure" is never reported as zero.** The corpus's most valuable
 * lesson is that a gate which passes when it cannot run makes "green" and
 * "checked" different things. A metrics collector has the identical failure
 * mode: a repo whose runs did not come back would otherwise score a perfect
 * 0% CI failure rate and quietly drag the average down. Every metric here is
 * either a number or `null`, and `null` propagates into the snapshot as
 * `unmeasured` rather than being averaged in.
 *
 * Usage:
 *   node scripts/practices-metrics.mjs --out docs/practices/data
 *   node scripts/practices-metrics.mjs --window 30 --repo keiranholloway/biffo-template
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Snapshot schema version. Bump when a field's meaning changes, never when one is added. */
export const SCHEMA_VERSION = 1

/** Default observation window. 90 days is long enough to survive a quiet fortnight. */
export const DEFAULT_WINDOW_DAYS = 90

/** Windows the daily dashboard shows side by side: yesterday, this week, the baseline. */
export const DEFAULT_WINDOWS = [1, 7, 90]

/**
 * The repos under measurement, and where their working clone lives.
 *
 * `path` is only needed for the rework metric, which reads file-level history
 * from git rather than paying one API call per pull request. A repo with no
 * local clone still gets every other metric; its rework rate reports `null`.
 *
 * `biffo-template-fresh` is deliberately absent: it is a second checkout of
 * `keiranholloway/biffo-template`, and counting it would double every
 * template row.
 */
export const REPOS = [
  { slug: 'keiranholloway/biffo-template', path: 'biffo-template', role: 'template', side: 'platform' },
  { slug: 'keiranholloway/biffo-platform', path: 'biffo-platform', role: 'instance', side: 'platform' },
  { slug: 'keiranholloway/biffo-platform-app', path: 'biffo-platform-app', role: 'sibling', side: 'platform' },
  { slug: 'keiranholloway/biffo-plugin-ideation', path: 'biffo-plugin-ideation', role: 'plugin', side: 'platform' },
  { slug: 'keiranholloway/biffo-plugin-idea-scout', path: 'biffo-plugin-idea-scout', role: 'plugin', side: 'platform' },
  { slug: 'keiranholloway/biffo-runners', path: 'biffo-runners', role: 'infra', side: 'platform' },
  { slug: 'tabsii-com/tabsii-platform', path: 'tabsii-platform', role: 'instance', side: 'product' },
  { slug: 'tabsii-com/tabsii-crm', path: 'tabsii-crm', role: 'sibling', side: 'product' },
  { slug: 'tabsii-com/tabsii-intake', path: 'tabsii-intake', role: 'sibling', side: 'product' },
  { slug: 'tabsii-com/tabsii-map', path: 'tabsii-map', role: 'package', side: 'product' },
  { slug: 'tabsii-com/tabsii-geo', path: 'tabsii-geo', role: 'sibling', side: 'product' },
  { slug: 'tabsii-com/tabsii-marketplace', path: 'tabsii-marketplace', role: 'sibling', side: 'product' },
  { slug: 'tabsii-com/tabsii-app', path: 'tabsii-app', role: 'sibling', side: 'product' },
  { slug: 'tabsii-com/tabsii-runners', path: 'tabsii-runners', role: 'infra', side: 'product' },
  {
    slug: 'tabsii-com/tabsii-data-model-design',
    path: 'tabsii-data-model-design',
    role: 'design',
    side: 'product',
  },
]

/**
 * Conclusions that mean a gate ran and rejected the change.
 *
 * `cancelled` is excluded on purpose and counted separately: most cancellations
 * here are a newer push superseding an in-flight run, which is ordinary
 * iteration rather than a gate finding a defect. Folding the two together would
 * inflate the failure rate every time someone pushes twice in quick succession.
 */
export const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure'])

/** Conclusions that mean the gate never evaluated the change. Never counted as a pass. */
export const INCONCLUSIVE_CONCLUSIONS = new Set(['skipped', 'neutral', 'stale', null])

/** Conventional-commit types whose merge implies an earlier change was wrong. */
export const REWORK_TYPES = ['fix', 'revert']

/**
 * Paths blame must not attribute through.
 *
 * A lockfile is rewritten by nearly every change, so blaming a line in one
 * answers "who last touched the lockfile", never "which change is being
 * corrected". Including them pulls every lag toward the last merge.
 */
export const OPAQUE_PATHS =
  /(^|\/)(pnpm-lock\.yaml|uv\.lock|package-lock\.json|poetry\.lock|yarn\.lock|Cargo\.lock)$/

/**
 * What a conventional-commit type says the work *was*.
 *
 * The type is a declared intent, written before the outcome was known, which
 * makes it a cheap and reasonably honest classifier. It is the only signal
 * available that separates "built the product" from "fought the toolchain"
 * without anyone filling in a timesheet.
 */
/**
 * A merge that carries the template into an instance. Platform work wherever it
 * lands, because it maintains the machine rather than advancing the product.
 */
export const CORE_UPGRADE_SUBJECT = /upgrade biffo core|core[- ]upgrade/i

export const WORK_CLASS = {
  feat: 'delivery',
  fix: 'rework',
  revert: 'rework',
  ci: 'toil',
  chore: 'toil',
  infra: 'toil',
  build: 'toil',
  test: 'quality',
  refactor: 'quality',
  perf: 'quality',
  security: 'quality',
  docs: 'docs',
}

// ---------------------------------------------------------------------------
// Pure helpers — everything below this line is deterministic and unit-tested.
// ---------------------------------------------------------------------------

/**
 * Classify one merge by its declared intent.
 *
 * `unconventional` is its own bucket rather than being folded into "other":
 * ~8% of merges carry no parseable type, and quietly assigning them anywhere
 * would move the headline ratio by more than most experiments will.
 *
 * @param {string} subject
 */
export function classifyWork(subject) {
  const match = /^([a-z]+)(\(.+\))?!?:/.exec(subject)
  if (!match) return 'unconventional'
  return WORK_CLASS[match[1]] ?? 'other'
}

/**
 * Which side of the house does *this merge* serve?
 *
 * The repo is the default answer, but it is not always the right one. An
 * instance repo like `tabsii-platform` is simultaneously the product's backend
 * **and** a Biffo instance, so maintenance of the machine lands inside a product
 * repo: 30 of its 230 merges in the first 90-day window were core upgrades —
 * 7.8% of all product-repo merges — every one of them counted as product
 * delivery by the repo-level cut.
 *
 * That blur is not only a measurement artefact. A boundary where platform churn
 * structurally lands in product repos is a candidate root cause in its own
 * right, and is filed as such rather than merely corrected for here.
 *
 * @param {string} subject
 * @param {string | undefined} repoSide
 */
export function classifyMergeSide(subject, repoSide) {
  if (CORE_UPGRADE_SUBJECT.test(subject)) return 'platform'
  return repoSide ?? null
}

/**
 * The work-mix of a set of merges — the "are we building or maintaining?" view.
 *
 * `toilRatio` is the SRE framing: toil plus rework is effort that did not add
 * product value. Google's SRE practice caps toil at 50%; the first measurement
 * here across 1,023 merges put this estate at **43.5%**, which independently
 * reproduced the practices corpus's hand-estimate of "~40% toolchain" from a
 * single day's work.
 *
 * @param {Array<{subject: string}>} commits
 */
export function summariseWorkMix(commits, repoSide) {
  const empty = {
    merges: 0,
    delivery: null, rework: null, toil: null, quality: null, docs: null, unconventional: null,
    toilRatio: null,
    counts: { delivery: 0, rework: 0, toil: 0, quality: 0, docs: 0, unconventional: 0, other: 0 },
    sideCounts: { platform: 0, product: 0 },
    productDelivery: 0,
  }
  if (commits.length === 0) return empty

  const counts = { delivery: 0, rework: 0, toil: 0, quality: 0, docs: 0, unconventional: 0, other: 0 }
  const sideCounts = { platform: 0, product: 0 }
  let productDelivery = 0

  for (const commit of commits) {
    const kind = classifyWork(commit.subject)
    counts[kind] = (counts[kind] ?? 0) + 1
    const side = classifyMergeSide(commit.subject, repoSide)
    if (side) sideCounts[side] += 1
    if (side === 'product' && kind === 'delivery') productDelivery += 1
  }

  const n = commits.length
  return {
    merges: n,
    delivery: rate(counts.delivery, n),
    rework: rate(counts.rework, n),
    toil: rate(counts.toil, n),
    quality: rate(counts.quality, n),
    docs: rate(counts.docs, n),
    unconventional: rate(counts.unconventional, n),
    toilRatio: rate(counts.toil + counts.rework, n),
    // Absolute counts so the estate rollup can sum rather than reconstruct
    // totals from percentages — that reconstruction was lossy and let a repo
    // with three merges pull as hard as one with four hundred.
    counts,
    sideCounts,
    productDelivery,
  }
}

/**
 * Narrow a repo's raw history to one observation window.
 *
 * Exists so a daily dashboard can show 24h, 7d and 90d from a **single** fetch.
 * Collecting three times would triple the API calls and the blame work, and —
 * worse — the three windows could then disagree because they were taken at
 * different moments.
 *
 * @param {{prs: Array<any>, runs: Array<any>, defaultBranch: string, rework: {fixes: Array<any>, commits: Array<any>} | null}} data
 * @param {string} since ISO timestamp
 */
export function filterToWindow(data, since) {
  const from = Date.parse(since)
  return {
    defaultBranch: data.defaultBranch,
    prs: data.prs.filter((pr) => pr.mergedAt && Date.parse(pr.mergedAt) >= from),
    runs: data.runs.filter((run) => Date.parse(run.created_at) >= from),
    rework: data.rework
      ? {
          fixes: data.rework.fixes.filter((fix) => fix.at >= from),
          commits: data.rework.commits.filter((commit) => commit.at >= from),
        }
      : null,
  }
}

/**
 * Nearest-rank percentile.
 *
 * Returns `null` for an empty set rather than 0: no observations and "every
 * observation was zero" are different claims, and only one of them is good news.
 *
 * @param {number[]} values
 * @param {number} p percentile in 0..100
 * @returns {number | null}
 */
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1)
  return sorted[index]
}

/**
 * Round to one decimal place, preserving `null`.
 *
 * @param {number | null} value
 * @returns {number | null}
 */
export function round1(value) {
  return value === null || value === undefined ? null : Math.round(value * 10) / 10
}

/**
 * Percentage of `numerator` in `denominator`, or `null` when there is nothing to
 * divide. Guards the case that makes a metric lie: 0/0 is not 0%.
 *
 * @param {number} numerator
 * @param {number} denominator
 * @returns {number | null}
 */
export function rate(numerator, denominator) {
  if (!denominator) return null
  return round1((numerator / denominator) * 100)
}

/**
 * Group workflow runs by the branch they ran on, so a pull request can find its
 * own runs without a per-PR API call.
 *
 * @param {Array<Record<string, unknown>>} runs
 * @returns {Map<string, Array<Record<string, unknown>>>}
 */
export function indexRunsByBranch(runs) {
  /** @type {Map<string, Array<Record<string, unknown>>>} */
  const index = new Map()
  for (const run of runs) {
    const branch = /** @type {string} */ (run.head_branch)
    if (!branch) continue
    const bucket = index.get(branch)
    if (bucket) bucket.push(run)
    else index.set(branch, [run])
  }
  return index
}

/**
 * The runs that belong to one pull request.
 *
 * Matched by branch name and bounded by the PR's own lifetime. Branch names are
 * reused across pull requests here (`fix/…` names repeat), so the time window is
 * what stops one PR claiming another's runs. A day of slack after the merge
 * catches runs still finishing as the merge lands.
 *
 * @param {{createdAt: string, mergedAt: string | null, headRefName: string}} pr
 * @param {Map<string, Array<Record<string, unknown>>>} runsByBranch
 * @returns {Array<Record<string, unknown>>}
 */
export function runsForPr(pr, runsByBranch) {
  const candidates = runsByBranch.get(pr.headRefName) ?? []
  const opened = Date.parse(pr.createdAt)
  const closed = pr.mergedAt ? Date.parse(pr.mergedAt) : Date.now()
  const until = closed + 24 * 60 * 60 * 1000
  return candidates.filter((run) => {
    const created = Date.parse(/** @type {string} */ (run.created_at))
    return created >= opened && created <= until
  })
}

/**
 * How much iteration one pull request cost.
 *
 * `revisions` counts distinct head SHAs that were pushed and tested — 0 means
 * the branch landed exactly as first pushed. This is deliberately separate from
 * `ciFailed`, because the two came apart the moment they were first measured:
 * PR #691 pushed three SHAs and every CI run on all three was green. A single
 * "first-pass green" metric scores that a perfect 100% while hiding three
 * revisions and 29 minutes of churn. Gates rejecting work and humans guessing
 * are different problems with different fixes.
 *
 * Returns `null` fields when no runs were found at all: that is an unmeasured
 * PR, not a clean one.
 *
 * @param {{createdAt: string, mergedAt: string | null, headRefName: string}} pr
 * @param {Map<string, Array<Record<string, unknown>>>} runsByBranch
 */
export function prChurn(pr, runsByBranch) {
  const runs = runsForPr(pr, runsByBranch)
  if (runs.length === 0) {
    return { revisions: null, ciFailed: null, failedRuns: null, cancelledRuns: null, runs: 0 }
  }
  const shas = new Set(runs.map((run) => run.head_sha))
  const failedRuns = runs.filter((run) =>
    FAILING_CONCLUSIONS.has(/** @type {string} */ (run.conclusion)),
  ).length
  const cancelledRuns = runs.filter((run) => run.conclusion === 'cancelled').length
  return {
    revisions: shas.size - 1,
    ciFailed: failedRuns > 0,
    failedRuns,
    cancelledRuns,
    runs: runs.length,
  }
}

/** Minutes a PR must sit green before its wait counts as losing the merge race. */
export const RACE_THRESHOLD_MINUTES = 10

/**
 * Merge contention — work that was *correct* and still could not land.
 *
 * ## Why this is a separate axis from churn
 *
 * Churn means the code was wrong. Contention means the code was right and lost
 * the up-to-date race against a fast-moving integration branch: green, then
 * behind, then rebased, then green again, then behind again. The two need
 * different fixes — one is about verifying before merging, the other is about
 * how merges are sequenced — so collapsing them into one number would point at
 * the wrong remedy.
 *
 * ## Why the median is the wrong statistic here
 *
 * The first attempt at measuring contention used runner pickup latency
 * (`run_started_at - created_at`) and reported ~0, concluding there was none.
 * That was contradicted by PR #659, which went green three minutes after
 * opening and merged **46 minutes later** across five head SHAs — four rebases
 * lost to the race, exactly as the practices corpus recorded.
 *
 * Measured properly, the median green-to-merge lag really is ~1 minute — and
 * p90 is 25.8 minutes, the max is 15.7 hours, and the total green-but-unmerged
 * time is **163 hours across 453 PRs**. The cost lives entirely in the tail, so
 * this function reports p90, the max and the total, and never the median alone.
 *
 * @param {Array<{createdAt: string, mergedAt: string | null, headRefName: string}>} prs
 * @param {Map<string, Array<Record<string, unknown>>>} runsByBranch
 */
export function mergeContention(prs, runsByBranch) {
  const merged = prs.filter((pr) => pr.mergedAt)
  /** Minutes each PR spent green but unmerged. */
  const greenToMerge = []
  let repushed = 0
  let raced = 0
  let measured = 0

  for (const pr of merged) {
    const churn = prChurn(pr, runsByBranch)
    if (churn.revisions === null) continue
    measured += 1
    if (churn.revisions > 0) repushed += 1

    const runs = runsForPr(pr, runsByBranch)
    const greens = runs
      .filter((run) => run.conclusion === 'success')
      .map((run) => Date.parse(/** @type {string} */ (run.updated_at ?? run.created_at)))
      .sort((a, b) => a - b)
    if (greens.length === 0) continue

    const lag = (Date.parse(/** @type {string} */ (pr.mergedAt)) - greens[0]) / 60000
    // A negative lag means the merge landed before any run completed — the PR
    // was merged without waiting, which is not contention.
    if (lag <= 0) continue
    greenToMerge.push(lag)
    if (lag > RACE_THRESHOLD_MINUTES && churn.revisions > 0) raced += 1
  }

  return {
    // The headline: total time correct work spent unable to land.
    greenButUnmergedHours: round1(greenToMerge.reduce((sum, m) => sum + m, 0) / 60),
    greenToMergeP50Minutes: round1(percentile(greenToMerge, 50)),
    greenToMergeP90Minutes: round1(percentile(greenToMerge, 90)),
    greenToMergeMaxMinutes: greenToMerge.length ? round1(Math.max(...greenToMerge)) : null,
    // Rebase pressure: a repush on an already-correct branch is pure race cost.
    repushRate: rate(repushed, measured),
    // The cleanest single indicator — green for longer than the threshold *and*
    // forced to repush. tabsii-crm scores 0% here and biffo-template 13.9%,
    // which is the difference a busy shared integration branch makes.
    racedShare: rate(raced, measured),
    prsMeasured: measured,
    prsWithGreen: greenToMerge.length,
  }
}

/**
 * Minutes from opening a pull request to merging it.
 *
 * Honest about what it excludes: everything before the PR existed. A change that
 * took three hours to write and two minutes to merge reads as two minutes here.
 * It measures the landing, not the work.
 *
 * @param {{createdAt: string, mergedAt: string | null}} pr
 * @returns {number | null}
 */
export function cycleTimeMinutes(pr) {
  if (!pr.mergedAt) return null
  return (Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / 60000
}

/**
 * Runs that reached two different verdicts on the identical commit.
 *
 * A workflow that both passed and failed on one SHA cannot have been reacting to
 * the code. This is the number that decides whether a green check is evidence of
 * anything, so it is worth knowing even when it is small.
 *
 * @param {Array<Record<string, unknown>>} runs
 * @returns {{ pairs: number, shas: string[] }}
 */
export function detectFlakes(runs) {
  /** @type {Map<string, Set<string>>} */
  const verdicts = new Map()
  for (const run of runs) {
    const conclusion = /** @type {string} */ (run.conclusion)
    if (conclusion !== 'success' && !FAILING_CONCLUSIONS.has(conclusion)) continue
    const key = `${run.head_sha}::${run.name}`
    const seen = verdicts.get(key)
    if (seen) seen.add(conclusion === 'success' ? 'success' : 'failure')
    else verdicts.set(key, new Set([conclusion === 'success' ? 'success' : 'failure']))
  }
  const flaky = [...verdicts.entries()].filter(([, outcomes]) => outcomes.size > 1)
  return { pairs: flaky.length, shas: flaky.map(([key]) => key.split('::')[0]) }
}

/**
 * How long the integration branch spent red.
 *
 * A red `dev` blocks every agent at once, so its cost is multiplied by however
 * many are working. Measured as the gap between a failing push-event run and the
 * next successful run of the same workflow; a failure never followed by a
 * success is left open and reported separately rather than being silently
 * treated as instantly recovered.
 *
 * @param {Array<Record<string, unknown>>} runs
 * @param {string} branch
 */
export function integrationHealth(runs, branch) {
  const onBranch = runs
    .filter((run) => run.head_branch === branch && run.event === 'push')
    .sort((a, b) => Date.parse(String(a.created_at)) - Date.parse(String(b.created_at)))
  if (onBranch.length === 0) {
    return { runs: 0, failures: null, redMinutes: null, unresolvedFailures: null }
  }

  /** @type {Map<string, number>} */
  const openedAt = new Map()
  let redMinutes = 0
  let failures = 0
  for (const run of onBranch) {
    const workflow = /** @type {string} */ (run.name)
    const at = Date.parse(String(run.updated_at ?? run.created_at))
    if (FAILING_CONCLUSIONS.has(/** @type {string} */ (run.conclusion))) {
      failures += 1
      if (!openedAt.has(workflow)) openedAt.set(workflow, at)
    } else if (run.conclusion === 'success') {
      const start = openedAt.get(workflow)
      if (start !== undefined) {
        redMinutes += (at - start) / 60000
        openedAt.delete(workflow)
      }
    }
  }
  return {
    runs: onBranch.length,
    failures,
    redMinutes: round1(redMinutes),
    unresolvedFailures: openedAt.size,
  }
}

/**
 * Parse `git log` output into commits carrying the files they touched.
 *
 * Expects the format written by {@link gitLogCommand}: a header line of
 * `<sha>\x1f<unix-ts>\x1f<subject>` followed by one path per line.
 *
 * @param {string} stdout
 */
export function parseGitLog(stdout) {
  /** @type {Array<{sha: string, at: number, subject: string, files: string[]}>} */
  const commits = []
  for (const line of stdout.split('\n')) {
    if (line.includes('\x1f')) {
      const [sha, ts, ...rest] = line.split('\x1f')
      commits.push({ sha, at: Number(ts) * 1000, subject: rest.join('\x1f'), files: [] })
    } else if (line.trim() && commits.length > 0) {
      commits[commits.length - 1].files.push(line.trim())
    }
  }
  return commits
}

/**
 * Is this commit subject a correction of earlier work?
 *
 * @param {string} subject
 */
export function isReworkSubject(subject) {
  return REWORK_TYPES.some((type) => new RegExp(`^${type}(\\(.+\\))?!?:`).test(subject))
}

/**
 * Parse `git diff -U0` output into the *pre-image* line ranges a commit changed.
 *
 * `-U0` matters: with context lines the ranges spill into untouched code and
 * blame then attributes the fix to whoever last edited the neighbourhood.
 *
 * Pure insertions (`count === 0`) are dropped — a hunk that only adds lines
 * corrects no existing line, so there is nothing to attribute. New files
 * (`--- /dev/null`) are dropped for the same reason.
 *
 * @param {string} diff
 * @returns {Array<{file: string, start: number, count: number}>}
 */
export function parseDiffHunks(diff) {
  /** @type {Array<{file: string, start: number, count: number}>} */
  const hunks = []
  let file = null
  for (const line of diff.split('\n')) {
    if (line.startsWith('--- /dev/null')) file = null
    else if (line.startsWith('--- a/')) file = line.slice(6)
    else if (line.startsWith('@@') && file && !OPAQUE_PATHS.test(file)) {
      const match = /^@@ -(\d+)(?:,(\d+))? /.exec(line)
      if (!match) continue
      const count = match[2] === undefined ? 1 : Number(match[2])
      if (count === 0) continue
      hunks.push({ file, start: Number(match[1]), count })
    }
  }
  return hunks
}

/**
 * Roll line-attributed fixes into the rework metrics.
 *
 * ## Why this is blame-based and not file-based
 *
 * The first implementation counted a fix as rework when it touched *any file*
 * another commit had touched in the previous seven days. Measured against real
 * history that filter removed 4 of 195 commits — on a repo merging every ~12
 * minutes, essentially every file has been touched recently, so the metric was
 * `fixShare` in a disguise and its "lag" tracked merge cadence rather than
 * correction latency. Spot-checking showed the top pairs were nonsense:
 * `fix(networking): sweep the VPC flow-logs group` "correcting"
 * `security(deps): override brace-expansion`, two unrelated changes that shared
 * a file.
 *
 * Attributing at line level moved the median from 0.8h to 2.4h and p90 from
 * 18.2h to 63.6h — the file-level version understated lag roughly threefold.
 *
 * @param {Array<{at: number, correctedAt: number | null}>} fixes
 * @param {number} merges total first-parent merges in the window
 */
export function summariseRework(fixes, merges) {
  if (merges === 0) {
    return {
      merges: 0,
      fixMerges: null,
      fixShare: null,
      attributed: null,
      medianHoursToRework: null,
      p90HoursToRework: null,
      correctedWithin1hShare: null,
      correctedWithin24hShare: null,
    }
  }

  const lags = fixes
    .filter((fix) => fix.correctedAt !== null)
    .map((fix) => (fix.at - fix.correctedAt) / 3600000)

  return {
    merges,
    fixMerges: fixes.length,
    // Robust and cheap: no attribution required, so it cannot be wrong, only
    // coarse. Reported beside the lag so a shifting lag can be checked against
    // a stable denominator.
    fixShare: rate(fixes.length, merges),
    // Coverage. Fixes that only insert lines are unattributable by construction,
    // so this is always below fixMerges and that is not a defect.
    attributed: lags.length,
    // The discriminating measurements. A fix correcting code written an hour
    // ago is a guess that shipped; one correcting code from last week is
    // ordinary defect discovery. Only these separate them.
    medianHoursToRework: round1(percentile(lags, 50)),
    p90HoursToRework: round1(percentile(lags, 90)),
    correctedWithin1hShare: rate(lags.filter((h) => h < 1).length, lags.length),
    correctedWithin24hShare: rate(lags.filter((h) => h < 24).length, lags.length),
  }
}

/**
 * Roll one repo's raw GitHub data into the metric set.
 *
 * @param {{slug: string, role: string}} repo
 * @param {{prs: Array<Record<string, any>>, runs: Array<Record<string, any>>, defaultBranch: string, rework: {fixes: Array<{at: number, correctedAt: number | null}>, merges: number} | null}} data
 */
export function summariseRepo(repo, data) {
  const { prs, runs, defaultBranch, rework } = data
  const runsByBranch = indexRunsByBranch(runs)
  const merged = prs.filter((pr) => pr.mergedAt)

  const churns = merged.map((pr) => prChurn(pr, runsByBranch))
  const measured = churns.filter((c) => c.revisions !== null)
  const cycleTimes = merged.map(cycleTimeMinutes).filter((minutes) => minutes !== null)

  return {
    role: repo.role,
    side: repo.side,
    defaultBranch,
    mergedPrs: merged.length,
    // Are we building the product or maintaining the machine?
    workMix: rework
      ? summariseWorkMix(rework.commits, repo.side)
      : {
          merges: null, delivery: null, rework: null, toil: null, quality: null,
          docs: null, unconventional: null, toilRatio: null,
          counts: null, sideCounts: null, productDelivery: null,
        },
    // Consistency — two metrics, never one. See prChurn().
    ciFailureRate: rate(measured.filter((c) => c.ciFailed).length, measured.length),
    revisionsP50: percentile(
      measured.map((c) => c.revisions),
      50,
    ),
    revisionsP90: percentile(
      measured.map((c) => c.revisions),
      90,
    ),
    landedFirstPushRate: rate(measured.filter((c) => c.revisions === 0).length, measured.length),
    // Speed.
    cycleTimeP50Minutes: round1(percentile(cycleTimes, 50)),
    cycleTimeP90Minutes: round1(percentile(cycleTimes, 90)),
    // The anti-goal.
    rework: rework
      ? summariseRework(rework.fixes, rework.commits.length)
      : {
          merges: null,
          fixMerges: null,
          fixShare: null,
          attributed: null,
          medianHoursToRework: null,
          p90HoursToRework: null,
          correctedWithin1hShare: null,
          correctedWithin24hShare: null,
        },
    // Correct work that could not land. Separate axis from churn — see
    // mergeContention() for why collapsing them points at the wrong fix.
    contention: mergeContention(prs, runsByBranch),
    // Trust in the gates themselves.
    flakes: detectFlakes(runs),
    integration: integrationHealth(runs, defaultBranch),
    // Honesty about coverage: the denominator every rate above was computed on.
    coverage: {
      prsMeasured: measured.length,
      prsUnmeasured: merged.length - measured.length,
      workflowRuns: runs.length,
      reworkSource: rework ? 'git-blame' : 'unavailable',
    },
  }
}

/**
 * Roll every repo up into the estate-level view the daily page leads with.
 *
 * The question this answers is the one that decides where effort goes: **are we
 * building the product or maintaining the machine?** Biffo is the platform
 * Tabsii runs on, so `biffo-*` merges are investment in the machine and
 * `tabsii-*` merges are product delivery.
 *
 * `productFeatureShare` is the headline. On the first 90-day measurement it was
 * **14.4%** — roughly one merge in seven was a feature in the thing being sold.
 *
 * Caveat carried in the output rather than left to memory: **merges are not
 * time.** A one-line `chore:` and a week-long `feat:` count the same. This is a
 * directional proxy that costs nothing, not a timesheet.
 *
 * @param {Record<string, any>} repos
 */
export function summariseEstate(repos) {
  const usable = Object.values(repos).filter((r) => r && !r.error && r.workMix?.counts)
  if (usable.length === 0) {
    return {
      merges: 0,
      platformShare: null,
      productShare: null,
      toilRatio: null,
      productFeatureShare: null,
      contentionHours: null,
      bySide: {},
      note: 'merges are a proxy for effort, not a measure of time',
    }
  }

  const sum = (fn) => usable.reduce((total, r) => total + fn(r), 0)
  const merges = sum((r) => r.workMix.merges)
  const platform = sum((r) => r.workMix.sideCounts.platform)
  const product = sum((r) => r.workMix.sideCounts.product)
  const toil = sum((r) => r.workMix.counts.toil)
  const rework = sum((r) => r.workMix.counts.rework)

  /**
   * Per-side rollup. A repo contributes to *both* sides when its merges do —
   * an instance repo carries core upgrades (platform) alongside features
   * (product), and attributing the whole repo to one side is the error this
   * function exists to remove.
   */
  const bySide = {}
  for (const side of ['platform', 'product']) {
    const n = sum((r) => r.workMix.sideCounts[side])
    if (!n) continue
    // Kind counts are not split by side (a merge has one kind and one side, but
    // the cross-tab is only tracked for the product-delivery cell that the
    // headline needs). Shares here are of that side's merges.
    bySide[side] = {
      merges: n,
      share: rate(n, merges),
    }
  }

  return {
    merges,
    platformShare: rate(platform, merges),
    productShare: rate(product, merges),
    // SRE framing: toil + rework is effort that added no product value.
    toilRatio: rate(toil + rework, merges),
    // The headline. Features shipped in the product, as a share of ALL merges —
    // now excluding core upgrades that land in a product repo.
    productFeatureShare: rate(sum((r) => r.workMix.productDelivery), merges),
    contentionHours: round1(sum((r) => r.contention?.greenButUnmergedHours ?? 0)),
    bySide,
    note: 'merges are a proxy for effort, not a measure of time',
  }
}

// ---------------------------------------------------------------------------
// I/O — everything below shells out; none of it is unit-tested.
// ---------------------------------------------------------------------------

/** @param {string[]} args */
function gh(args) {
  const stdout = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  return JSON.parse(stdout)
}

/**
 * The `git log` invocation {@link parseGitLog} expects.
 *
 * `--first-parent` keeps this to what actually landed on the integration branch,
 * so a PR's internal commits do not each count as a merge.
 *
 * @param {string} since ISO date
 */
export function gitLogCommand(since) {
  return ['log', '--first-parent', `--since=${since}`, '--format=%H%x1f%ct%x1f%s', '--name-only']
}

/**
 * Attribute each fix to the change it corrects, by blaming the lines it altered.
 *
 * Returns `null` when the repo has no usable local clone — never an empty
 * result, which would score as "no rework".
 *
 * @param {string} repoPath @param {string} since @param {string} branch
 */
function fetchRework(repoPath, since, branch) {
  /** @param {string[]} args */
  const git = (args) =>
    execFileSync('git', ['-C', repoPath, ...args], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    })

  let commits
  try {
    execFileSync('git', ['-C', repoPath, 'fetch', 'origin', branch, '--quiet'], { stdio: 'ignore' })
    commits = parseGitLog(git([...gitLogCommand(since), `origin/${branch}`]))
  } catch {
    return null
  }

  const fixes = []
  for (const commit of commits.filter((c) => isReworkSubject(c.subject))) {
    let correctedAt = null
    let hunks = []
    try {
      hunks = parseDiffHunks(git(['diff', '-U0', `${commit.sha}^`, commit.sha]))
    } catch {
      // A root commit has no parent to diff against; nothing to attribute.
    }
    for (const hunk of hunks) {
      try {
        const porcelain = git([
          'blame',
          `${commit.sha}^`,
          '-L',
          `${hunk.start},+${hunk.count}`,
          '--porcelain',
          '--',
          hunk.file,
        ])
        for (const line of porcelain.split('\n')) {
          const match = /^committer-time (\d+)$/.exec(line)
          if (!match) continue
          const at = Number(match[1]) * 1000
          // The most recent prior authorship is the change being corrected.
          if (at < commit.at && (correctedAt === null || at > correctedAt)) correctedAt = at
        }
      } catch {
        // File renamed away, deleted, or binary — unattributable, not clean.
      }
    }
    fixes.push({ at: commit.at, correctedAt })
  }

  return { fixes, commits: commits.map((c) => ({ at: c.at, subject: c.subject })) }
}

/** @param {string} slug @param {string} since */
function fetchPrs(slug, since) {
  const prs = gh([
    'pr',
    'list',
    '-R',
    slug,
    '--state',
    'merged',
    '--limit',
    '1000',
    '--json',
    'number,title,createdAt,mergedAt,headRefName,baseRefName',
  ])
  return prs.filter((pr) => pr.mergedAt >= since)
}

/**
 * Every workflow run in the window, walked page by page.
 *
 * Stops as soon as a page's oldest run predates the window, so a repo with years
 * of history costs the same as one with a month.
 *
 * @param {string} slug @param {string} since
 */
function fetchRuns(slug, since) {
  /** @type {Array<Record<string, any>>} */
  const all = []
  for (let page = 1; page <= 40; page += 1) {
    const body = gh(['api', `repos/${slug}/actions/runs?per_page=100&page=${page}`])
    const runs = body.workflow_runs ?? []
    if (runs.length === 0) break
    all.push(...runs.filter((run) => run.created_at >= since))
    if (runs[runs.length - 1].created_at < since) break
  }
  return all
}

function parseArgs(argv) {
  const args = {
    windows: DEFAULT_WINDOWS,
    out: 'docs/practices/data',
    repo: null,
    reposRoot: null,
  }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--window') args.windows = [Number(argv[++i])]
    else if (argv[i] === '--windows') args.windows = argv[++i].split(',').map(Number)
    else if (argv[i] === '--out') args.out = argv[++i]
    else if (argv[i] === '--repo') args.repo = argv[++i]
    else if (argv[i] === '--repos-root') args.reposRoot = argv[++i]
  }
  args.windows.sort((a, b) => a - b)
  return args
}

/**
 * Where the sibling clones live.
 *
 * Derived from git's *common* dir, which points at the primary checkout even
 * when this runs from a worktree — so the answer is the same from
 * `biffo-template/` and from `biffo-template/.worktrees/anything/`. Guessing
 * with a fixed `../../..` silently resolves to `/home` from the primary
 * checkout, and every rework metric would then report `unavailable` while
 * looking like it ran.
 */
function resolveReposRoot() {
  const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
  }).trim()
  return join(commonDir, '..', '..')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const reposRoot = args.reposRoot ?? resolveReposRoot()
  const maxWindow = Math.max(...args.windows)
  // One fetch, at the widest window; every narrower window is a filter over the
  // same data. Collecting per-window would triple the API and blame cost and —
  // worse — let the windows disagree because they were taken at different times.
  const fetchSince = new Date(Date.now() - maxWindow * 864e5).toISOString()
  const targets = args.repo ? REPOS.filter((r) => r.slug === args.repo) : REPOS

  /** @type {Record<string, any>} */
  const raw = {}
  /** @type {Array<{repo: string, error: string}>} */
  const failures = []

  for (const repo of targets) {
    process.stderr.write(`  ${repo.slug} … `)
    try {
      const meta = gh(['repo', 'view', repo.slug, '--json', 'defaultBranchRef'])
      const defaultBranch = meta.defaultBranchRef?.name ?? 'dev'
      const prs = fetchPrs(repo.slug, fetchSince)
      const runs = fetchRuns(repo.slug, fetchSince)
      const rework = fetchRework(join(reposRoot, repo.path), fetchSince, defaultBranch)
      raw[repo.slug] = { prs, runs, defaultBranch, rework }
      process.stderr.write(`${prs.length} PRs, ${runs.length} runs\n`)
    } catch (error) {
      // A repo that could not be read is recorded as such and excluded from
      // every aggregate. It is never allowed to contribute a zero.
      failures.push({ repo: repo.slug, error: String(error).split('\n')[0] })
      raw[repo.slug] = null
      process.stderr.write('FAILED\n')
    }
  }

  /** @type {Record<string, any>} */
  const windows = {}
  for (const days of args.windows) {
    const since = new Date(Date.now() - days * 864e5).toISOString()
    /** @type {Record<string, any>} */
    const repos = {}
    for (const repo of targets) {
      repos[repo.slug] = raw[repo.slug]
        ? summariseRepo(repo, filterToWindow(raw[repo.slug], since))
        : { error: 'unmeasured' }
    }
    windows[days] = { since, repos, estate: summariseEstate(repos) }
  }

  const snapshot = {
    schema: SCHEMA_VERSION,
    collectedAt: new Date().toISOString(),
    windowDays: args.windows,
    windows,
    unmeasured: failures,
  }

  mkdirSync(args.out, { recursive: true })
  const file = join(args.out, `${new Date().toISOString().slice(0, 10)}.json`)
  writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`)
  process.stderr.write(`\nwrote ${file}\n`)
}

if (process.argv[1] && process.argv[1].endsWith('practices-metrics.mjs')) {
  main()
}
