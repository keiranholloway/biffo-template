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
 *   node scripts/practices-metrics.mjs --gate-lookback 7   # cheaper jobs fetch
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Snapshot schema version. Bump when a field's meaning changes, never when one is added. */
export const SCHEMA_VERSION = 2

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

/**
 * The workflow whose success means "this code is now running" (#767).
 *
 * Named identically across every deploying repo in the estate — checked on
 * biffo-template, biffo-platform and tabsii-platform. A repo without it yields
 * `null` for the running stop rather than 0: "does not deploy" and "deployed
 * instantly" are different claims and only one is good news.
 */
export const DEPLOY_WORKFLOW = 'Deploy Application'

/** Marker `biffo core upgrade` writes into its PR body (#767). */
export const CARRIED_PRS_MARKER = 'biffo:carries-template-prs:'

/**
 * Branch prefix `biffo core upgrade` always creates. Mirrors
 * `UPGRADE_BRANCH_PREFIX` in `cli/src/lib/core-upgrade.ts`.
 */
export const UPGRADE_BRANCH_PREFIX = 'biffo/core-upgrade-'

/**
 * Is this PR actually an upgrade, rather than one that merely *mentions* the
 * marker?
 *
 * Not paranoia — this fired on the first real run. `biffo-template` reported an
 * upgrade PR carrying four template PRs, which is impossible: the template does
 * not upgrade itself. The parser had matched the marker inside PR #772's own
 * body, where it appears as **documentation of the format**. A PR describing the
 * mechanism was counted as one emitting it.
 *
 * The branch name is the discriminator because the CLI controls it absolutely:
 * `upgradeBranchName()` is the only thing that opens these PRs. Body text is
 * written by whoever is describing the feature.
 *
 * @param {Record<string, any>} pr
 */
export function isUpgradePr(pr) {
  return typeof pr.headRefName === 'string' && pr.headRefName.startsWith(UPGRADE_BRANCH_PREFIX)
}

/**
 * Template PR numbers an instance's upgrade PR carries (#767).
 *
 * Returns `[]` for any body without the marker, which is every PR except an
 * upgrade — and every upgrade opened before the marker shipped. That is a
 * *coverage* fact, not an error: the metric simply has nothing to say about
 * those, and says nothing rather than guessing.
 *
 * @param {string | null | undefined} body
 */
export function parseCarriedPrs(body) {
  if (typeof body !== 'string') return []
  const match = new RegExp(`${CARRIED_PRS_MARKER}([0-9,]+)`).exec(body)
  if (!match?.[1]) return []
  const numbers = match[1]
    .split(',')
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
  return [...new Set(numbers)].sort((a, b) => a - b)
}

/**
 * Template PR number → the issue keys it closed.
 *
 * @param {string} templateSlug
 * @param {Array<Record<string, any>>} templatePrs
 * @returns {Map<number, string[]>}
 */
export function indexClosingIssues(templateSlug, templatePrs) {
  /** @type {Map<number, string[]>} */
  const index = new Map()
  for (const pr of templatePrs) {
    const keys = (pr.closingIssuesReferences ?? [])
      .map((ref) => {
        const owner = ref.repository?.owner?.login
        const name = ref.repository?.name
        return owner && name ? `${owner}/${name}#${ref.number}` : null
      })
      .filter((key) => key !== null)
    if (keys.length > 0) index.set(pr.number, keys)
  }
  return index
}

/**
 * Time from a **template** issue being opened to it running in an instance —
 * the whole six-hop distribution, measured rather than described (#767).
 *
 * A template feature is not usable when its template PR merges. It becomes
 * usable when an instance deploys it, five hops later: tag → npm publish →
 * `core upgrade` → instance PR → deploy. `development-practices.md` prices that
 * at "~40 min minimum" and once at three full release cycles for one feature,
 * but only ever from anecdote, because nothing recorded which issues an upgrade
 * carried. The marker does; this reads it.
 *
 * `carriedWithoutIssue` is reported deliberately. The first marker ever emitted
 * carried twelve template PRs and **none of them closed an issue** — every one
 * used `Refs #N`, correctly, because the issues were not finished. That is the
 * binding constraint on this metric and it must be visible, not inferred from a
 * small `measured`.
 *
 * @param {Array<Record<string, any>>} instancePrs merged, with `body`
 * @param {Map<number, string[]>} closingIssues template PR → issue keys
 * @param {Map<string, string>} issueOpenedAt issue key → ISO createdAt
 * @param {Array<{startedAt: number, finishedAt: number}>} deploys instance deploys
 */
export function crossRepoTimeToFeature(instancePrs, closingIssues, issueOpenedAt, deploys) {
  const hours = []
  let upgradePrs = 0
  let carriedPrs = 0
  let carriedWithoutIssue = 0
  let awaitingDeploy = 0
  for (const pr of instancePrs) {
    // Branch name first: a PR that merely documents the marker is not an
    // upgrade, and counting one as such is how the template reported carrying
    // its own PRs on the first real run.
    if (!isUpgradePr(pr)) continue
    const carried = parseCarriedPrs(pr.body)
    if (carried.length === 0) continue
    upgradePrs += 1
    carriedPrs += carried.length
    // One deploy carries every issue in the upgrade, so it is resolved once
    // rather than per issue.
    const ranAt = firstDeployAfter(deploys, pr.mergedAt)
    for (const number of carried) {
      const keys = closingIssues.get(number)
      if (!keys || keys.length === 0) {
        carriedWithoutIssue += 1
        continue
      }
      for (const key of keys) {
        const openedAt = issueOpenedAt.get(key)
        if (!openedAt) continue
        if (ranAt === null) {
          awaitingDeploy += 1
          continue
        }
        const delta = ranAt - Date.parse(openedAt)
        if (!Number.isFinite(delta) || delta < 0) continue
        hours.push(delta / 3_600_000)
      }
    }
  }
  return {
    upgradePrs,
    carriedPrs,
    carriedWithoutIssue,
    awaitingDeploy,
    measured: hours.length,
    hoursP50: round1(percentile(hours, 50)),
    hoursP90: round1(percentile(hours, 90)),
    hoursMax: hours.length ? round1(Math.max(...hours)) : null,
  }
}

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
 * `until` is what makes a **non-overlapping** baseline possible (#835). The 90d
 * window contains the 7d window, so on 2026-07-29 exactly half the "90-day
 * baseline" — 616 of 1232 merges — *was* the week being compared against it.
 * A reference line that moves with the thing it is measuring cannot tell you
 * the thing moved.
 *
 * @param {{prs: Array<any>, runs: Array<any>, defaultBranch: string, rework: {fixes: Array<any>, commits: Array<any>} | null}} data
 * @param {string} since ISO timestamp
 * @param {string | null} until ISO timestamp, exclusive; open-ended when null
 */
export function filterToWindow(data, since, until = null) {
  const from = Date.parse(since)
  const to = until === null ? Infinity : Date.parse(until)
  return {
    // The bundle knows its own window, so a metric with a narrower fetch than
    // the window can say so rather than quietly reporting partial data (#914).
    windowSince: since,
    defaultBranch: data.defaultBranch,
    prs: data.prs.filter(
      (pr) => pr.mergedAt && Date.parse(pr.mergedAt) >= from && Date.parse(pr.mergedAt) < to,
    ),
    runs: data.runs.filter(
      (run) => Date.parse(run.created_at) >= from && Date.parse(run.created_at) < to,
    ),
    rework: data.rework
      ? {
          fixes: data.rework.fixes.filter((fix) => fix.at >= from && fix.at < to),
          commits: data.rework.commits.filter(
            (commit) => commit.at >= from && commit.at < to,
          ),
        }
      : null,
    // Failing CI steps (#914), carrying the cutoff they were fetched from.
    // `coveredSince` travels with the data because it is the difference between
    // "no steps failed" and "we did not look" — a window wider than the fetch
    // would otherwise report a flattering share over partial data.
    steps: data.steps
      ? {
          coveredSince: data.steps.coveredSince,
          failing: data.steps.failing.filter((step) => step.at >= from && step.at < to),
        }
      : null,
    // Deliberately NOT filtered by the window. An issue opened long before the
    // PR that closed it is the long-latency case time-to-feature exists to find;
    // windowing it away would discard the worst results and flatter the median.
    // The window applies to the *merge*, which is the event being measured.
    issues: data.issues ?? [],
  }
}

/**
 * Work out the **independent baseline** window from the configured lookbacks.
 *
 * Every window here is a lookback from now, so the long one contains the short
 * one and "7d vs the 90d baseline" is partly a comparison of the week with
 * itself. On 2026-07-29 the overlap was total enough to make the baseline
 * useless as a reference: 616 of the 1232 merges in the 90-day window — exactly
 * half — had happened in the 7 days being compared against it. Merge rate that
 * week was 88/day against the 90-day average of 13.7/day, so the "baseline" was
 * dominated by the very regime it was supposed to give perspective on. A
 * baseline that moves with the reading always looks reassuringly close to it.
 *
 * The fix is a span, not a lookback: **the equal-length period immediately
 * before the rate window**. Last week, against this week.
 *
 * ## Why equal-length, and why it changed (#850)
 *
 * The first version cut the rate window out of the long one — 90d minus 7d, an
 * 83-day baseline. Independent, but not *matched*: a 7-day reading against an
 * 83-day average compares a week to a quarter, and the quarter is dominated by
 * whatever regime happened to prevail in it. That is the same units mismatch
 * the green-wait tile had, one level up.
 *
 * Equal length also makes the feedback loop short, which is the point: this
 * estate merged 616 PRs in seven days. A 30- or 90-day reference is not a
 * reference for a codebase moving that fast, it is history. Confirmed before
 * changing it — the last 7 days carry 144 failed CI runs and 199 failing steps
 * estate-wide, ample to classify, and the locally-catchable share reads 66% on
 * 7 days against 62% on 30, so the shorter window costs no comparability.
 *
 * Returns `null` when there is no second window to derive a rate from.
 *
 * @param {number[]} windowDays
 * @returns {{ since: string, until: string, days: number } | null}
 */
export function priorWindow(windowDays, now = Date.now()) {
  const sorted = [...new Set(windowDays)].sort((a, b) => a - b)
  if (sorted.length < 2) return null
  // The rate window is the one the dashboard reads percentages from — the
  // largest window that is not the long-term context window.
  const rate = sorted[sorted.length - 2]
  return {
    // [2×rate ago, rate ago) — the same span, immediately before, sharing no
    // merge with the reading it anchors.
    since: new Date(now - 2 * rate * 864e5).toISOString(),
    until: new Date(now - rate * 864e5).toISOString(),
    days: rate,
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
/**
 * Time-to-feature, stop A: issue opened → the PR that closed it merged (#767).
 *
 * ## Why the clock starts at the issue and stops at the merge
 *
 * Start: `issue.createdAt`. Thinking time is deliberately out of scope — the
 * clock starts when an intention is written down, which is the first moment the
 * tooling can see.
 *
 * Stop: **not** `closedAt`. This estate has twice shipped a "fixed" issue that
 * was not fixed — #275 was diagnosed, closed and shipped on a wrong cause with a
 * green suite throughout, and #726 was auto-closed by `Closes #N` before
 * anything had run against a deployed instance. A metric that stops at closure
 * therefore *improves the more carelessly issues are closed*, rewarding the
 * exact failure it should expose. The merge of the closing PR is the earliest
 * moment supported by evidence rather than by someone's belief.
 *
 * Stop B — first successful deploy after that merge — is Phase 2, and needs the
 * template→instance hop to become machine-readable first.
 *
 * ## What `unlinked` counts, and why it is not zero
 *
 * A merged PR with no resolvable closing issue is counted, not dropped. Two
 * different things produce one: a PR that legitimately closes nothing, and a PR
 * whose closing reference is malformed. The latter is already on this project's
 * scoreboard — `closes tabsii-crm#100` is repo-qualified but owner-less, which
 * GitHub does not recognise, and it left a shipped issue open for two days
 * looking like unstarted work. Folding those into the denominator would report
 * a sample as if it were the whole, so they are reported alongside it instead.
 *
 * @param {Array<Record<string, any>>} mergedPrs PRs with `mergedAt` and `closingIssuesReferences`
 * @param {Map<string, string>} issueOpenedAt keyed `owner/repo#number` → ISO createdAt
 */
export function timeToFeature(mergedPrs, issueOpenedAt, deploys = []) {
  const hours = []
  const runningHours = []
  const deployGapHours = []
  let linked = 0
  let unresolved = 0
  let awaitingDeploy = 0
  for (const pr of mergedPrs) {
    const refs = pr.closingIssuesReferences ?? []
    for (const ref of refs) {
      const owner = ref.repository?.owner?.login
      const name = ref.repository?.name
      const key = owner && name ? `${owner}/${name}#${ref.number}` : null
      const openedAt = key ? issueOpenedAt.get(key) : undefined
      if (!openedAt) {
        // Referenced an issue we could not resolve — outside the fetched set, or
        // in a repo not collected. Counted, never silently treated as instant.
        unresolved += 1
        continue
      }
      const delta = Date.parse(pr.mergedAt) - Date.parse(openedAt)
      // A closing PR that merged *before* its issue was opened is not a fast
      // feature — it is a mislinked reference. Excluded from the distribution
      // and surfaced as unresolved rather than dragging the median toward zero.
      if (!Number.isFinite(delta) || delta < 0) {
        unresolved += 1
        continue
      }
      hours.push(delta / 3_600_000)
      linked += 1

      // Stop B — running, not merely merged (#767).
      const ranAt = firstDeployAfter(deploys, pr.mergedAt)
      if (ranAt === null) {
        // No successful deploy yet, or the deploy fell outside the fetched
        // window. Either way it is *not* zero and not "instant" — the issue is
        // merged and not yet known to be running.
        awaitingDeploy += 1
        continue
      }
      runningHours.push((ranAt - Date.parse(openedAt)) / 3_600_000)
      deployGapHours.push((ranAt - Date.parse(pr.mergedAt)) / 3_600_000)
    }
  }
  const withNoClosingRef = mergedPrs.filter(
    (pr) => (pr.closingIssuesReferences ?? []).length === 0,
  ).length
  return {
    linked,
    unresolved,
    prsWithNoClosingIssue: withNoClosingRef,
    // Coverage is the honesty check: a p50 over 4 of 143 merges is a statement
    // about 4 merges. Reported next to the number so it cannot be read as the
    // estate's feature latency.
    coverage: rate(linked, mergedPrs.length),
    hoursP50: round1(percentile(hours, 50)),
    hoursP90: round1(percentile(hours, 90)),
    hoursMax: hours.length ? round1(Math.max(...hours)) : null,
    // Stop B: issue opened → deployed and running.
    running: {
      measured: runningHours.length,
      awaitingDeploy,
      hoursP50: round1(percentile(runningHours, 50)),
      hoursP90: round1(percentile(runningHours, 90)),
      // B − A: merged, but not yet usable. This is the distribution cost the
      // practices page has only ever been able to describe anecdotally.
      deployGapP50: round1(percentile(deployGapHours, 50)),
      deployGapP90: round1(percentile(deployGapHours, 90)),
    },
  }
}

/**
 * Successful deploy runs on the integration branch, oldest first (#767).
 *
 * @param {Array<Record<string, any>>} runs
 * @param {string} branch
 * @param {string} workflow
 */
export function successfulDeploys(runs, branch, workflow = DEPLOY_WORKFLOW) {
  return runs
    .filter(
      (run) =>
        run.name === workflow &&
        run.head_branch === branch &&
        run.event === 'push' &&
        run.conclusion === 'success',
    )
    .map((run) => ({
      // Two different instants, and conflating them makes deploys look free.
      // `startedAt` decides *which* merges a run contains; `finishedAt` is when
      // the code is actually running. A push-triggered run starts within
      // seconds of the merge, so measuring the gap from `startedAt` reports ~0
      // for every deploy no matter how long it took.
      startedAt: Date.parse(String(run.created_at)),
      finishedAt: Date.parse(String(run.updated_at ?? run.created_at)),
    }))
    .filter((d) => Number.isFinite(d.startedAt) && Number.isFinite(d.finishedAt))
    .sort((a, b) => a.startedAt - b.startedAt)
}

/**
 * When the first deploy that *necessarily contains* `mergedAt` finished.
 *
 * The rule is `created_at >= mergedAt`, and it is exact rather than a heuristic:
 * a push-triggered run builds the branch tip at the moment it was created, so a
 * run created after a merge necessarily includes that merge. A run created
 * *before* it cannot. No commit-sha matching is needed, and none would be more
 * correct — sha matching would additionally report `null` whenever deploys
 * coalesce, which is common here and would look like "never shipped".
 *
 * Returns `null` when no successful deploy has happened yet, which is a
 * different claim from "shipped instantly".
 *
 * Matches on `startedAt` and returns `finishedAt` — the code is running when the
 * deploy *completes*, not when it is triggered.
 *
 * @param {Array<{startedAt: number, finishedAt: number}>} deploys ascending by startedAt
 * @param {string} mergedAt
 */
export function firstDeployAfter(deploys, mergedAt) {
  const from = Date.parse(mergedAt)
  if (!Number.isFinite(from)) return null
  for (const d of deploys) if (d.startedAt >= from) return d.finishedAt
  return null
}

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
 * Check kinds a **local** gate could catch, and the ones it could not (#914).
 *
 * This is H4's primary outcome metric — the share of failing CI steps that a
 * deterministic, offline check on a developer's machine would have caught first.
 * Until #914 it existed only as a hand-reconstruction: the collector fetched
 * `/actions/runs` and never jobs or steps, so the 66% baseline in
 * `docs/practices/experiments/H4-shift-left-gates.md` was classified by hand and
 * the classification was never written down. This is that classification, in
 * code, where it can be re-run and disagreed with.
 *
 * ## Why this does NOT reuse `gate-coverage.sh`'s `EXCLUDED_KINDS`
 *
 * That list exists and it is tempting, and reusing it would be wrong. The two
 * answer different questions:
 *
 * - `EXCLUDED_KINDS` — kinds deliberately absent from `verify.sh`, the pre-push
 *   gate, each with a reason.
 * - **locally catchable** — kinds a local check *could* catch, whether or not one
 *   runs today.
 *
 * `ownership` is the case that proves they differ: it is in `EXCLUDED_KINDS`
 * because a **`commit-msg` hook** covers it rather than `verify.sh` — and H4
 * names its eleven CI failures as a headline cost, i.e. as catchable. Deriving
 * catchability from the exclusion list would have silently dropped those, plus
 * `build`, `gitleaks` (#897 — excluded on a rationale that turned out to be
 * false) and `pytest`. **The gap between "could be caught locally" and "is
 * caught locally" is the quantity H4 exists to measure**, so collapsing the two
 * would leave the metric unable to fail.
 *
 * ## Grounded in real step names, not invented ones
 *
 * Every pattern below was derived from the 25 distinct failing step names the
 * estate actually produced over the 7 days to 2026-07-30 (154 failing steps
 * across 12 repos). Unnamed steps arrive from the API as `Run <command>`, so
 * both the human `name:` form and the raw command form are matched.
 *
 * Order matters: `Build and deploy plugin frontends` is a deploy, not a build,
 * and `Sync and audit core-v<version>` is a release step, not a dependency
 * audit. The specific patterns come first for exactly this reason.
 */
const STEP_KINDS = [
  // --- not locally catchable: needs cloud credentials, a live environment, or
  // state that does not exist until merge/release time.
  { kind: 'deploy', catchable: false, match: /deploy|terraform (apply|init)|apply the .* schema/ },
  { kind: 'publish', catchable: false, match: /publish|sync and audit core-v|tag core version/ },
  // Not offline, and not deterministic over time: a newly-published advisory
  // reddens CI with no code change, so a developer running it an hour earlier
  // would legitimately have seen green.
  { kind: 'dependency-audit', catchable: false, match: /dependency audit|pnpm audit|pip-audit/ },
  // The squash-merge subject does not exist until the merge, so nothing local
  // can check it. This is the one exclusion that is a fact rather than a choice.
  { kind: 'release-subject', catchable: false, match: /release-subject/ },
  { kind: 'setup', catchable: false, match: /^(set up|install) |^run actions\// },
  // Deterministic and offline, but **not seconds** — a full Next build is minutes,
  // which is why `local-gates.md` excludes it by name. H4's criterion is all three
  // ("deterministic, offline checks that reproduce locally in seconds"), so this
  // fails it on the third. Before `build`, so it wins over the generic test below.
  { kind: 'build', catchable: false, match: /build/ },

  // --- locally catchable. Specific guards before the generic kinds they contain.
  { kind: 'ownership', catchable: true, match: /ownership/ },
  { kind: 'corpus-guard', catchable: true, match: /corpus is append-only|practices-monotonic/ },
  { kind: 'destructive-plan', catchable: true, match: /destructive-plan/ },
  { kind: 'plugin-terraform', catchable: true, match: /plugin[- ]terraform/ },
  { kind: 'plugin-collisions', catchable: true, match: /plugin[- ]collisions?/ },
  // Needs a real Postgres, which is why it looks un-local — but the lane runs in
  // ~3s against docker and is opt-in via TABSII_TEST_PG_DSN.
  { kind: 'rls-test', catchable: true, match: /rls/ },
  { kind: 'format', catchable: true, match: /format/ },
  { kind: 'typecheck', catchable: true, match: /type ?check|pyright|tsc\b/ },
  { kind: 'lint', catchable: true, match: /lint|ruff check|eslint/ },
  { kind: 'sast', catchable: true, match: /sast|bandit/ },
  { kind: 'gitleaks', catchable: true, match: /gitleaks/ },
  { kind: 'terraform-fmt', catchable: true, match: /terraform.*fmt/ },
  { kind: 'terraform-validate', catchable: true, match: /validate modules|terraform validate/ },
  { kind: 'test', catchable: true, match: /test|pytest|vitest/ },
]

/**
 * Classify one failing CI step.
 *
 * Returns `catchable: null` for a step no pattern matches, rather than guessing.
 * An unclassified step is counted and reported but contributes to **neither**
 * side of the share — the alternative is a silent default, and a default of
 * `false` would let the headline improve every time CI grew a step this file has
 * never seen. `unclassified > 0` on the dashboard is a prompt to extend the list.
 *
 * @param {string} stepName as reported by the jobs API
 * @returns {{ kind: string, catchable: boolean | null }}
 */
export function classifyFailingStep(stepName) {
  const name = String(stepName ?? '')
    .toLowerCase()
    .trim()
  for (const entry of STEP_KINDS) {
    if (entry.match.test(name)) return { kind: entry.kind, catchable: entry.catchable }
  }
  return { kind: 'unclassified', catchable: null }
}

/**
 * H4's primary metric: the locally-catchable share of failing CI steps (#914).
 *
 * `share` is the percentage of **classified** steps that a local gate could have
 * caught. Unclassified steps sit outside the ratio and are reported alongside it
 * so the denominator is always visible — a share quoted without its
 * `unclassified` count is not auditable.
 *
 * `byKind` exists so the headline can be argued with. A single percentage that
 * moved is not evidence about a gate; "format fell from 19 to 2" is.
 *
 * @param {Array<{name: string}>} steps failing steps, in any order
 */
export function summariseGates(steps) {
  /** @type {Record<string, number>} */
  const byKind = {}
  let catchable = 0
  let notCatchable = 0
  let unclassified = 0
  for (const step of steps) {
    const { kind, catchable: isCatchable } = classifyFailingStep(step.name)
    byKind[kind] = (byKind[kind] ?? 0) + 1
    if (isCatchable === null) unclassified += 1
    else if (isCatchable) catchable += 1
    else notCatchable += 1
  }
  return {
    failingSteps: steps.length,
    locallyCatchable: catchable,
    notLocallyCatchable: notCatchable,
    unclassified,
    share: rate(catchable, catchable + notCatchable),
    byKind,
  }
}

/**
 * {@link summariseGates} for one window, or an explicit `unmeasured` when the
 * window predates the fetch (#914).
 *
 * The distinction this preserves: **"nothing failed" and "we did not look" are
 * different claims, and only one of them is good news.** The same rule
 * {@link percentile} follows for an empty set.
 *
 * @param {{coveredSince: string, failing: Array<{name: string, at: number}>} | null} steps
 * @param {string | undefined} windowSince
 */
export function gatesForWindow(steps, windowSince) {
  if (!steps) return { error: 'unmeasured', reason: 'no jobs fetched' }
  if (windowSince && Date.parse(windowSince) < Date.parse(steps.coveredSince)) {
    return {
      error: 'unmeasured',
      reason: `window starts ${windowSince} but jobs were fetched only from ${steps.coveredSince}`,
      coveredSince: steps.coveredSince,
    }
  }
  return summariseGates(steps.failing)
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
export function summariseRepo(repo, data, issueOpenedAt = new Map(), templateClosingIssues = new Map()) {
  const { prs, runs, defaultBranch, rework, steps, windowSince } = data
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
    // How long from wanting a capability to having it (#767). Stop A only:
    // issue opened → closing PR merged. Stop B (running in an instance) needs
    // the template→instance hop to be machine-readable first.
    timeToFeature: {
      ...timeToFeature(merged, issueOpenedAt, successfulDeploys(runs, defaultBranch)),
      // Template issue opened -> running here. Empty for the template itself and
      // for any repo that takes no core upgrades.
      crossRepo: crossRepoTimeToFeature(
        merged,
        templateClosingIssues,
        issueOpenedAt,
        successfulDeploys(runs, defaultBranch),
      ),
    },
    // H4's primary metric (#914). `unmeasured` rather than a number when the
    // window reaches back further than the jobs fetch: the per-run jobs call is
    // O(failed runs), so it is capped, and a 90-day window over a 14-day fetch
    // would report a share of the fortnight as if it were the quarter.
    gates: gatesForWindow(steps, windowSince),
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
 * The question this answers is the one that decides where effort goes: **how
 * much of what we do is building a capability at all?**
 *
 * ## Why the headline changed (#768)
 *
 * This used to lead with `productFeatureShare` — delivery merges in `tabsii-*`
 * as a share of everything — on the framing that "Biffo is the machine, Tabsii
 * is the product". **The north star set on 2026-07-27 inverts that: Biffo is
 * the fundable product and Tabsii is the proving ground that exercises it.**
 *
 * Under the old label the same 152 merges read **5.9%**, and it was quoted as
 * "we are barely shipping features". Re-cut on the Biffo/Tabsii axis the answer
 * is **35.5% capability** — Biffo 29.6%, Tabsii 5.9%. Same day, same merges,
 * **6× difference**, purely from which repo family is called "the product". The
 * arithmetic was never wrong; the denominator was the wrong product.
 *
 * That number had already been identified as measuring the wrong thing the day
 * before and stayed on the dashboard, so it was read as a headline again. The
 * old figure survives as `tabsiiCapabilityShare`, which is what it always was —
 * a legitimate number about the proving ground.
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
      capabilityShare: null,
      capabilityBySide: {},
      tabsiiCapabilityShare: null,
      contentionHours: null,
      bySide: {},
      gates: aggregateGates(repos),
      note: 'merges are a proxy for effort, not a measure of time',
    }
  }

  const sum = (fn) => usable.reduce((total, r) => total + fn(r), 0)
  const merges = sum((r) => r.workMix.merges)
  const platform = sum((r) => r.workMix.sideCounts.platform)
  const product = sum((r) => r.workMix.sideCounts.product)
  const toil = sum((r) => r.workMix.counts.toil)
  const rework = sum((r) => r.workMix.counts.rework)
  // Capability = a merge that built something, wherever it landed. Split by
  // family, because "which product" is the question the old headline got wrong.
  const capability = sum((r) => r.workMix.counts.delivery)
  const tabsiiCapability = sum((r) => r.workMix.productDelivery)
  const biffoCapability = capability - tabsiiCapability

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
    // The headline: capability built anywhere, as a share of all merges.
    capabilityShare: rate(capability, merges),
    capabilityBySide: {
      // Biffo is the fundable product; Tabsii is the proving ground.
      platform: { merges: biffoCapability, share: rate(biffoCapability, merges) },
      product: { merges: tabsiiCapability, share: rate(tabsiiCapability, merges) },
    },
    // Formerly `productFeatureShare`, renamed rather than dropped: it is a real
    // number about the proving ground, and only its label was wrong (#768).
    tabsiiCapabilityShare: rate(tabsiiCapability, merges),
    contentionHours: round1(sum((r) => r.contention?.greenButUnmergedHours ?? 0)),
    bySide,
    // H4's headline, estate-wide (#914). Aggregated over its own set of repos,
    // not `usable`: a repo can fail CI steps in a window it merged nothing in,
    // and requiring a workMix would drop exactly those.
    gates: aggregateGates(repos),
    note: 'merges are a proxy for effort, not a measure of time',
  }
}

/**
 * Estate-wide roll-up of the per-repo gate metric (#914).
 *
 * Sums the raw counts and recomputes the share from them rather than averaging
 * the per-repo percentages: a repo with one failing step would otherwise weigh
 * the same as one with eighty. `repos` counts how many contributed, so a share
 * computed over two repos cannot be mistaken for one covering the estate.
 *
 * @param {Record<string, any>} repos
 */
export function aggregateGates(repos) {
  const measured = Object.values(repos).filter((r) => r?.gates && !r.gates.error)
  if (measured.length === 0) {
    return { repos: 0, failingSteps: 0, locallyCatchable: 0, unclassified: 0, share: null, byKind: {} }
  }
  /** @type {Record<string, number>} */
  const byKind = {}
  let failingSteps = 0
  let locallyCatchable = 0
  let notLocallyCatchable = 0
  let unclassified = 0
  for (const repo of measured) {
    failingSteps += repo.gates.failingSteps
    locallyCatchable += repo.gates.locallyCatchable
    notLocallyCatchable += repo.gates.notLocallyCatchable
    unclassified += repo.gates.unclassified
    for (const [kind, n] of Object.entries(repo.gates.byKind)) {
      byKind[kind] = (byKind[kind] ?? 0) + /** @type {number} */ (n)
    }
  }
  return {
    repos: measured.length,
    failingSteps,
    locallyCatchable,
    notLocallyCatchable,
    unclassified,
    share: rate(locallyCatchable, locallyCatchable + notLocallyCatchable),
    byKind,
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
    // closingIssuesReferences is what makes time-to-feature (#767) cost nothing
    // extra: it rides along on a fetch that already happens. The alternative —
    // one timeline API call per closed issue — is O(issues) requests for the
    // same answer.
    // `body` carries the core-upgrade marker (#767). Same request, one more field.
    'number,title,createdAt,mergedAt,headRefName,baseRefName,closingIssuesReferences,body',
  ])
  return prs.filter((pr) => pr.mergedAt >= since)
}

/**
 * Every closed issue's `createdAt`, in one request per repo (#767).
 *
 * Deliberately not filtered by the window: an issue opened months before the PR
 * that closed it is exactly the long-latency case this metric exists to find, so
 * filtering by open date would systematically discard the worst results and make
 * the median look good. The cap is the API's, and an issue beyond it resolves to
 * `unresolved` rather than being counted as fast.
 *
 * @param {string} slug
 * @returns {Array<{number: number, createdAt: string}>}
 */
function fetchClosedIssues(slug) {
  return gh(['issue', 'list', '-R', slug, '--state', 'closed', '--limit', '1000', '--json', 'number,createdAt'])
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

/**
 * Every failing step of every failing run in the window (#914).
 *
 * This is the only metric here that costs a request **per run**: there is no bulk
 * endpoint for job steps, so it is O(failed runs). That is why the caller caps
 * the lookback rather than reusing the widest window — 90 days of failed runs
 * across the estate is several thousand requests for a metric both experiments
 * define on 7 days.
 *
 * Timestamped by the *run*, not the job: the window is about when the failure was
 * discovered, and a job's own timing is an artefact of runner scheduling.
 *
 * @param {string} slug
 * @param {Array<Record<string, any>>} runs already-fetched runs for this repo
 * @param {string} since ISO cutoff — runs older than this are not walked
 * @returns {{coveredSince: string, failing: Array<{name: string, at: number}>}}
 */
function fetchFailingSteps(slug, runs, since) {
  const failed = runs.filter(
    (run) => FAILING_CONCLUSIONS.has(run.conclusion) && run.created_at >= since,
  )
  /** @type {Array<{name: string, at: number}>} */
  const failing = []
  for (const run of failed) {
    const at = Date.parse(run.created_at)
    let body
    try {
      body = gh(['api', `repos/${slug}/actions/runs/${run.id}/jobs`])
    } catch {
      // A single unreadable run must not cost the whole repo its metric — the
      // jobs of a run GitHub has expired are gone for good, and refusing to
      // measure the other 150 steps because of one would be the fail-closed
      // mirror of the fail-open shape this scoreboard keeps finding.
      continue
    }
    for (const job of body.jobs ?? []) {
      if (job.conclusion !== 'failure') continue
      for (const step of job.steps ?? []) {
        if (step.conclusion !== 'failure') continue
        failing.push({ name: step.name, at })
      }
    }
  }
  return { coveredSince: since, failing }
}

/**
 * Strip a merge subject down to the *change* it carries (#918).
 *
 * `chore(shared): sync template-shared files (#30)` and `… (#19)` in another repo
 * are the same upstream action arriving twice. The PR number is what makes them
 * look distinct, so it goes; case and whitespace follow for the same reason.
 *
 * @param {string} subject
 */
export function normaliseSubject(subject) {
  return String(subject ?? '')
    .replace(/\s*\(#\d+\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * **Mechanism amplification**: one upstream action multiplied across the estate
 * (#918).
 *
 * ## The measurement this exists to make possible
 *
 * On 2026-07-29, **81 of 226 merges — 35% of everything that landed** — were
 * `chore(shared): sync template-shared files`: roughly seven rounds across twelve
 * repos, six of the seven touching `scripts/verify.sh`. One gate being iterated
 * upstream and redistributed to the whole estate after *every* iteration instead
 * of once when it settled.
 *
 * Every existing metric reported that day as behaviour: toil 57.4% against 32%
 * recorded, the platform/product split inverting to 54.5% product, small-repo
 * repush rates of 66-77%. **None of them could show the cause**, because they are
 * all shares and rates — and amplification is invisible to a share. It looks
 * exactly like a busy day.
 *
 * ## `avoidableMerges` is the number, and why it is that number
 *
 * A change that must reach twelve repos costs twelve merges; that is the
 * mechanism working. What is avoidable is the *rounds* — distributing seven times
 * instead of once. So `avoidableMerges = merges - repos`: the floor is one round,
 * and everything above it is a batching decision.
 *
 * It is deliberately not `merges`, which would indict distribution itself, nor
 * `rounds`, which ignores how wide each round was.
 *
 * @param {Record<string, Array<{subject: string}>>} commitsByRepo repo slug → commits
 * @param {number} minRepos ignore a subject that reached fewer repos than this
 */
export function summariseAmplification(commitsByRepo, minRepos = 3) {
  /** @type {Map<string, {subject: string, repos: Set<string>, merges: number}>} */
  const groups = new Map()
  let totalMerges = 0
  for (const [repo, commits] of Object.entries(commitsByRepo)) {
    for (const commit of commits ?? []) {
      totalMerges += 1
      const key = normaliseSubject(commit.subject)
      if (!key) continue
      const group = groups.get(key) ?? { subject: key, repos: new Set(), merges: 0 }
      group.repos.add(repo)
      group.merges += 1
      groups.set(key, group)
    }
  }

  const amplified = [...groups.values()]
    .filter((g) => g.repos.size >= minRepos && g.merges > g.repos.size)
    .map((g) => ({
      subject: g.subject,
      repos: g.repos.size,
      merges: g.merges,
      // Rounds of distribution: how many times this reached the average repo.
      rounds: round1(g.merges / g.repos.size),
      avoidableMerges: g.merges - g.repos.size,
    }))
    .sort((a, b) => b.avoidableMerges - a.avoidableMerges)

  const avoidableMerges = amplified.reduce((total, g) => total + g.avoidableMerges, 0)
  return {
    totalMerges,
    avoidableMerges,
    // The headline: what share of everything that landed did not need to.
    avoidableShare: rate(avoidableMerges, totalMerges),
    minRepos,
    top: amplified.slice(0, 10),
  }
}

/**
 * Would this snapshot contain any data at all?
 *
 * Every metric here degrades gracefully on purpose: an unreadable repo becomes
 * `unmeasured` and leaves the aggregates rather than contributing a zero. That is
 * correct for *one* repo and wrong for *all* of them. On 2026-07-30 a cron run
 * whose credential had gone missing 401'd on all fifteen repos and still wrote a
 * well-formed 9.5KB snapshot — `estate.merges: 0`, every repo `unmeasured` —
 * which is indistinguishable at a glance from a quiet day.
 *
 * "Nothing could be measured" is not an observation, it is a broken job. Total
 * failure is therefore fatal, while partial failure stays graceful.
 *
 * @param {number} failed repos whose fetch threw
 * @param {number} attempted repos targeted
 */
export function isTotalFetchFailure(failed, attempted) {
  return attempted > 0 && failed === attempted
}

/**
 * How far back the per-run jobs fetch walks, in days (#914).
 *
 * 14 = the 7-day window H4 and H5 are both defined on, plus the equal-length
 * prior period they are compared against. Wider costs a request per additional
 * failed run for a number no experiment reads; narrower leaves the rate window
 * `unmeasured`.
 */
export const GATE_LOOKBACK_DAYS = 14

function parseArgs(argv) {
  const args = {
    windows: DEFAULT_WINDOWS,
    out: 'docs/practices/data',
    repo: null,
    reposRoot: null,
    gateLookbackDays: GATE_LOOKBACK_DAYS,
  }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--window') args.windows = [Number(argv[++i])]
    else if (argv[i] === '--windows') args.windows = argv[++i].split(',').map(Number)
    else if (argv[i] === '--out') args.out = argv[++i]
    else if (argv[i] === '--repo') args.repo = argv[++i]
    else if (argv[i] === '--repos-root') args.reposRoot = argv[++i]
    else if (argv[i] === '--gate-lookback') args.gateLookbackDays = Number(argv[++i])
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
  const prior = priorWindow(args.windows)
  // The gate metric's lookback is capped separately and **explicitly**, because
  // it alone costs a request per failed run (see fetchFailingSteps).
  //
  // An earlier version derived this as `2 × priorWindow().days`, which was too
  // clever: `priorWindow` calls the *second-largest* window the rate window, so
  // running `--windows 1,7` made the cap 2 days and left the 7-day window — the
  // one both H4 and H5 are defined on — `unmeasured`. The guard reported that
  // honestly rather than hiding it, but a cost cap should not move when an
  // unrelated window list changes. A constant says what it is.
  const gatesSince = new Date(Date.now() - args.gateLookbackDays * 864e5).toISOString()
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
      const issues = fetchClosedIssues(repo.slug)
      const steps = fetchFailingSteps(repo.slug, runs, gatesSince)
      raw[repo.slug] = { prs, runs, defaultBranch, rework, issues, steps }
      process.stderr.write(
        `${prs.length} PRs, ${runs.length} runs, ${issues.length} closed issues, ${steps.failing.length} failing steps\n`,
      )
    } catch (error) {
      // A repo that could not be read is recorded as such and excluded from
      // every aggregate. It is never allowed to contribute a zero.
      failures.push({ repo: repo.slug, error: String(error).split('\n')[0] })
      raw[repo.slug] = null
      process.stderr.write('FAILED\n')
    }
  }

  // Refuse to write a snapshot with nothing in it (see isTotalFetchFailure).
  // Placed before any aggregation so the failure is attributed to the fetch,
  // where it happened, rather than surfacing later as a page full of dashes.
  if (isTotalFetchFailure(failures.length, targets.length)) {
    process.stderr.write(
      `\nFATAL: all ${targets.length} repos failed to fetch — refusing to write an empty snapshot.\n` +
        `The most likely cause is credentials: gh stores its token in the keyring, which cron cannot read.\n` +
        `First failure: ${failures[0]?.error}\n`,
    )
    process.exit(1)
  }

  // One index across every collected repo, not per-repo: an instance PR routinely
  // closes a template issue, and a per-repo map would report every one of those
  // as unresolved — losing exactly the cross-repo distribution cases this metric
  // is most useful for.
  /** @type {Map<string, string>} */
  const issueOpenedAt = new Map()
  for (const repo of targets) {
    for (const issue of raw[repo.slug]?.issues ?? []) {
      issueOpenedAt.set(`${repo.slug}#${issue.number}`, issue.createdAt)
    }
  }

  // Template PR -> the issues it closed, built once. An instance upgrade PR
  // names template PR numbers; this is what turns those into issues, and hence
  // into a start time.
  const templateRepo = REPOS.find((r) => r.role === 'template')
  const templateClosingIssues = indexClosingIssues(
    templateRepo?.slug ?? '',
    raw[templateRepo?.slug ?? '']?.prs ?? [],
  )

  /** @type {Record<string, any>} */
  const windows = {}
  for (const days of args.windows) {
    const since = new Date(Date.now() - days * 864e5).toISOString()
    /** @type {Record<string, any>} */
    const repos = {}
    for (const repo of targets) {
      repos[repo.slug] = raw[repo.slug]
        ? summariseRepo(repo, filterToWindow(raw[repo.slug], since), issueOpenedAt, templateClosingIssues)
        : { error: 'unmeasured' }
    }
    // Amplification is estate-level by nature — it is the *cross-repo* repeat of
    // one subject — so it is computed here from every repo's commits rather than
    // inside summariseRepo, which can only ever see one repo.
    /** @type {Record<string, Array<{subject: string}>>} */
    const commitsByRepo = {}
    for (const repo of targets) {
      const windowed = raw[repo.slug] ? filterToWindow(raw[repo.slug], since) : null
      if (windowed?.rework) commitsByRepo[repo.slug] = windowed.rework.commits
    }
    windows[days] = {
      since,
      repos,
      estate: summariseEstate(repos),
      amplification: summariseAmplification(commitsByRepo),
    }
  }

  // The independent baseline (#835): the long window with the rate window cut
  // out of it, so "vs baseline" compares two disjoint sets of merges. Keyed by
  // name rather than a day count because it is a *span*, not a lookback, and
  // reading it as one would put its start date 83 days ago instead of 90.
  // Computed once, above, because the gate lookback is derived from it too.
  if (prior) {
    /** @type {Record<string, any>} */
    const repos = {}
    for (const repo of targets) {
      repos[repo.slug] = raw[repo.slug]
        ? summariseRepo(
            repo,
            filterToWindow(raw[repo.slug], prior.since, prior.until),
            issueOpenedAt,
            templateClosingIssues,
          )
        : { error: 'unmeasured' }
    }
    windows.prior = { ...prior, repos, estate: summariseEstate(repos) }
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
