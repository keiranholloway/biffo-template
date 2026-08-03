import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTmpDir } from '../test-utils/tmp.js'
import { carriedPrsSection } from '../commands/core-upgrade.js'
// @ts-expect-error -- plain .mjs so the collector runs on bare node from a
// scheduled workflow that installs nothing. Imported here so the logic has one
// home rather than a TypeScript copy that can drift from it — same arrangement
// as destructive-plan.mjs and packaged-root-assets.mjs.
import {
  summariseEstate,
  timeToFeature,
  parseCarriedPrs,
  indexClosingIssues,
  crossRepoTimeToFeature,
  isUpgradePr,
  successfulDeploys,
  firstDeployAfter,
  parseDiffHunks,
  cycleTimeMinutes,
  detectFlakes,
  indexRunsByBranch,
  integrationHealth,
  isRunnerKill,
  mergeContention,
  parseGitLog,
  percentile,
  prChurn,
  rate,
  runsForPr,
  summariseRepo,
  summariseRework,
  summariseWorkMix,
  classifyMergeSide,
  classifyWork,
  filterToWindow,
  priorWindow,
  classifyFailingStep,
  classificationBlindness,
  summariseGates,
  gatesForWindow,
  aggregateGates,
  isTotalFetchFailure,
  diagnoseTotalFetchFailure,
  normaliseSubject,
  summariseAmplification,
  reviewCoverage,
} from '../../../scripts/practices-metrics.mjs'
// @ts-expect-error -- plain .mjs, same arrangement as above.
import {
  grade,
  fmt,
  renderDashboard,
  renderSessions,
  CAPABILITY_FLOOR,
  CAPABILITY_CRITICAL,
  GREEN_WAIT_WARN_MINUTES,
  definitionBreak,
  renderAudits,
} from '../../../scripts/practices-dashboard.mjs'
// @ts-expect-error -- plain .mjs, same arrangement as above.
import {
  buildEntry,
  daysSince,
  nudge,
  summariseSessions,
} from '../../../scripts/practices-session.mjs'

/** A workflow run as `GET /repos/{o}/{r}/actions/runs` returns it. */
const run = (
  branch: string,
  sha: string,
  conclusion: string | null,
  createdAt: string,
  extra: Record<string, unknown> = {},
) => ({
  head_branch: branch,
  head_sha: sha,
  conclusion,
  created_at: createdAt,
  updated_at: createdAt,
  name: 'CI',
  event: 'pull_request',
  ...extra,
})

const pr = (headRefName: string, createdAt: string, mergedAt: string | null, number = 1) => ({
  number,
  title: 'feat: something',
  headRefName,
  baseRefName: 'dev',
  createdAt,
  mergedAt,
})

describe('percentile', () => {
  it('returns the nearest-rank value', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3)
    expect(percentile([1, 2, 3, 4, 5], 90)).toBe(5)
    expect(percentile([10], 50)).toBe(10)
  })

  it('does not mutate the caller’s array', () => {
    const values = [3, 1, 2]
    percentile(values, 50)
    expect(values).toEqual([3, 1, 2])
  })

  /**
   * The invariant this whole file exists to protect. An empty sample is not a
   * sample of zeroes, and a collector that says otherwise reproduces exactly the
   * fail-open shape that dominates the practices corpus.
   */
  it('returns null for an empty set rather than 0', () => {
    expect(percentile([], 50)).toBeNull()
  })
})

describe('rate', () => {
  it('computes a percentage to one decimal place', () => {
    expect(rate(1, 3)).toBe(33.3)
    expect(rate(3, 4)).toBe(75)
  })

  it('returns null when there is nothing to divide, never 0', () => {
    expect(rate(0, 0)).toBeNull()
  })
})

describe('runsForPr', () => {
  /**
   * Branch names repeat in this project (`fix/…` is reused constantly), so the
   * PR's own lifetime is the only thing stopping one PR inheriting another's
   * runs and reporting churn it never caused.
   */
  it('excludes runs from an earlier PR that reused the branch name', () => {
    const runsByBranch = indexRunsByBranch([
      run('fix/thing', 'old', 'failure', '2026-07-01T10:00:00Z'),
      run('fix/thing', 'new', 'success', '2026-07-20T10:00:00Z'),
    ])
    const matched = runsForPr(
      pr('fix/thing', '2026-07-20T09:00:00Z', '2026-07-20T11:00:00Z'),
      runsByBranch,
    )
    expect(matched).toHaveLength(1)
    expect(matched[0].head_sha).toBe('new')
  })

  it('includes a run still finishing shortly after the merge', () => {
    const runsByBranch = indexRunsByBranch([run('feat/x', 'a', 'success', '2026-07-20T11:30:00Z')])
    const matched = runsForPr(
      pr('feat/x', '2026-07-20T09:00:00Z', '2026-07-20T11:00:00Z'),
      runsByBranch,
    )
    expect(matched).toHaveLength(1)
  })
})

describe('prChurn', () => {
  /**
   * The case that forced revisions and CI failure apart into two metrics.
   * biffo-template#691 pushed three SHAs and every run on all three was green —
   * a single "first-pass green" metric scores that 100% while hiding three
   * revisions and 29 minutes. Gates rejecting work and humans guessing are
   * different problems.
   */
  it('counts revisions on a PR whose every CI run was green', () => {
    const runsByBranch = indexRunsByBranch([
      run('fix/cdn', 'f6d1231', 'success', '2026-07-27T11:04:40Z'),
      run('fix/cdn', '6ac67b6', 'success', '2026-07-27T11:19:29Z'),
      run('fix/cdn', 'e7f18ec', 'success', '2026-07-27T11:30:58Z'),
    ])
    const churn = prChurn(
      pr('fix/cdn', '2026-07-27T11:04:37Z', '2026-07-27T11:33:29Z'),
      runsByBranch,
    )
    expect(churn.revisions).toBe(2)
    expect(churn.ciFailed).toBe(false)
  })

  it('reports zero revisions for a branch that landed as first pushed', () => {
    const runsByBranch = indexRunsByBranch([
      run('feat/clean', 'aaa', 'success', '2026-07-20T10:00:00Z'),
    ])
    const churn = prChurn(
      pr('feat/clean', '2026-07-20T09:59:00Z', '2026-07-20T10:05:00Z'),
      runsByBranch,
    )
    expect(churn.revisions).toBe(0)
    expect(churn.ciFailed).toBe(false)
  })

  it('flags a PR a gate rejected at least once', () => {
    const runsByBranch = indexRunsByBranch([
      run('feat/y', 'aaa', 'failure', '2026-07-20T10:00:00Z'),
      run('feat/y', 'bbb', 'success', '2026-07-20T10:30:00Z'),
    ])
    const churn = prChurn(
      pr('feat/y', '2026-07-20T09:00:00Z', '2026-07-20T11:00:00Z'),
      runsByBranch,
    )
    expect(churn.ciFailed).toBe(true)
    expect(churn.failedRuns).toBe(1)
    expect(churn.revisions).toBe(1)
  })

  /**
   * A cancelled run is almost always a newer push superseding an in-flight one.
   * Counting it as a failure would inflate the rate every time someone pushes
   * twice quickly — which is precisely the behaviour the revisions metric is
   * already measuring properly.
   */
  it('does not count a superseded (cancelled) run as a gate failure', () => {
    const runsByBranch = indexRunsByBranch([
      run('feat/z', 'aaa', 'cancelled', '2026-07-20T10:00:00Z'),
      run('feat/z', 'bbb', 'success', '2026-07-20T10:10:00Z'),
    ])
    const churn = prChurn(
      pr('feat/z', '2026-07-20T09:00:00Z', '2026-07-20T11:00:00Z'),
      runsByBranch,
    )
    expect(churn.ciFailed).toBe(false)
    expect(churn.cancelledRuns).toBe(1)
  })

  it('reports null — not a clean score — when no runs were found', () => {
    const churn = prChurn(
      pr('feat/none', '2026-07-20T09:00:00Z', '2026-07-20T11:00:00Z'),
      new Map(),
    )
    expect(churn.revisions).toBeNull()
    expect(churn.ciFailed).toBeNull()
  })
})

describe('cycleTimeMinutes', () => {
  it('measures open to merge', () => {
    expect(cycleTimeMinutes(pr('a', '2026-07-27T11:04:00Z', '2026-07-27T11:33:00Z'))).toBe(29)
  })

  it('returns null for an unmerged PR', () => {
    expect(cycleTimeMinutes(pr('a', '2026-07-27T11:04:00Z', null))).toBeNull()
  })
})

describe('detectFlakes', () => {
  it('finds a workflow that reached two verdicts on one commit', () => {
    const flakes = detectFlakes([
      run('feat/x', 'aaa', 'failure', '2026-07-20T10:00:00Z'),
      run('feat/x', 'aaa', 'success', '2026-07-20T10:20:00Z'),
    ])
    expect(flakes.pairs).toBe(1)
    expect(flakes.shas).toEqual(['aaa'])
  })

  it('does not flag differing verdicts across different commits', () => {
    const flakes = detectFlakes([
      run('feat/x', 'aaa', 'failure', '2026-07-20T10:00:00Z'),
      run('feat/x', 'bbb', 'success', '2026-07-20T10:20:00Z'),
    ])
    expect(flakes.pairs).toBe(0)
  })

  it('ignores skipped runs, which are not a verdict', () => {
    const flakes = detectFlakes([
      run('feat/x', 'aaa', 'skipped', '2026-07-20T10:00:00Z'),
      run('feat/x', 'aaa', 'success', '2026-07-20T10:20:00Z'),
    ])
    expect(flakes.pairs).toBe(0)
  })
})

describe('isRunnerKill', () => {
  const job = (conclusion: string, steps: Array<string | null>) => ({
    conclusion,
    steps: steps.map((c, i) => ({ name: `step ${i}`, conclusion: c })),
  })

  /**
   * Ground truth, `tabsii-com/tabsii-platform` run 30573503264 on 2026-07-30:
   * "Deploy to dev" succeeded through thirteen steps, froze on "Package and
   * deploy Lambda", and left six more pending. GitHub concluded the run
   * `failure`; the board read it as a broken integration branch.
   */
  it('calls a job that froze mid-step a runner kill', () => {
    expect(
      isRunnerKill([job('failure', ['success', 'success', 'success', null, null, null])]),
    ).toBe(true)
  })

  /**
   * The second kill signature, missed by the first cut (#982) and found while
   * diagnosing biffo-platform's red branch. Its run 30450084952 died 64 seconds
   * in with "Type check" and "Lint" `cancelled` and every later step `skipped`
   * — no failing step anywhere, yet the run concluded `failure`.
   *
   * This is not laundering a cancellation: a real cancellation, whether by hand
   * or by `cancel-in-progress`, concludes the *run* `cancelled`, which
   * FAILING_CONCLUSIONS already excludes before this function is reached.
   */
  it('calls a job stopped mid-step with cancelled steps a runner kill', () => {
    expect(isRunnerKill([job('failure', ['success', 'success', 'cancelled', 'skipped'])])).toBe(
      true,
    )
  })

  /**
   * `skipped` alone is not evidence of anything — it is what every step after a
   * verdict reads. Without a step that actually stopped short, there is no kill
   * to infer, and guessing would make the metric unable to refute.
   */
  it('does not call a run with only skipped steps a kill', () => {
    expect(isRunnerKill([job('failure', ['success', 'skipped', 'skipped'])])).toBe(false)
  })

  /**
   * The other half of the estate's red: a step genuinely rejected the change.
   * biffo-template run 30555489992 failed on "Sync and audit core-v<version>",
   * which is a real defect and must stay counted. biffo-platform's terraform
   * failures are the same shape and must survive this change.
   */
  it('does not launder a real failing step', () => {
    expect(isRunnerKill([job('failure', ['success', 'failure'])])).toBe(false)
  })

  /**
   * A run where one job died and another genuinely failed is a real failure.
   * Erring the other way would let any concurrent runner death hide a defect.
   */
  it('treats a mixed run as a real failure', () => {
    expect(isRunnerKill([job('failure', ['success', null]), job('failure', ['failure'])])).toBe(
      false,
    )
  })

  /**
   * No steps recorded at all is unexplained, not proven innocent. It stays a
   * failure — the conservative direction for a metric whose job is to be able
   * to refute an experiment its author would rather confirm.
   */
  it('does not classify a failure with no steps recorded', () => {
    expect(isRunnerKill([job('failure', [])])).toBe(false)
    expect(isRunnerKill([])).toBe(false)
  })

  it('ignores steps of jobs that did not fail', () => {
    expect(isRunnerKill([job('success', ['success', null])])).toBe(false)
  })
})

describe('integrationHealth', () => {
  /**
   * The reason this exists (#982). tabsii-platform joined H3's treatment arm
   * reading 8 failures and 111.7 red minutes — every one a dead runner. H3
   * refutes above 2 failures or 60 red minutes, so without this the experiment
   * gets refuted by something it never touched.
   */
  it('does not count a dead runner as an integration failure', () => {
    const runs = [
      run('dev', 'aaa', 'failure', '2026-07-20T10:00:00Z', { event: 'push', id: 1 }),
      run('dev', 'bbb', 'success', '2026-07-20T10:30:00Z', { event: 'push', id: 2 }),
    ]
    const health = integrationHealth(runs, 'dev', 240, {
      ids: new Set([1]),
      coveredSince: '2026-07-01T00:00:00Z',
    })
    expect(health.failures).toBe(0)
    expect(health.runnerKills).toBe(1)
    // A kill must not open a red span either, or the minutes survive the fix.
    expect(health.redMinutes).toBe(0)
    expect(health.unresolvedFailures).toBe(0)
  })

  /**
   * The jobs fetch is capped, so a 90-day window outruns it. Those failures are
   * reported separately and left counted — an unclassified failure is not a
   * proven kill, and assuming otherwise would make the correction itself a
   * fail-open.
   */
  it('leaves a failure outside the classified window counted, and says so', () => {
    const health = integrationHealth(
      [run('dev', 'aaa', 'failure', '2026-07-01T10:00:00Z', { event: 'push', id: 1 })],
      'dev',
      240,
      { ids: new Set([1]), coveredSince: '2026-07-15T00:00:00Z' },
    )
    expect(health.failures).toBe(1)
    expect(health.runnerKills).toBe(0)
    expect(health.failuresUnclassified).toBe(1)
  })

  /** "Not asked" must stay distinguishable from "asked, found none". */
  it('reports null rather than zero when no classification was supplied', () => {
    const health = integrationHealth(
      [run('dev', 'aaa', 'failure', '2026-07-20T10:00:00Z', { event: 'push', id: 1 })],
      'dev',
    )
    expect(health.failures).toBe(1)
    expect(health.runnerKills).toBeNull()
    expect(health.failuresUnclassified).toBeNull()
  })

  it('measures the gap from a red push to the next green', () => {
    const health = integrationHealth(
      [
        run('dev', 'aaa', 'failure', '2026-07-20T10:00:00Z', { event: 'push' }),
        run('dev', 'bbb', 'success', '2026-07-20T10:30:00Z', { event: 'push' }),
      ],
      'dev',
    )
    expect(health.failures).toBe(1)
    expect(health.redMinutes).toBe(30)
    expect(health.unresolvedFailures).toBe(0)
  })

  /**
   * A failure never followed by a success must not read as an instant recovery.
   * Silently closing it would make the worst case — a branch left red — look
   * like the best case.
   */
  it('leaves an unrecovered failure open rather than scoring it zero minutes', () => {
    const health = integrationHealth(
      [run('dev', 'aaa', 'failure', '2026-07-20T10:00:00Z', { event: 'push' })],
      'dev',
    )
    expect(health.redMinutes).toBe(0)
    expect(health.unresolvedFailures).toBe(1)
  })

  it('ignores pull_request runs, which do not block anyone', () => {
    const health = integrationHealth([run('dev', 'aaa', 'failure', '2026-07-20T10:00:00Z')], 'dev')
    expect(health.runs).toBe(0)
    expect(health.failures).toBeNull()
  })

  /**
   * The real biffo-plugin-ideation timeline of 2026-07-29 (#921), verbatim from the
   * API. Failure-to-recovery spanned the whole night, and the resulting 21.1h
   * ranked FIRST of five findings on the standup's first real run. 18.8h of it --
   * 89% -- was a red branch with zero pushes against it.
   */
  it('does not charge an overnight of zero pushes as blocked time', () => {
    const push = (start: string, end: string, conclusion: string) =>
      run('dev', start, conclusion, start, { event: 'push', updated_at: end })
    const health = integrationHealth(
      [
        push('2026-07-29T09:28:41Z', '2026-07-29T09:29:45Z', 'failure'),
        push('2026-07-29T10:13:14Z', '2026-07-29T10:14:19Z', 'failure'),
        push('2026-07-29T11:00:19Z', '2026-07-29T11:01:33Z', 'failure'),
        push('2026-07-29T11:47:26Z', '2026-07-29T11:48:42Z', 'failure'),
        push('2026-07-30T06:36:29Z', '2026-07-30T06:38:01Z', 'success'),
      ],
      'dev',
    )
    expect(health.failures).toBe(4)
    expect(health.unresolvedFailures).toBe(0)
    // The pre-#921 figure, kept so the correction can be audited rather than
    // trusted. This is exactly what the collector reported on the day.
    expect(health.redMinutesUncapped).toBe(1268.3)
    // The overnight gap is capped to the ceiling instead of contributing 18.8h.
    expect(health.idleGapsCapped).toBe(1)
    expect(health.redMinutes).toBeLessThan(210)
    // ...and it must not over-correct into pretending nothing was wrong: three
    // real sub-hour waits between four failures still count in full.
    expect(health.redMinutes).toBeGreaterThan(135)
  })

  it('counts a sub-ceiling gap in full, so a genuine outage is not discounted', () => {
    const push = (start: string, end: string, conclusion: string) =>
      run('dev', start, conclusion, start, { event: 'push', updated_at: end })
    const health = integrationHealth(
      [
        push('2026-07-20T10:00:00Z', '2026-07-20T10:02:00Z', 'failure'),
        push('2026-07-20T10:45:00Z', '2026-07-20T10:47:00Z', 'success'),
      ],
      'dev',
    )
    // 43 min waiting + 2 min of recovery run = 45, uncapped and unchanged.
    expect(health.redMinutes).toBe(45)
    expect(health.redMinutesUncapped).toBe(45)
    expect(health.idleGapsCapped).toBe(0)
  })

  it('takes the ceiling as an argument, because it is a judgement not a fact', () => {
    const push = (start: string, end: string, conclusion: string) =>
      run('dev', start, conclusion, start, { event: 'push', updated_at: end })
    const runs = [
      push('2026-07-20T10:00:00Z', '2026-07-20T10:00:00Z', 'failure'),
      push('2026-07-21T10:00:00Z', '2026-07-21T10:00:00Z', 'success'),
    ]
    expect(integrationHealth(runs, 'dev', 60).redMinutes).toBe(60)
    expect(integrationHealth(runs, 'dev', 15).redMinutes).toBe(15)
    // A ceiling wide enough to contain the gap leaves the old behaviour intact.
    expect(integrationHealth(runs, 'dev', 60 * 48).redMinutes).toBe(1440)
  })

  it('stops the waiting clock on a cancelled run — not a verdict, but somebody was there', () => {
    const push = (start: string, end: string, conclusion: string) =>
      run('dev', start, conclusion, start, { event: 'push', updated_at: end })
    const health = integrationHealth(
      [
        push('2026-07-20T10:00:00Z', '2026-07-20T10:00:00Z', 'failure'),
        push('2026-07-20T12:00:00Z', '2026-07-20T12:00:00Z', 'cancelled'),
        push('2026-07-20T12:10:00Z', '2026-07-20T12:10:00Z', 'success'),
      ],
      'dev',
    )
    // 2h gap capped to 60, then a 10 min gap counted in full.
    expect(health.redMinutes).toBe(70)
    expect(health.unresolvedFailures).toBe(0)
  })
})

describe('parseGitLog', () => {
  it('attaches each commit’s files to it', () => {
    const commits = parseGitLog(
      [
        'abc\x1f1753612800\x1ffix(api): thing',
        'src/a.py',
        'src/b.py',
        '',
        'def\x1f1753526400\x1ffeat(api): thing',
        'src/a.py',
      ].join('\n'),
    )
    expect(commits).toHaveLength(2)
    expect(commits[0].files).toEqual(['src/a.py', 'src/b.py'])
    expect(commits[1].subject).toBe('feat(api): thing')
  })

  it('keeps a subject containing the separator intact', () => {
    const commits = parseGitLog('abc\x1f1753612800\x1ffix: a\x1fb')
    expect(commits[0].subject).toBe('fix: a\x1fb')
  })
})

describe('parseDiffHunks', () => {
  it('extracts the pre-image line range a hunk changed', () => {
    const hunks = parseDiffHunks(
      ['--- a/src/app.py', '+++ b/src/app.py', '@@ -10,3 +10,4 @@ def f():', '-old', '+new'].join(
        '\n',
      ),
    )
    expect(hunks).toEqual([{ file: 'src/app.py', start: 10, count: 3 }])
  })

  it('treats a hunk header without a count as one line', () => {
    const hunks = parseDiffHunks(['--- a/src/app.py', '@@ -10 +10 @@'].join('\n'))
    expect(hunks[0].count).toBe(1)
  })

  /**
   * A hunk that only inserts lines corrects no existing line, so there is
   * nothing to blame. Including it would attribute the fix to whoever last
   * touched the line above the insertion point.
   */
  it('drops a pure insertion', () => {
    const hunks = parseDiffHunks(['--- a/src/app.py', '@@ -10,0 +11,3 @@', '+a'].join('\n'))
    expect(hunks).toEqual([])
  })

  it('drops a newly added file', () => {
    const hunks = parseDiffHunks(
      ['--- /dev/null', '+++ b/src/new.py', '@@ -0,0 +1,3 @@'].join('\n'),
    )
    expect(hunks).toEqual([])
  })

  /**
   * Lockfiles are rewritten by nearly every change, so blaming one answers
   * "who last touched the lockfile", never "which change is being corrected".
   */
  it('refuses to attribute through a lockfile', () => {
    const hunks = parseDiffHunks(
      ['--- a/pnpm-lock.yaml', '@@ -5,2 +5,2 @@', '--- a/uv.lock', '@@ -1,1 +1,1 @@'].join('\n'),
    )
    expect(hunks).toEqual([])
  })
})

describe('summariseRework', () => {
  const hours = (n: number) => n * 3600000
  const now = Date.parse('2026-07-27T00:00:00Z')

  it('reports the lag distribution of attributed fixes', () => {
    const result = summariseRework(
      [
        { at: now, correctedAt: now - hours(0.5) },
        { at: now, correctedAt: now - hours(4) },
        { at: now, correctedAt: now - hours(100) },
      ],
      10,
    )
    expect(result.fixMerges).toBe(3)
    expect(result.fixShare).toBe(30)
    expect(result.attributed).toBe(3)
    expect(result.medianHoursToRework).toBe(4)
    expect(result.correctedWithin1hShare).toBe(33.3)
    expect(result.correctedWithin24hShare).toBe(66.7)
  })

  /**
   * Unattributable fixes (pure insertions, deleted files) must lower coverage
   * rather than silently counting as long-lag — which would flatter the number
   * the whole programme is trying to move.
   */
  it('excludes unattributed fixes from the lag but keeps them in the share', () => {
    const result = summariseRework(
      [
        { at: now, correctedAt: now - hours(2) },
        { at: now, correctedAt: null },
      ],
      4,
    )
    expect(result.fixMerges).toBe(2)
    expect(result.fixShare).toBe(50)
    expect(result.attributed).toBe(1)
    expect(result.medianHoursToRework).toBe(2)
  })

  it('reports null rather than 0 when nothing could be attributed', () => {
    const result = summariseRework([{ at: now, correctedAt: null }], 3)
    expect(result.attributed).toBe(0)
    expect(result.medianHoursToRework).toBeNull()
    expect(result.correctedWithin1hShare).toBeNull()
  })

  it('reports null across the board for a repo with no merges in the window', () => {
    const result = summariseRework([], 0)
    expect(result.merges).toBe(0)
    expect(result.fixShare).toBeNull()
    expect(result.medianHoursToRework).toBeNull()
  })
})

describe('mergeContention', () => {
  /**
   * Ground truth: biffo-template#659 opened 08:40:58, went green at 08:41, and
   * merged at 09:29:47 across five head SHAs — four rebases lost to the
   * up-to-date race, exactly as the practices corpus recorded. The earlier
   * runner-queue metric scored this PR as zero contention.
   */
  it('measures the wait of a PR that was green and could not land', () => {
    const runsByBranch = indexRunsByBranch([
      run('refactor/unified-principal', '76d8f790', 'success', '2026-07-27T08:41:00Z'),
      run('refactor/unified-principal', '339ba4f3', 'success', '2026-07-27T08:46:20Z'),
      run('refactor/unified-principal', '7b887896', 'success', '2026-07-27T08:50:11Z'),
      run('refactor/unified-principal', '2e44463c', 'success', '2026-07-27T09:02:16Z'),
      run('refactor/unified-principal', '49dade2c', 'success', '2026-07-27T09:27:20Z'),
    ])
    const result = mergeContention(
      [pr('refactor/unified-principal', '2026-07-27T08:40:58Z', '2026-07-27T09:29:47Z', 659)],
      runsByBranch,
    )
    expect(result.greenToMergeP90Minutes).toBeCloseTo(48.8, 0)
    expect(result.repushRate).toBe(100)
    expect(result.racedShare).toBe(100)
  })

  /**
   * H3's counter-metric (#977). `strict: false` buys back the rebase race by
   * allowing exactly this: B goes green at 10:00 against a `dev` that A then
   * moves at 10:30, and B merges at 11:00 in a combination no run ever tested.
   * Under `strict: true` that merge is refused until B rebases.
   */
  it('counts a merge whose base moved between first green and merge', () => {
    const runsByBranch = indexRunsByBranch([
      run('feat/a', 'aaa', 'success', '2026-07-20T09:00:00Z'),
      run('feat/b', 'bbb', 'success', '2026-07-20T10:00:00Z'),
    ])
    const result = mergeContention(
      [
        pr('feat/a', '2026-07-20T08:00:00Z', '2026-07-20T10:30:00Z', 1),
        pr('feat/b', '2026-07-20T08:00:00Z', '2026-07-20T11:00:00Z', 2),
      ],
      runsByBranch,
    )
    // Only B is stale: A merged at 10:30 with nothing landing after its 09:00
    // green, while B's base moved under it.
    expect(result.staleMerges).toBe(1)
    expect(result.staleMergeShare).toBe(50)
  })

  /**
   * The defect the unit tests missed and a live run caught: anchoring to the
   * FIRST green counts a rebased-and-re-greened PR as stale, which is what
   * `strict: true` forces every raced PR to do. That made the counter-metric a
   * second reading of `racedShare` — it scored 44% on repos where the gate
   * makes staleness impossible by construction.
   *
   * Here B goes green at 10:00, A lands at 10:30, B rebases and re-greens at
   * 10:45, then merges at 11:00. The base did NOT move after the run that
   * validated what merged, so B is not stale.
   */
  it('does not call a rebased-and-re-greened PR stale', () => {
    const runsByBranch = indexRunsByBranch([
      run('feat/a', 'aaa', 'success', '2026-07-20T09:00:00Z'),
      run('feat/b', 'bbb', 'success', '2026-07-20T10:00:00Z'),
      run('feat/b', 'ccc', 'success', '2026-07-20T10:45:00Z'),
    ])
    const result = mergeContention(
      [
        pr('feat/a', '2026-07-20T08:00:00Z', '2026-07-20T10:30:00Z', 1),
        pr('feat/b', '2026-07-20T08:00:00Z', '2026-07-20T11:00:00Z', 2),
      ],
      runsByBranch,
    )
    expect(result.staleMerges).toBe(0)
    // ...while the race it paid to avoid is still counted, which is the point:
    // the two metrics must be able to disagree.
    expect(result.racedShare).toBe(50)
  })

  /**
   * `runsForPr` admits runs created up to 24h AFTER the merge, so the last
   * green overall can postdate the merge. Anchoring to it unclamped puts the
   * window's start after its end and makes the PR unstaleable — a silent false
   * negative, worst on exactly the busy branches this metric is watching.
   *
   * B is genuinely stale (A landed at 10:30, after B's 10:00 green) and also
   * has a post-merge run at 11:30. It must still count.
   */
  it('ignores a green that completed after the merge when anchoring', () => {
    const runsByBranch = indexRunsByBranch([
      run('feat/a', 'aaa', 'success', '2026-07-20T09:00:00Z'),
      run('feat/b', 'bbb', 'success', '2026-07-20T10:00:00Z'),
      run('feat/b', 'bbb', 'success', '2026-07-20T11:30:00Z'),
    ])
    const result = mergeContention(
      [
        pr('feat/a', '2026-07-20T08:00:00Z', '2026-07-20T10:30:00Z', 1),
        pr('feat/b', '2026-07-20T08:00:00Z', '2026-07-20T11:00:00Z', 2),
      ],
      runsByBranch,
    )
    expect(result.staleMerges).toBe(1)
  })

  /**
   * The metric must not fire on the PR's own merge, or every measured PR would
   * read as stale and the counter-metric would be a constant.
   */
  it('does not call a lone merge stale against itself', () => {
    const runsByBranch = indexRunsByBranch([
      run('feat/only', 'aaa', 'success', '2026-07-20T10:00:00Z'),
    ])
    const result = mergeContention(
      [pr('feat/only', '2026-07-20T09:00:00Z', '2026-07-20T11:00:00Z')],
      runsByBranch,
    )
    expect(result.staleMerges).toBe(0)
    expect(result.staleMergeShare).toBe(0)
  })

  /**
   * `dev` and `staging` are separate races. Keying staleness by base ref is
   * what stops a promotion merge from making every `dev` PR read as stale.
   */
  it('does not let a merge to another base make a PR stale', () => {
    const runsByBranch = indexRunsByBranch([
      run('feat/x', 'aaa', 'success', '2026-07-20T10:00:00Z'),
      run('release/y', 'bbb', 'success', '2026-07-20T10:00:00Z'),
    ])
    const onStaging = {
      ...pr('release/y', '2026-07-20T09:00:00Z', '2026-07-20T10:30:00Z', 2),
      baseRefName: 'staging',
    }
    const result = mergeContention(
      [pr('feat/x', '2026-07-20T09:00:00Z', '2026-07-20T11:00:00Z', 1), onStaging],
      runsByBranch,
    )
    expect(result.staleMerges).toBe(0)
  })

  it('does not count a PR that merged straight after going green', () => {
    const runsByBranch = indexRunsByBranch([
      run('feat/quick', 'aaa', 'success', '2026-07-20T10:00:00Z'),
    ])
    const result = mergeContention(
      [pr('feat/quick', '2026-07-20T09:58:00Z', '2026-07-20T10:01:00Z')],
      runsByBranch,
    )
    expect(result.racedShare).toBe(0)
    expect(result.repushRate).toBe(0)
    expect(result.greenToMergeP90Minutes).toBe(1)
  })

  /**
   * A long wait without a repush is not the merge race — it is a PR nobody got
   * to. Counting it would blame branch protection for ordinary latency.
   */
  it('does not call a long wait "raced" when the branch was never repushed', () => {
    const runsByBranch = indexRunsByBranch([
      run('feat/slow', 'aaa', 'success', '2026-07-20T10:00:00Z'),
    ])
    const result = mergeContention(
      [pr('feat/slow', '2026-07-20T09:58:00Z', '2026-07-20T14:00:00Z')],
      runsByBranch,
    )
    expect(result.racedShare).toBe(0)
    expect(result.greenToMergeP90Minutes).toBe(240)
  })

  it('ignores a merge that landed before any run completed', () => {
    const runsByBranch = indexRunsByBranch([
      run('feat/fast', 'aaa', 'success', '2026-07-20T10:30:00Z'),
    ])
    const result = mergeContention(
      [pr('feat/fast', '2026-07-20T10:00:00Z', '2026-07-20T10:05:00Z')],
      runsByBranch,
    )
    expect(result.prsWithGreen).toBe(0)
    expect(result.greenButUnmergedHours).toBe(0)
  })

  it('reports null rates when nothing could be measured', () => {
    const result = mergeContention(
      [pr('feat/ghost', '2026-07-20T09:00:00Z', '2026-07-20T11:00:00Z')],
      new Map(),
    )
    expect(result.prsMeasured).toBe(0)
    expect(result.repushRate).toBeNull()
    expect(result.racedShare).toBeNull()
  })
})

describe('summariseRepo', () => {
  const repo = { slug: 'o/r', role: 'template' }

  it('rolls PRs, runs and commits into the metric set', () => {
    const summary = summariseRepo(repo, {
      defaultBranch: 'dev',
      prs: [
        pr('feat/a', '2026-07-20T09:00:00Z', '2026-07-20T09:30:00Z', 1),
        pr('feat/b', '2026-07-21T09:00:00Z', '2026-07-21T10:00:00Z', 2),
      ],
      runs: [
        run('feat/a', 'aaa', 'success', '2026-07-20T09:05:00Z'),
        run('feat/b', 'bbb', 'failure', '2026-07-21T09:05:00Z'),
        run('feat/b', 'ccc', 'success', '2026-07-21T09:40:00Z'),
      ],
      rework: null,
    })

    expect(summary.mergedPrs).toBe(2)
    expect(summary.ciFailureRate).toBe(50)
    expect(summary.landedFirstPushRate).toBe(50)
    // Nearest-rank, so an even-sized sample takes the lower value rather than
    // interpolating a midpoint. Documented in metrics.md — it matters when a
    // repo has very few PRs in the window.
    expect(summary.cycleTimeP50Minutes).toBe(30)
    expect(summary.cycleTimeP90Minutes).toBe(60)
    expect(summary.coverage.prsMeasured).toBe(2)
  })

  /**
   * A repo with no local clone must not contribute a 0% rework rate to the
   * aggregate — that would make missing data look like the best possible result.
   */
  it('reports rework as null when no git history was available', () => {
    const summary = summariseRepo(repo, {
      defaultBranch: 'dev',
      prs: [],
      runs: [],
      rework: null,
    })
    expect(summary.rework.medianHoursToRework).toBeNull()
    expect(summary.rework.fixShare).toBeNull()
    expect(summary.coverage.reworkSource).toBe('unavailable')
  })

  it('separates PRs it could not measure from PRs that were clean', () => {
    const summary = summariseRepo(repo, {
      defaultBranch: 'dev',
      prs: [pr('feat/ghost', '2026-07-20T09:00:00Z', '2026-07-20T09:30:00Z')],
      runs: [],
      rework: null,
    })
    expect(summary.mergedPrs).toBe(1)
    expect(summary.coverage.prsMeasured).toBe(0)
    expect(summary.coverage.prsUnmeasured).toBe(1)
    expect(summary.ciFailureRate).toBeNull()
  })
})

describe('classifyWork', () => {
  it('maps conventional types to intent', () => {
    expect(classifyWork('feat(api): add thing')).toBe('delivery')
    expect(classifyWork('fix(api): correct thing')).toBe('rework')
    expect(classifyWork('ci: bump runner')).toBe('toil')
    expect(classifyWork('docs(guides): explain')).toBe('docs')
  })

  /**
   * ~8% of merges carry no parseable type. Folding them into any other bucket
   * would move the headline ratio by more than most experiments will, so they
   * get their own.
   */
  it('keeps unparseable subjects in their own bucket', () => {
    expect(classifyWork('Upgrade Biffo core 0.124.0 → 0.124.2 (#235)')).toBe('unconventional')
    expect(classifyWork('Merge pull request #182 from x')).toBe('unconventional')
  })
})

describe('summariseWorkMix', () => {
  it('computes the SRE toil ratio as toil plus rework', () => {
    const mix = summariseWorkMix([
      { subject: 'feat(api): a' },
      { subject: 'feat(api): b' },
      { subject: 'fix(api): c' },
      { subject: 'ci: d' },
    ])
    expect(mix.delivery).toBe(50)
    expect(mix.rework).toBe(25)
    expect(mix.toil).toBe(25)
    expect(mix.toilRatio).toBe(50)
  })

  it('returns nulls rather than zeroes for an empty window', () => {
    const mix = summariseWorkMix([])
    expect(mix.merges).toBe(0)
    expect(mix.toilRatio).toBeNull()
  })
})

describe('filterToWindow', () => {
  const data = {
    defaultBranch: 'dev',
    prs: [
      { headRefName: 'a', createdAt: '2026-07-01T00:00:00Z', mergedAt: '2026-07-01T01:00:00Z' },
      { headRefName: 'b', createdAt: '2026-07-26T00:00:00Z', mergedAt: '2026-07-26T01:00:00Z' },
    ],
    runs: [
      {
        head_branch: 'a',
        head_sha: 'x',
        conclusion: 'success',
        created_at: '2026-07-01T00:30:00Z',
      },
      {
        head_branch: 'b',
        head_sha: 'y',
        conclusion: 'success',
        created_at: '2026-07-26T00:30:00Z',
      },
    ],
    rework: {
      fixes: [{ at: Date.parse('2026-07-01T02:00:00Z'), correctedAt: null }],
      commits: [
        { at: Date.parse('2026-07-01T01:00:00Z'), subject: 'feat: old' },
        { at: Date.parse('2026-07-26T01:00:00Z'), subject: 'feat: new' },
      ],
    },
  }

  it('narrows every series to the window', () => {
    const w = filterToWindow(data, '2026-07-20T00:00:00Z')
    expect(w.prs).toHaveLength(1)
    expect(w.runs).toHaveLength(1)
    expect(w.rework.commits).toHaveLength(1)
    expect(w.rework.fixes).toHaveLength(0)
  })

  it('keeps everything for a window that predates the data', () => {
    const w = filterToWindow(data, '2026-01-01T00:00:00Z')
    expect(w.prs).toHaveLength(2)
    expect(w.rework.commits).toHaveLength(2)
  })

  it('passes a missing local clone through as null rather than empty', () => {
    const w = filterToWindow({ ...data, rework: null }, '2026-07-20T00:00:00Z')
    expect(w.rework).toBeNull()
  })

  /**
   * The upper bound is what makes a baseline that does not contain the reading
   * it is compared against — the whole point of #835.
   */
  it('excludes everything at or after the upper bound', () => {
    const w = filterToWindow(data, '2026-01-01T00:00:00Z', '2026-07-20T00:00:00Z')
    expect(w.prs).toHaveLength(1)
    expect(w.prs[0].headRefName).toBe('a')
    expect(w.runs).toHaveLength(1)
    expect(w.rework.commits).toHaveLength(1)
    expect(w.rework.fixes).toHaveLength(1)
  })

  it('splits the data into two disjoint halves that partition the whole', () => {
    const cut = '2026-07-20T00:00:00Z'
    const before = filterToWindow(data, '2026-01-01T00:00:00Z', cut)
    const after = filterToWindow(data, cut)
    expect(before.prs.length + after.prs.length).toBe(data.prs.length)
    expect(before.prs.map((p: { headRefName: string }) => p.headRefName)).not.toContain(
      after.prs[0].headRefName,
    )
  })
})

describe('priorWindow', () => {
  const now = Date.parse('2026-07-29T00:00:00Z')

  it('is the equal-length period immediately before the rate window', () => {
    const p = priorWindow([1, 7, 90], now)
    // Last week, against this week — matched in length, sharing no merge.
    expect(p.days).toBe(7)
    expect(p.since).toBe('2026-07-15T00:00:00.000Z')
    expect(p.until).toBe('2026-07-22T00:00:00.000Z')
  })

  /**
   * The baseline must be the same LENGTH as the reading, not merely disjoint
   * from it. 90d-minus-7d was independent but compared a week to a quarter, so
   * the reference was dominated by whichever regime prevailed over 83 days —
   * the green-wait units mismatch, one level up.
   */
  it('does not stretch to whatever is left of the long window', () => {
    expect(priorWindow([1, 7, 90], now).days).toBe(7)
    expect(priorWindow([1, 7, 30], now).days).toBe(7)
    // The long window only supplies context; it never sets the baseline length.
    expect(priorWindow([1, 7, 90], now)).toEqual(priorWindow([1, 7, 30], now))
  })

  it('needs a rate window to derive one', () => {
    expect(priorWindow([7], now)).toBeNull()
    expect(priorWindow([], now)).toBeNull()
  })

  it('takes the two longest windows, whatever order they are given in', () => {
    expect(priorWindow([90, 1, 7], now)).toEqual(priorWindow([1, 7, 90], now))
  })
})

describe('classifyMergeSide', () => {
  it('defaults to the repo it landed in', () => {
    expect(classifyMergeSide('feat(api): a', 'product')).toBe('product')
    expect(classifyMergeSide('ci: bump', 'platform')).toBe('platform')
  })

  /**
   * The correction this function exists for. `tabsii-platform` is the product's
   * backend *and* a Biffo instance, so 30 of its 230 merges in the first window
   * were core upgrades — 7.8% of all product-repo merges — each counted as
   * product delivery by the repo-level cut.
   */
  it('counts a core upgrade as platform even inside a product repo', () => {
    expect(classifyMergeSide('Upgrade Biffo core 0.124.0 → 0.127.0 (#236)', 'product')).toBe(
      'platform',
    )
    expect(classifyMergeSide('chore: core-upgrade 0.1 to 0.2', 'product')).toBe('platform')
  })

  it('returns null rather than guessing when the repo has no side', () => {
    expect(classifyMergeSide('feat(api): a', undefined)).toBeNull()
  })
})

describe('summariseEstate', () => {
  const repo = (side: string, subjects: string[], hours = 10) => ({
    side,
    ...{
      workMix: summariseWorkMix(
        subjects.map((subject) => ({ subject })),
        side,
      ),
    },
    contention: { greenButUnmergedHours: hours },
  })

  /**
   * Summed from absolute counts, not reconstructed from percentages — the old
   * implementation multiplied each repo's share back out, which let a repo with
   * three merges pull the headline as hard as one with four hundred.
   */
  it('weights the estate figure by merge volume', () => {
    const estate = summariseEstate({
      big: repo(
        'platform',
        Array.from({ length: 8 }, (_, i) => (i < 4 ? 'fix: a' : 'feat: b')),
      ),
      small: repo('product', ['feat: c']),
    })
    expect(estate.merges).toBe(9)
    expect(estate.platformShare).toBe(88.9)
    expect(estate.toilRatio).toBe(44.4) // 4 rework of 9
  })

  it('reattributes a product repo’s core upgrades to platform', () => {
    const estate = summariseEstate({
      prod: repo('product', [
        'feat(api): a',
        'feat(api): b',
        'Upgrade Biffo core 0.1 → 0.2 (#1)',
        'Upgrade Biffo core 0.2 → 0.3 (#2)',
      ]),
    })
    expect(estate.merges).toBe(4)
    expect(estate.platformShare).toBe(50)
    expect(estate.productShare).toBe(50)
    // Only the two feats count as product delivery; the upgrades do not.
    expect(estate.tabsiiCapabilityShare).toBe(50)
  })

  it('reports the Tabsii capability share as a fraction of ALL merges', () => {
    const estate = summariseEstate({
      plat: repo('platform', ['feat: a', 'fix: b']),
      prod: repo('product', ['feat: c', 'fix: d']),
    })
    // 1 product feature out of 4 total merges
    expect(estate.tabsiiCapabilityShare).toBe(25)
  })

  it('sums contention hours across repos', () => {
    const estate = summariseEstate({
      a: repo('platform', ['feat: a'], 100),
      b: repo('product', ['feat: b'], 63),
    })
    expect(estate.contentionHours).toBe(163)
  })

  it('reports nulls rather than zeroes when nothing was measurable', () => {
    const estate = summariseEstate({ a: { error: 'unmeasured' } })
    expect(estate.merges).toBe(0)
    expect(estate.toilRatio).toBeNull()
    expect(estate.tabsiiCapabilityShare).toBeNull()
  })
})

describe('grade', () => {
  it('grades a lower-is-better metric against its budget', () => {
    expect(grade(30, { warn: 40, crit: 50 })).toBe('good')
    expect(grade(45, { warn: 40, crit: 50 })).toBe('warning')
    expect(grade(60, { warn: 40, crit: 50 })).toBe('critical')
  })

  it('inverts for a higher-is-better metric', () => {
    expect(grade(30, { warn: 20, crit: 10, higherIsBetter: true })).toBe('good')
    expect(grade(15, { warn: 20, crit: 10, higherIsBetter: true })).toBe('warning')
    expect(grade(5, { warn: 20, crit: 10, higherIsBetter: true })).toBe('critical')
  })

  /**
   * The dashboard must never render missing data in the same colour as a
   * healthy reading — that is the fail-open shape the programme exists to kill.
   */
  it('grades missing data as unknown, never good', () => {
    expect(grade(null, { warn: 40, crit: 50 })).toBe('unknown')
    expect(grade(undefined, { warn: 40, crit: 50 })).toBe('unknown')
  })
})

describe('fmt', () => {
  it('shows an em dash for unmeasured, not zero', () => {
    expect(fmt(null, '%')).toBe('—')
    expect(fmt(0, '%')).toBe('0%')
  })
})

describe('renderDashboard', () => {
  // These fixtures deliberately carry the RETIRED `productFeatureShare` rather
  // than `capabilityShare`: they are a snapshot written before #768, and they
  // exercise the dashboard's fallback. Every snapshot already committed looks
  // like this, and a page that renders `unmeasured` for the historical series
  // would be worse than the mislabelling it replaced.
  const snapshot = {
    collectedAt: '2026-07-27T13:00:00.000Z',
    windowDays: [1, 7, 90],
    windows: {
      1: {
        estate: {
          merges: 5,
          productFeatureShare: 0,
          toilRatio: 60,
          platformShare: 100,
          productShare: 0,
          contentionHours: 1,
        },
        repos: {},
      },
      7: {
        estate: {
          merges: 40,
          productFeatureShare: 4,
          toilRatio: 46,
          platformShare: 78,
          productShare: 22,
          contentionHours: 9,
          gates: {
            repos: 2,
            failingSteps: 20,
            locallyCatchable: 12,
            notLocallyCatchable: 8,
            unclassified: 0,
            share: 60,
            byKind: { test: 9, format: 6, 'dependency-audit': 5 },
          },
        },
        repos: {},
      },
      90: {
        estate: {
          merges: 1000,
          productFeatureShare: 14,
          toilRatio: 43,
          platformShare: 62,
          productShare: 38,
          contentionHours: 250,
        },
        repos: {
          'o/alpha': {
            side: 'platform',
            mergedPrs: 400,
            ciFailureRate: 17,
            contention: { repushRate: 36, racedShare: 14, greenButUnmergedHours: 163 },
            workMix: { toilRatio: 68 },
            rework: { medianHoursToRework: 2.4 },
          },
        },
      },
    },
  }

  it('renders the headline and the repo row', () => {
    const html = renderDashboard(snapshot)
    expect(html).toContain('<title>')
    expect(html).toContain('alpha')
    expect(html).toContain('163h')
  })

  /**
   * Regression: the estate helper accepted a window *object* at one call site
   * and a *day count* at the other four, so every tile silently resolved to {}
   * and rendered "—" while the headline rendered correctly. The original test
   * asserted only on repo-table values, so it passed against the bug — a guard
   * that protected nothing. These assertions fail without the fix.
   */
  it('renders every estate tile with real values, not dashes', () => {
    const html = renderDashboard(snapshot)
    expect(html).toContain('46%') // toil ratio, 7d
    expect(html).toContain('78% / 22%') // platform vs product, 7d
    expect(html).toContain('9h') // green-but-unmerged, 7d
    expect(html).toContain('>5<') // merges, 24h
    expect(html).toContain('60%') // locally-catchable share, 7d (#914)
    expect(html).toContain('12 of 20 failing steps') // its denominator, always shown
  })

  it('shows the unclassified count only when it is non-zero, and in bold', () => {
    // A falling share with a rising unclassified count is the metric going
    // blind, not an improvement — so it cannot be a number you have to go
    // looking for. At zero it is noise, hence the asymmetry.
    expect(renderDashboard(snapshot)).not.toContain('unclassified')
    const blind = structuredClone(snapshot)
    blind.windows[7].estate.gates.unclassified = 7
    expect(renderDashboard(blind)).toContain('<strong>7 unclassified</strong>')
  })

  it('renders a pre-#914 snapshot without a gates block rather than crashing', () => {
    // Every snapshot committed before this metric existed looks like this.
    const old = structuredClone(snapshot)
    delete old.windows[7].estate.gates
    const html = renderDashboard(old)
    expect(html).toContain('no failing steps classified in the window')
    expect(html).toContain('46%') // the rest of the page still renders
  })

  it('grades a tile from its window rather than defaulting to unknown', () => {
    const html = renderDashboard(snapshot)
    // toilRatio 46 sits between warn (40) and crit (50)
    expect(html).toContain('tile warning')
    // Exactly one tile is legitimately ungraded: a raw merge count has no
    // good or bad value. Any more than that means the window lookup broke again.
    expect(html.match(/tile unknown/g)).toHaveLength(1)
  })

  it('does not emit a document skeleton the Artifact wrapper supplies', () => {
    const html = renderDashboard(snapshot)
    expect(html).not.toContain('<!doctype')
    expect(html).not.toContain('<body')
  })

  it('renders unmeasured estate values as a dash rather than zero', () => {
    const bare = { collectedAt: 'x', windowDays: [1], windows: { 1: { estate: {}, repos: {} } } }
    const html = renderDashboard(bare)
    expect(html).toContain('—')
  })

  /**
   * A pre-#768 snapshot carries `productFeatureShare` on the old, much smaller
   * denominator. It still renders — it is the historical series — but grading
   * it against a floor derived from the new definition would stamp `critical`
   * on a number that was never measuring the same thing.
   */
  it('shows a pre-#768 reading but refuses to grade it', () => {
    const html = renderDashboard(snapshot)
    expect(html).toContain('>4%<')
    expect(html).toContain('pill unknown')
    expect(html).toContain('not graded')
  })
})

/**
 * The two defects this suite was written for, both found by reading the
 * 2026-07-29 page rather than the code (#831). Fixtures use that day's real
 * figures so the assertions are anchored to an observed failure.
 */
describe('renderDashboard — grading the capability headline', () => {
  const capSnapshot = (capability7: number) => ({
    collectedAt: '2026-07-29T03:35:00.000Z',
    windowDays: [1, 7, 90],
    windows: {
      1: { estate: { merges: 145, capabilityShare: 33.1, toilRatio: 38.6 }, repos: {} },
      7: {
        estate: {
          merges: 616,
          capabilityShare: capability7,
          toilRatio: 44.2,
          platformShare: 81,
          productShare: 19,
          contentionHours: 91.8,
        },
        repos: {},
      },
      90: {
        estate: { merges: 1232, capabilityShare: 35, toilRatio: 42.9, contentionHours: 278.2 },
        repos: {},
      },
    },
  })

  it('derives the floor from the toil budget and the measured support share', () => {
    expect(CAPABILITY_FLOOR).toBe(28)
    expect(CAPABILITY_CRITICAL).toBe(20)
  })

  /**
   * The regression. Under the inherited `PRODUCT_FEATURE_FLOOR` of 20 every one
   * of these readings graded `good`, including the two that are plainly not —
   * a pill ~15 points clear of its threshold in every window cannot move, and
   * an unmovable grade is decoration.
   */
  it('grades a reading that clears the floor, and one that does not', () => {
    expect(renderDashboard(capSnapshot(33)) as string).toContain('pill good')
    // 24% would have been `good` against the old floor of 20.
    expect(renderDashboard(capSnapshot(24)) as string).toContain('pill warning')
    expect(renderDashboard(capSnapshot(15)) as string).toContain('pill critical')
  })

  it('states the floor, so the grade can be checked against it', () => {
    expect(renderDashboard(capSnapshot(33)) as string).toContain('floor 28%')
  })
})

describe('renderDashboard — independent baseline and normalised contention', () => {
  /** 2026-07-29 as collected, plus the `prior` window the collector now emits. */
  const base = {
    collectedAt: '2026-07-29T03:35:00.000Z',
    windowDays: [1, 7, 90],
    windows: {
      1: { estate: { merges: 145, capabilityShare: 33.1, toilRatio: 38.6 }, repos: {} },
      7: {
        estate: {
          merges: 616,
          capabilityShare: 33,
          toilRatio: 44.2,
          platformShare: 81,
          productShare: 19,
          contentionHours: 91.8,
        },
        repos: {},
      },
      90: {
        estate: {
          merges: 1232,
          capabilityShare: 35,
          toilRatio: 42.9,
          platformShare: 66.6,
          productShare: 33.4,
          contentionHours: 278.2,
        },
        repos: {},
      },
    },
  }
  const withPrior = {
    ...base,
    windows: {
      ...base.windows,
      prior: {
        days: 83,
        since: '2026-04-30T03:35:00.000Z',
        until: '2026-07-22T03:35:00.000Z',
        estate: {
          merges: 616,
          capabilityShare: 37,
          toilRatio: 41.6,
          platformShare: 52.2,
          productShare: 47.8,
          contentionHours: 186.4,
        },
        repos: {},
      },
    },
  }

  it('compares against the prior window, not the lookback that contains the week', () => {
    const html = renderDashboard(withPrior) as string
    expect(html).toContain('prior 83d baseline 37%')
    expect(html).toContain('prior 83d 41.6%')
    expect(html).toContain('prior 83d 52.2% / 47.8%')
    // The contaminated 90-day figures must not be presented as the reference.
    expect(html).not.toContain('baseline 35%')
    expect(html).not.toContain('90-day baseline')
  })

  /**
   * Snapshots collected before the split have no `prior`. Falling back to 90d
   * is right — a page of dashes would be worse — but the overlap has to be
   * stated, because it is the reason the numbers look so agreeable.
   */
  it('discloses the overlap when it has to fall back to the lookback', () => {
    const html = renderDashboard(base) as string
    expect(html).toContain("50%</strong> of the baseline's merges are the same merges")
  })

  it('does not cry overlap once an independent baseline exists', () => {
    expect(renderDashboard(withPrior) as string).not.toContain('the same merges')
  })

  /**
   * The tile showed 91.8h against 278.2h — a week against a quarter, which read
   * as a comfortable win. Per day it inverted to 4× worse. Per merge the volume
   * cancels: 8.9 min against 18.2 min, and the tile finally answers "how long
   * does a PR of mine sit green?".
   */
  it('normalises green wait by the merges that produced it', () => {
    const html = renderDashboard(withPrior) as string
    expect(html).toContain('Green wait per merge')
    expect(html).toContain('8.9 min')
    expect(html).toContain('18.2 min')
    // The raw hours stay, as context rather than as the comparison.
    expect(html).toContain('91.8h across 616 merges')
  })

  it('grades green wait against the ten-minute line, not a weekly total', () => {
    expect(GREEN_WAIT_WARN_MINUTES).toBe(10)
    // 91.8h over 616 merges is 8.9 min — under the line, where the old tile
    // graded the same reading `critical` on 91.8 > 20 "hours".
    expect(renderDashboard(withPrior) as string).toContain('tile good')
    const congested = {
      ...withPrior,
      windows: {
        ...withPrior.windows,
        7: {
          ...withPrior.windows[7],
          estate: { ...withPrior.windows[7].estate, contentionHours: 300 },
        },
      },
    }
    expect(renderDashboard(congested) as string).toContain('tile critical')
  })
})

describe('renderAudits', () => {
  /**
   * These are the only figures on the page that can be *wrong* rather than
   * merely unflattering, and until #865 all three were run by hand. That is how
   * a local gate reporting `verify passed` while checking nothing survived
   * across eight repos: nobody ran the check, and the check did not exist,
   * because the metric that did exist — arming — was green.
   */
  it('renders a failing audit as critical, not as a number to read past', () => {
    const html = renderAudits({
      collectedAt: 'x',
      audits: [{ name: 'coverage', ok: false, exit: 1, summary: 'six repos at 1/8' }],
    }) as string
    expect(html).toContain('tile critical')
    expect(html).toContain('six repos at 1/8')
    expect(html).toContain('exit 1')
  })

  it('renders a passing audit as good', () => {
    const html = renderAudits({
      collectedAt: 'x',
      audits: [{ name: 'arming', ok: true, exit: 0, summary: '36 armed, 0 dead' }],
    }) as string
    expect(html).toContain('tile good')
  })

  /**
   * The load-bearing case. "Not collected" and "collected and clean" must never
   * look the same — that conflation is the exact failure this section reports
   * on, and rendering nothing would reproduce it one level up.
   */
  it('says nothing was checked, rather than showing a clean page', () => {
    for (const empty of [null, { collectedAt: 'x', audits: [] }]) {
      const html = renderAudits(empty) as string
      expect(html).toContain('not collected')
      expect(html).not.toContain('tile good')
    }
  })
})

describe('definitionBreak', () => {
  const dir = makeTmpDir('practices-break')
  const write = (date: string, schema: number) =>
    writeFileSync(join(dir, `${date}.json`), JSON.stringify({ schema, windows: {} }))

  it('finds the date the definitions changed', () => {
    write('2026-07-27', 1)
    write('2026-07-28', 1)
    write('2026-07-29', 2)
    expect(definitionBreak(dir)).toEqual({ date: '2026-07-29', from: 1, to: 2 })
  })

  it('reports nothing when the series is continuous', () => {
    const clean = makeTmpDir('practices-clean')
    writeFileSync(join(clean, '2026-07-28.json'), JSON.stringify({ schema: 2 }))
    writeFileSync(join(clean, '2026-07-29.json'), JSON.stringify({ schema: 2 }))
    expect(definitionBreak(clean)).toBeNull()
    expect(definitionBreak(makeTmpDir('practices-empty'))).toBeNull()
  })

  it('marks the break on the page, naming what it means', () => {
    const html = renderDashboard(
      { collectedAt: 'x', windowDays: [7], windows: { 7: { estate: {}, repos: {} } } },
      null,
      { date: '2026-07-29', from: 1, to: 2 },
    ) as string
    expect(html).toContain('Series break at')
    expect(html).toContain('2026-07-29')
    expect(html).toContain('schema 1 → 2')
  })
})

describe('renderDashboard — corroboration window', () => {
  /**
   * 2026-07-29 as collected: an effort log of 34 tasks over 2 days, 33.1% of
   * wall-clock on toil, against a merge proxy of 44.2% (7d) and 42.9% (90d).
   */
  const snapshot = {
    collectedAt: '2026-07-29T03:35:00.000Z',
    windowDays: [1, 7, 90],
    windows: {
      1: { estate: { merges: 145, capabilityShare: 33.1, toilRatio: 38.6 }, repos: {} },
      7: { estate: { merges: 616, capabilityShare: 33, toilRatio: 44.2 }, repos: {} },
      90: { estate: { merges: 1232, capabilityShare: 35, toilRatio: 42.9 }, repos: {} },
    },
  }
  const sessions = {
    sessions: 34,
    tasks: 34,
    days: 2,
    hours: 86,
    delivery: 16.1,
    platform: 50.8,
    toil: 33.1,
    lastDate: '2026-07-29',
  }

  /**
   * Fails against the page as it stood: it passed `e(90).toilRatio`, so the gap
   * was 9.8 points and the panel read "proxy agrees within 9.8 points" — the
   * only falsification test on the page, resolved in favour of the page by the
   * choice of window.
   */
  it('checks the log against the 7-day proxy, not the 90-day baseline', () => {
    const html = renderDashboard(snapshot, sessions) as string
    expect(html).toContain('44.2%')
    expect(html).toContain('proxy is off by -11.1 points')
    expect(html).toContain('treat the headline with suspicion')
    expect(html).not.toContain('agrees within 9.8 points')
  })
})

describe('buildEntry', () => {
  const now = new Date('2026-07-27T18:00:00Z')

  it('records a session whose buckets account for the time', () => {
    const { entry, error } = buildEntry(
      { minutes: 180, delivery: 60, platform: 40, toil: 80, note: 'fan-in; lost an hour to CI' },
      now,
    )
    expect(error).toBeUndefined()
    expect(entry.date).toBe('2026-07-27')
    expect(entry.toil).toBe(80)
    expect(entry.note).toContain('lost an hour')
  })

  it('allows rounding slack, because these are estimates from memory', () => {
    expect(buildEntry({ minutes: 60, delivery: 30, toil: 25 }, now).error).toBeUndefined()
  })

  /**
   * A log that silently accepts a malformed row is worse than one that rejects
   * it: the aggregate then under-reports while looking complete.
   */
  it('rejects buckets that do not describe the session', () => {
    const { error } = buildEntry({ minutes: 180, delivery: 10 }, now)
    expect(error).toMatch(/roughly agree/)
  })

  it('rejects a session with no time allocated', () => {
    expect(buildEntry({ minutes: 90 }, now).error).toMatch(/allocate the time/)
  })

  it('rejects a missing or non-positive duration', () => {
    expect(buildEntry({ delivery: 30 }, now).error).toMatch(/positive/)
    expect(buildEntry({ minutes: -5, delivery: 30 }, now).error).toMatch(/positive/)
  })
})

describe('summariseSessions', () => {
  /**
   * The comparison the log exists for: this toilRatio is directly comparable
   * with the merge-derived one, so a persistent gap between them falsifies the
   * merge proxy rather than merely annotating it.
   */
  it('produces a toil ratio comparable with the merge-derived one', () => {
    const s = summariseSessions([
      { date: '2026-07-27', minutes: 100, delivery: 50, platform: 20, toil: 30 },
      { date: '2026-07-27', minutes: 100, delivery: 30, platform: 20, toil: 50 },
    ])
    expect(s.tasks).toBe(2)
    expect(s.hours).toBe(3.3)
    expect(s.delivery).toBe(40)
    expect(s.toilRatio).toBe(40)
  })

  /**
   * Entries are agent-effort minutes and are additive on purpose. Five sessions
   * working thirty minutes in parallel is 150 minutes of capacity spent, and the
   * merge proxy it is compared against also counts every agent's output. Logging
   * one person's wall-clock instead would compare one afternoon against five
   * parallel workers and make the proxy look wrong for the wrong reason.
   */
  it('adds effort across parallel sessions and counts distinct days', () => {
    const s = summariseSessions([
      { date: '2026-07-27', minutes: 30, delivery: 0, platform: 30, toil: 0 },
      { date: '2026-07-27', minutes: 30, delivery: 0, platform: 0, toil: 30 },
      { date: '2026-07-26', minutes: 60, delivery: 60, platform: 0, toil: 0 },
    ])
    expect(s.tasks).toBe(3)
    expect(s.days).toBe(2)
    expect(s.minutes).toBe(120)
    expect(s.toilRatio).toBe(25)
  })

  it('returns nulls rather than zeroes with nothing recorded', () => {
    const s = summariseSessions([])
    expect(s.tasks).toBe(0)
    expect(s.days).toBe(0)
    expect(s.toilRatio).toBeNull()
  })
})

describe('renderSessions', () => {
  /**
   * Absence of ground truth must be visible. If the panel rendered nothing when
   * no sessions exist, the inferred headline would look corroborated by
   * silence — which is the fail-open shape, applied to a whole methodology.
   */
  it('says plainly that the proxy is unvalidated when nothing is recorded', () => {
    const html = renderSessions(null, 43.4)
    expect(html).toContain('No sessions recorded')
    expect(html).toContain('practices-session.mjs')
  })

  it('confirms the proxy when wall-clock agrees', () => {
    const html = renderSessions(
      { sessions: 3, hours: 9, delivery: 40, platform: 20, toil: 40 },
      43.4,
    )
    expect(html).toContain('proxy agrees within 3.4 points')
  })

  it('warns when wall-clock contradicts the proxy', () => {
    const html = renderSessions(
      { sessions: 3, hours: 9, delivery: 20, platform: 10, toil: 70 },
      43.4,
    )
    expect(html).toContain('treat the headline with suspicion')
  })

  it('does not compare when the merge-derived figure is unmeasured', () => {
    const html = renderSessions(
      { sessions: 1, hours: 2, delivery: 50, platform: 25, toil: 25 },
      null,
    )
    expect(html).toContain('not comparable yet')
  })

  /**
   * The verdict is only readable if the window it was reached over is stated —
   * a comparison whose window is implicit is the one that got picked wrongly.
   */
  it('names the window it compared against, and the span of the log', () => {
    const html = renderSessions(
      { sessions: 34, tasks: 34, days: 2, hours: 86, delivery: 16.1, platform: 50.8, toil: 33.1 },
      44.2,
      7,
    )
    expect(html).toContain('over 7d')
    expect(html).toContain('over <strong class="num">2</strong> days')
  })
})

// @ts-expect-error -- plain .mjs, same arrangement as above.
import {
  analyse,
  extractRefs,
  extractRows,
  parseClasses,
  parseCost,
  parseStatus,
  mergeExtracted,
  orphanedRows,
  pairRows,
} from '../../../scripts/practices-evidence.mjs'

describe('extractRefs', () => {
  it('resolves a bare reference to the template', () => {
    expect(extractRefs('| [#591](x) | thing |')).toEqual(['keiranholloway/biffo-template#591'])
  })

  it('resolves a prefixed reference to its own repo', () => {
    expect(extractRefs('| [tabsii#252](x) |')).toEqual(['tabsii-com/tabsii-platform#252'])
    expect(extractRefs('| [biffo-runners#2](x) |')).toEqual(['keiranholloway/biffo-runners#2'])
  })

  it('keeps every distinct reference in order, deduplicated', () => {
    expect(extractRefs('#664 then #669 then #664 again')).toEqual([
      'keiranholloway/biffo-template#664',
      'keiranholloway/biffo-template#669',
    ])
  })
})

describe('parseClasses', () => {
  /**
   * Rows carry up to three tags, which is why the tag counts never summed to
   * the row count and why nothing could be ranked. The first tag is the shape
   * the author reached for first; the rest are kept, not discarded.
   */
  it('takes the first tag as primary and keeps the rest', () => {
    const { primary, secondary } = parseClasses('**fail-open** · visibility')
    expect(primary).toBe('fail-open')
    expect(secondary).toEqual(['visibility'])
  })

  it('reads tags in the order they appear, not the order they are defined', () => {
    expect(parseClasses('visibility · boundary').primary).toBe('visibility')
    expect(parseClasses('boundary · visibility').primary).toBe('boundary')
  })

  it('returns null for a cell naming no class', () => {
    expect(parseClasses('Meaning').primary).toBeNull()
  })
})

describe('parseCost', () => {
  it('reads a stated wall-clock cost in minutes', () => {
    expect(parseCost('cost **1h 44m** on one queued job')).toBe(104)
    expect(parseCost('cost 30m')).toBe(30)
  })

  /**
   * Absent cost is null, never zero. A defect nobody timed is not a free
   * defect, and averaging it in as one understates every ranking built on it.
   */
  it('returns null when the row states no cost', () => {
    expect(parseCost('a row with no cost figure at all')).toBeNull()
  })
})

describe('parseStatus', () => {
  it('prefers the more specific status', () => {
    expect(parseStatus('**fixed downstream** (idea-scout#15); skeleton **open**')).toBe(
      'fixed downstream',
    )
    expect(parseStatus('**partly fixed** — 1 residual')).toBe('partly fixed')
    expect(parseStatus('**open**')).toBe('open')
  })
})

describe('extractRows / analyse', () => {
  const table = [
    '| # | Failure condition | Class | Surfaced in | Fix lands in | Status |',
    '| --- | --- | --- | --- | --- | --- |',
    '| [#1](x) | a gate passes when it cannot run | **fail-open** · visibility | CI | template | **open** |',
    '| — | two ADRs claim one prefix | **boundary** | plugin | template | **unfiled** |',
    '| [#3](x) | truth not observable | visibility | instance | template | **fixed** |',
    '| — | masked error, no logs retained | visibility | CI | template | **unfiled** |',
  ].join('\n')

  it('parses each scoreboard row once, ignoring the header', () => {
    const rows = extractRows(table)
    expect(rows).toHaveLength(4)
    expect(rows[0].class).toBe('fail-open')
    expect(rows[0].alsoClass).toEqual(['visibility'])
    expect(rows[1].refs).toEqual([])
  })

  /**
   * The reason this file exists. The page asserted "fail-open is the dominant
   * shape" from a 5-row sample and never revised it; at 41 rows fail-open is
   * near the bottom. A generated analysis cannot disagree with its own rows.
   */
  it('derives the dominant class from the rows rather than asserting it', () => {
    const a = analyse(extractRows(table))
    expect(a.rows).toBe(4)
    expect(a.dominant).toBe('visibility')
    expect(a.dominantCount).toBe(2)
    expect(a.byClass['fail-open']).toBe(1)
  })

  it('reports cost and date coverage rather than implying completeness', () => {
    const a = analyse(extractRows(table))
    expect(a.coverage.withCost).toBe(0)
    expect(a.coverage.withDate).toBe(0)
    expect(a.coverage.costHours).toBeNull()
  })
})

describe('mergeExtracted — stored rows sharing a key must not collapse', () => {
  // The dataset has 19 ref-keys shared by more than one row: two distinct
  // findings both citing #669, for instance. The first orphan fix matched by
  // SET MEMBERSHIP, so a stored row counted as "represented" whenever ANY fresh
  // row shared one of its keys — and the second row with that key was neither
  // in `merged` (only fresh rows are) nor in the orphans. Against a pristine
  // checkout that silently deleted 326 -> 323.
  const A = {
    refs: ['o/r#1'],
    summary: 'first finding citing 1',
    date: '2026-01-01',
    costMinutes: 10,
  }
  const B = {
    refs: ['o/r#1'],
    summary: 'second finding citing 1',
    date: '2026-01-02',
    costMinutes: 20,
  }

  it('keeps the stored row the markdown no longer yields', () => {
    // Markdown now yields only ONE row carrying that ref.
    const fresh = [
      { refs: ['o/r#1'], summary: 'first finding citing 1', date: null, costMinutes: null },
    ]
    const merged = mergeExtracted(fresh, [A, B])
    expect(merged).toHaveLength(2)
    expect(merged.map((r) => r.summary)).toContain('second finding citing 1')
  })

  it('never loses a row: output is at least as large as the stored input', () => {
    const fresh = [{ refs: ['o/r#1'], summary: 'only one now', date: null, costMinutes: null }]
    expect(mergeExtracted(fresh, [A, B]).length).toBeGreaterThanOrEqual(2)
  })

  it('pairs one-to-one rather than by set membership', () => {
    const fresh = [
      { refs: ['o/r#1'], summary: 'first finding citing 1', date: null, costMinutes: null },
      { refs: ['o/r#1'], summary: 'second finding citing 1', date: null, costMinutes: null },
    ]
    const { pairs, orphans } = pairRows(fresh, [A, B])
    expect(pairs.size).toBe(2)
    expect(orphans).toHaveLength(0)
    // Each fresh row claimed a DIFFERENT stored row.
    expect(new Set([pairs.get(0), pairs.get(1)]).size).toBe(2)
  })

  it('still enriches from the row it claimed', () => {
    const fresh = [
      { refs: ['o/r#1'], summary: 'first finding citing 1', date: null, costMinutes: null },
    ]
    const merged = mergeExtracted(fresh, [A])
    expect(merged[0].date).toBe('2026-01-01')
    expect(merged[0].costMinutes).toBe(10)
  })
})

describe('mergeExtracted', () => {
  /**
   * Re-extracting after adding one row must not discard the dates recovered for
   * the other forty — each cost an API call, and the analysis would quietly
   * report worse coverage than it actually has.
   */
  it('carries forward a recovered date the markdown cannot state', () => {
    const merged = mergeExtracted(
      [{ summary: 'a gate passes when it cannot run', date: null, costMinutes: null }],
      [{ summary: 'a gate passes when it cannot run', date: '2026-07-14', costMinutes: 104 }],
    )
    expect(merged[0].date).toBe('2026-07-14')
    expect(merged[0].costMinutes).toBe(104)
  })

  it('lets the markdown win where it does state a value', () => {
    const merged = mergeExtracted(
      [{ summary: 'x', date: null, costMinutes: 30 }],
      [{ summary: 'x', date: '2026-07-01', costMinutes: 999 }],
    )
    expect(merged[0].costMinutes).toBe(30)
  })

  it('leaves a genuinely new row untouched', () => {
    const merged = mergeExtracted([{ summary: 'brand new', date: null, costMinutes: null }], [])
    expect(merged[0].date).toBeNull()
  })

  /**
   * The destructive case, which was untested and fired.
   *
   * `--extract` treats the markdown as the source of truth. Run from a branch
   * whose markdown predates another session's rows, the old implementation
   * (`return fresh.map(...)`) rewrote evidence.jsonl *without* them — silently,
   * because the only symptom is that the counts it feeds get smaller. On
   * 2026-07-27 that removed 18 scoreboard rows and 23 narrative entries
   * contributed by three different sessions.
   *
   * Deleting a row is legitimate; doing it by accident is not. So an orphan is
   * kept, and the CLI says so.
   */
  it('keeps a stored row the markdown no longer mentions', () => {
    const merged = mergeExtracted(
      [{ summary: 'still in the table', date: null, costMinutes: null }],
      [
        { summary: 'still in the table', date: '2026-07-01', costMinutes: null },
        { summary: 'another session added this an hour ago', date: '2026-07-27', costMinutes: 40 },
      ],
    )

    expect(merged.map((r) => r.summary)).toContain('another session added this an hour ago')
    expect(merged).toHaveLength(2)
  })

  /**
   * Rewording must not read as delete-plus-add.
   *
   * Keeping orphans stopped three sessions' work disappearing, and immediately
   * cost the opposite failure: matching on raw summary text meant editing a
   * row's prose left the old wording behind as a duplicate, inflating every
   * count derived from the dataset. This is the real case that appeared within
   * a day — a single word wrapped in emphasis.
   */
  it('treats a row reworded only in formatting as the same row', () => {
    const before = {
      summary: 'the snapshot files it commits also exist on dev',
      refs: [],
      date: '2026-07-27',
      costMinutes: 40,
    }
    const after = {
      summary: 'the snapshot files it commits *also* exist on dev',
      refs: [],
      date: null,
      costMinutes: null,
    }

    const merged = mergeExtracted([after], [before])

    expect(merged).toHaveLength(1)
    // And the enrichment survives the rewording, which is the whole point of
    // matching at all.
    expect(merged[0].date).toBe('2026-07-27')
    expect(merged[0].costMinutes).toBe(40)
  })

  it('treats a substantively rewritten row as the same row when it cites the same issue', () => {
    // refs are the closest thing to a real id the table has, and survive a
    // rewrite that shares no wording at all.
    const merged = mergeExtracted(
      [{ summary: 'completely rewritten explanation', refs: ['owner/repo#714'], date: null }],
      [{ summary: 'the original wording', refs: ['owner/repo#714'], date: '2026-07-01' }],
    )

    expect(merged).toHaveLength(1)
    expect(merged[0].date).toBe('2026-07-01')
  })

  it('still orphans a row that is genuinely gone', () => {
    // The protection must not become "never lose anything", or a deliberate
    // deletion could never happen.
    const orphans = orphanedRows(
      [{ summary: 'a row that is still in the table', refs: [] }],
      [
        { summary: 'a row that is still in the table', refs: [] },
        { summary: 'a row deleted on purpose', refs: [] },
      ],
    )

    expect(orphans.map((r) => r.summary)).toEqual(['a row deleted on purpose'])
  })

  it('reports which rows were orphaned, so a real deletion stays deliberate', () => {
    const orphans = orphanedRows(
      [{ summary: 'kept', date: null, costMinutes: null }],
      [
        { summary: 'kept', date: null, costMinutes: null },
        { summary: 'dropped from the table', date: null, costMinutes: null },
      ],
    )

    expect(orphans.map((r) => r.summary)).toEqual(['dropped from the table'])
  })
})

describe('daysSince / nudge', () => {
  const now = new Date('2026-07-27T09:00:00Z')

  it('measures staleness in whole days', () => {
    expect(daysSince('2026-07-27', now)).toBe(0)
    expect(daysSince('2026-07-20', now)).toBe(7)
  })

  it('returns null rather than 0 when nothing was ever recorded', () => {
    expect(daysSince(null, now)).toBeNull()
  })

  /**
   * The empty case has to say what it is protecting. A reminder that only nags
   * gets ignored, and then the thing it guards silently stops happening — which
   * is exactly how a documented worktree-hygiene rule left nine orphans behind.
   */
  it('explains the consequence when nothing has ever been logged', () => {
    const m = nudge({ sessions: 0, lastDate: null }, 3, now)
    expect(m).toContain('unvalidated inference')
    expect(m).toContain('practices-session.mjs')
  })

  it('stays silent while the log is fresh', () => {
    expect(nudge({ sessions: 4, lastDate: '2026-07-26' }, 3, now)).toBeNull()
  })

  it('nudges once the log goes stale, naming the gap', () => {
    const m = nudge({ sessions: 4, lastDate: '2026-07-20' }, 3, now)
    expect(m).toContain('7 days ago')
    expect(m).toContain('4 recorded so far')
  })
})

describe('timeToFeature (#767)', () => {
  const ref = (owner: string, name: string, number: number) => ({
    number,
    repository: { name, owner: { login: owner } },
  })
  const opened = new Map([
    ['acme/app#1', '2026-07-01T00:00:00Z'],
    ['acme/tmpl#9', '2026-07-20T00:00:00Z'],
  ])

  it('measures issue opened to closing PR merged, in hours', () => {
    const prs = [
      { mergedAt: '2026-07-03T00:00:00Z', closingIssuesReferences: [ref('acme', 'app', 1)] },
    ]
    expect(timeToFeature(prs, opened)).toMatchObject({ linked: 1, hoursP50: 48, hoursMax: 48 })
  })

  it('resolves an issue closed from a DIFFERENT repo', () => {
    // An instance PR closing a template issue is the routine case here, and a
    // per-repo index would report every one of them as unresolved — losing the
    // cross-repo distribution latency this metric most needs to see.
    const prs = [
      { mergedAt: '2026-07-21T00:00:00Z', closingIssuesReferences: [ref('acme', 'tmpl', 9)] },
    ]
    expect(timeToFeature(prs, opened)).toMatchObject({ linked: 1, unresolved: 0, hoursP50: 24 })
  })

  it('counts an unresolvable reference rather than dropping or zeroing it', () => {
    const prs = [
      { mergedAt: '2026-07-22T00:00:00Z', closingIssuesReferences: [ref('acme', 'app', 999)] },
    ]
    expect(timeToFeature(prs, opened)).toMatchObject({ linked: 0, unresolved: 1, hoursP50: null })
  })

  it('treats a PR merged BEFORE its issue was opened as unresolved, not instant', () => {
    // A negative duration is a mislinked reference, not a fast feature. Letting
    // it through would drag the median toward zero and read as an improvement.
    const prs = [
      { mergedAt: '2026-06-01T00:00:00Z', closingIssuesReferences: [ref('acme', 'app', 1)] },
    ]
    expect(timeToFeature(prs, opened)).toMatchObject({ linked: 0, unresolved: 1, hoursP50: null })
  })

  it('reports coverage, so a p50 over few merges cannot read as the whole estate', () => {
    const prs = [
      { mergedAt: '2026-07-03T00:00:00Z', closingIssuesReferences: [ref('acme', 'app', 1)] },
      { mergedAt: '2026-07-23T00:00:00Z', closingIssuesReferences: [] },
      { mergedAt: '2026-07-24T00:00:00Z', closingIssuesReferences: [] },
    ]
    const out = timeToFeature(prs, opened)
    expect(out.coverage).toBe(33.3)
    expect(out.prsWithNoClosingIssue).toBe(2)
  })

  it('returns null, never 0, when nothing could be measured', () => {
    expect(timeToFeature([], opened)).toMatchObject({
      coverage: null,
      hoursP50: null,
      hoursP90: null,
      hoursMax: null,
    })
  })
})

describe('time-to-running, stop B (#767)', () => {
  const run = (
    name: string,
    branch: string,
    conclusion: string,
    created: string,
    updated: string,
  ) => ({
    name,
    head_branch: branch,
    event: 'push',
    conclusion,
    created_at: created,
    updated_at: updated,
  })

  it('measures completion, not trigger — a deploy is not free', () => {
    // The bug this pins: matching and measuring both on created_at reports a
    // ~0 gap for every deploy, because a push-triggered run starts seconds
    // after the merge however long it then takes.
    const deploys = successfulDeploys(
      [run('Deploy Application', 'dev', 'success', '2026-07-01T10:00:00Z', '2026-07-01T10:18:00Z')],
      'dev',
    )
    expect(firstDeployAfter(deploys, '2026-07-01T09:59:00Z')).toBe(
      Date.parse('2026-07-01T10:18:00Z'),
    )
  })

  it('ignores a deploy that started BEFORE the merge — it cannot contain it', () => {
    const deploys = successfulDeploys(
      [run('Deploy Application', 'dev', 'success', '2026-07-01T09:00:00Z', '2026-07-01T09:10:00Z')],
      'dev',
    )
    expect(firstDeployAfter(deploys, '2026-07-01T10:00:00Z')).toBeNull()
  })

  it('skips a failed deploy and takes the next success', () => {
    const deploys = successfulDeploys(
      [
        run('Deploy Application', 'dev', 'failure', '2026-07-01T10:05:00Z', '2026-07-01T10:07:00Z'),
        run('Deploy Application', 'dev', 'success', '2026-07-01T10:30:00Z', '2026-07-01T10:40:00Z'),
      ],
      'dev',
    )
    expect(firstDeployAfter(deploys, '2026-07-01T10:00:00Z')).toBe(
      Date.parse('2026-07-01T10:40:00Z'),
    )
  })

  it('ignores other workflows and other branches', () => {
    const runs = [
      run('CI', 'dev', 'success', '2026-07-01T10:05:00Z', '2026-07-01T10:08:00Z'),
      run(
        'Deploy Application',
        'staging',
        'success',
        '2026-07-01T10:05:00Z',
        '2026-07-01T10:08:00Z',
      ),
    ]
    expect(successfulDeploys(runs, 'dev')).toEqual([])
  })

  it('counts a merged-but-undeployed issue as awaiting, never as instant', () => {
    const opened = new Map([['acme/app#1', '2026-07-01T00:00:00Z']])
    const prs = [
      {
        mergedAt: '2026-07-01T10:00:00Z',
        closingIssuesReferences: [
          { number: 1, repository: { name: 'app', owner: { login: 'acme' } } },
        ],
      },
    ]
    const out = timeToFeature(prs, opened, [])
    expect(out.linked).toBe(1)
    expect(out.running).toMatchObject({
      measured: 0,
      awaitingDeploy: 1,
      hoursP50: null,
      deployGapP50: null,
    })
  })

  it('reports running and the merge-to-running gap separately', () => {
    const opened = new Map([['acme/app#1', '2026-07-01T00:00:00Z']])
    const prs = [
      {
        mergedAt: '2026-07-01T10:00:00Z',
        closingIssuesReferences: [
          { number: 1, repository: { name: 'app', owner: { login: 'acme' } } },
        ],
      },
    ]
    const deploys = successfulDeploys(
      [run('Deploy Application', 'dev', 'success', '2026-07-01T10:01:00Z', '2026-07-01T10:31:00Z')],
      'dev',
    )
    const out = timeToFeature(prs, opened, deploys)
    expect(out.hoursP50).toBe(10) // opened -> merged
    expect(out.running.hoursP50).toBe(10.5) // opened -> running
    expect(out.running.deployGapP50).toBe(0.5) // merged -> running
  })
})

describe('cross-repo time-to-feature (#767)', () => {
  const marker = (ns: string) =>
    `Automated core upgrade.\n\n<!-- biffo:carries-template-prs:${ns} -->\n`
  const tmplPr = (n: number, issue?: number) => ({
    number: n,
    closingIssuesReferences: issue
      ? [{ number: issue, repository: { name: 'biffo-template', owner: { login: 'acme' } } }]
      : [],
  })
  const idx = () =>
    indexClosingIssues('acme/biffo-template', [tmplPr(746, 696), tmplPr(747, 735), tmplPr(770)])
  const opened = new Map([
    ['acme/biffo-template#696', '2026-07-27T12:00:00Z'],
    ['acme/biffo-template#735', '2026-07-27T18:00:00Z'],
  ])
  const deploys = [
    {
      startedAt: Date.parse('2026-07-28T10:05:00Z'),
      finishedAt: Date.parse('2026-07-28T10:20:00Z'),
    },
  ]
  const upgradePr = (body: string) => ({
    headRefName: 'biffo/core-upgrade-0.152.0-to-0.155.0',
    mergedAt: '2026-07-28T10:00:00Z',
    body,
  })

  it('parses the marker', () => {
    expect(parseCarriedPrs(marker('746,747,770'))).toEqual([746, 747, 770])
    expect(parseCarriedPrs('no marker here')).toEqual([])
    expect(parseCarriedPrs(null)).toEqual([])
  })

  it('round-trips a wrapped, multi-line marker (#1198)', () => {
    // `carriedPrsSection` used to emit the whole PR list on one line, which
    // crossed commitlint's 100-character body limit at roughly 13 carried PRs
    // and made `--apply` unable to commit its own upgrade (#1198). It now
    // repeats the full marker once per line, chunked to fit. This proves the
    // reader recovers exactly the writer's PR list once that wrapping is in
    // play — not just that each side works in isolation.
    const carried = Array.from({ length: 99 }, (_, i) => i + 1)
    const section = carriedPrsSection(carried)
    const markerLines = section.filter((l: string) => l.startsWith('<!--'))
    expect(markerLines.length).toBeGreaterThan(1) // else the fixture proves nothing
    for (const line of markerLines) {
      expect(line.length).toBeLessThanOrEqual(100)
    }

    const body = `Automated core upgrade.\n\n${section.join('\n')}\n`
    expect(parseCarriedPrs(body)).toEqual(carried)

    // The #1011 fallback path too: the same wrapped marker embedded in a
    // commit message rather than a PR body.
    const commits = [
      {
        messageHeadline: 'chore(core): upgrade template core 0.204.3 -> 0.228.5',
        messageBody: section.join('\n'),
      },
    ]
    expect(parseCarriedPrs(undefined, commits)).toEqual(carried)
  })

  it('falls back to a commit message when the PR body has no marker (#1011)', () => {
    // `--apply` can commit and then fail at the push step, aborting before it
    // ever opens a PR. The operator pushes and opens the PR by hand, so the
    // body never gets the marker `buildPrBody` would have written — but the
    // commit made before that failed push still carries it, and `core-upgrade`
    // now writes it there too. `gh pr list --json commits` is how the
    // collector sees it.
    const commits = [{ messageHeadline: 'chore(core): upgrade template core 0.1.0 -> 0.2.0' }]
    expect(parseCarriedPrs(undefined, commits)).toEqual([])

    const withBody = [
      {
        messageHeadline: 'chore(core): upgrade template core 0.1.0 -> 0.2.0',
        messageBody: marker('746,747'),
      },
    ]
    expect(parseCarriedPrs(null, withBody)).toEqual([746, 747])
    // A hand-created PR has no body at all, not merely an empty string.
    expect(parseCarriedPrs(undefined, withBody)).toEqual([746, 747])
  })

  it('prefers the PR body over commits when both are present', () => {
    // A tool-created PR always has both — the marker was written to the commit
    // first, then the same value into the PR body. Nothing should change for
    // it: this path must never even look at commits when the body already
    // answers.
    const commits = [{ messageBody: marker('9999') }]
    expect(parseCarriedPrs(marker('746,747'), commits)).toEqual([746, 747])
  })

  it('IGNORES a PR that merely documents the marker', () => {
    // Fired on the very first real run: biffo-template reported an upgrade PR
    // carrying four template PRs, which is impossible — the template does not
    // upgrade itself. The marker had been matched inside PR #772's own body,
    // where it appears as documentation of the format. The branch name is the
    // discriminator because only the CLI creates it.
    const documenting = {
      headRefName: 'feat/time-to-running',
      mergedAt: '2026-07-28T10:00:00Z',
      body: marker('746,747'),
    }
    expect(isUpgradePr(documenting)).toBe(false)
    expect(crossRepoTimeToFeature([documenting], idx(), opened, deploys)).toMatchObject({
      upgradePrs: 0,
      carriedPrs: 0,
      measured: 0,
    })
  })

  it('measures template issue opened → running in the instance', () => {
    const out = crossRepoTimeToFeature([upgradePr(marker('746,747'))], idx(), opened, deploys)
    expect(out).toMatchObject({ upgradePrs: 1, carriedPrs: 2, measured: 2, carriedWithoutIssue: 0 })
    // #696 opened 12:00 on the 27th, running 10:20 on the 28th = 22.3h
    expect(out.hoursMax).toBe(22.3)
  })

  it('counts a carried PR that closes no issue, rather than hiding it', () => {
    // The binding constraint on this metric, and it must be visible: the first
    // marker ever emitted carried 12 PRs and every one used `Refs #N`.
    const out = crossRepoTimeToFeature([upgradePr(marker('770'))], idx(), opened, deploys)
    expect(out).toMatchObject({
      carriedPrs: 1,
      carriedWithoutIssue: 1,
      measured: 0,
      hoursP50: null,
    })
  })

  it('counts an upgrade merged but not yet deployed as awaiting, not instant', () => {
    const out = crossRepoTimeToFeature([upgradePr(marker('746'))], idx(), opened, [])
    expect(out).toMatchObject({ awaitingDeploy: 1, measured: 0, hoursP50: null })
  })

  it('reports an EMPTY template index as unattributable, never as "closed no issue"', () => {
    // The defect this pins cost two triages. `closingIssues` is built from the
    // TEMPLATE repo's PRs; `--repo <instance>` filtered the fetch to the
    // instance, so that map was empty and every carried PR fell through to
    // `carriedWithoutIssue`. The metric then read "12 PRs carried, none closed an
    // issue, measured 0" when the truth was "I never loaded the side of the join
    // that would know". #776's own verification command was the one that could
    // not work, and it was quoted as evidence the metric was unproven.
    const out = crossRepoTimeToFeature(
      [upgradePr(marker('746,747,770'))],
      new Map(), // nothing fetched from the template
      opened,
      deploys,
    )
    expect(out).toMatchObject({
      carriedPrs: 3,
      unattributable: 3,
      carriedWithoutIssue: 0, // NOT 3 — there is no basis for that claim
      measured: 0,
      hoursP50: null,
    })
  })

  it('does not report unattributable when the index is present but the PR closes nothing', () => {
    // The counterpart: a real "closed no issue" must stay distinguishable from
    // "could not look". Same call, populated index — #770 genuinely closes none.
    const out = crossRepoTimeToFeature([upgradePr(marker('770'))], idx(), opened, deploys)
    expect(out).toMatchObject({
      carriedPrs: 1,
      carriedWithoutIssue: 1,
      unattributable: 0,
    })
  })
})

describe('estate headline is capability, not the proving ground (#768)', () => {
  const repo = (side: string, merges: number, delivery: number, productDelivery: number) => ({
    workMix: {
      merges,
      counts: { delivery, rework: 0, toil: 0, quality: 0, docs: merges - delivery },
      sideCounts: {
        platform: side === 'platform' ? merges : 0,
        product: side === 'product' ? merges : 0,
      },
      productDelivery,
    },
    contention: { greenButUnmergedHours: 0 },
  })

  it('counts capability built ANYWHERE, split by family', () => {
    // The bug this replaces: the headline was Tabsii's delivery over ALL merges,
    // so the same day read 6.7% instead of 32.9% — a 5x difference decided
    // purely by which repo family is called "the product". Under the north star
    // Biffo IS the product and Tabsii is the proving ground.
    const out = summariseEstate({
      biffo: repo('platform', 100, 30, 0),
      tabsii: repo('product', 100, 10, 10),
    })
    expect(out.capabilityShare).toBe(20) // 40 of 200
    expect(out.capabilityBySide.platform).toEqual({ merges: 30, share: 15 })
    expect(out.capabilityBySide.product).toEqual({ merges: 10, share: 5 })
  })

  it('keeps the old number under an honest name', () => {
    const out = summariseEstate({
      biffo: repo('platform', 100, 30, 0),
      tabsii: repo('product', 100, 10, 10),
    })
    // Same arithmetic as the retired productFeatureShare — only the label was wrong.
    expect(out.tabsiiCapabilityShare).toBe(5)
    expect('productFeatureShare' in out).toBe(false)
  })

  it('reports null, not 0, when nothing is measurable', () => {
    const out = summariseEstate({})
    expect(out.capabilityShare).toBeNull()
    expect(out.tabsiiCapabilityShare).toBeNull()
  })
})

// @ts-expect-error -- plain .mjs, same arrangement as above.
import {
  tallyMarkdown,
  classMarkdown,
  renderTallies,
  spliceTally,
  TALLY_BEGIN,
  TALLY_END,
  CLASS_BEGIN,
  CLASS_END,
  REPO_NOTES,
} from '../../../scripts/practices-evidence.mjs'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The repo root, resolved from this file rather than from `process.cwd()`.
 *
 * vitest runs with cwd at `cli/`, so a relative `docs/...` would silently read
 * nothing and the assertions below would pass against an empty string — a
 * fail-open in the very guard written to close one.
 */
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const readRepo = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8')

describe('fix-repo tally is generated, not transcribed', () => {
  const rows = readRepo('docs/practices/evidence.jsonl')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))

  it('reads a non-empty dataset', () => {
    // Guards the guard: every assertion below is vacuously true against [].
    expect(rows.length).toBeGreaterThan(100)
  })

  it('generates from the dataset without throwing, which is what is worth asserting', () => {
    // Replaced "matches what is committed in the page" (#953). The tally is no
    // longer committed: it was regenerated from the full dataset on every
    // append, so any two concurrent practices PRs conflicted by construction,
    // always inside the generated block. The property worth guarding was never
    // "the committed copy is fresh" — it was "the dataset still produces a
    // report", which is this.
    const block = tallyMarkdown(rows)
    expect(block).toContain(TALLY_BEGIN)
    expect(block).toContain(TALLY_END)
    expect(block).toMatch(/\| \*\*biffo-template\*\* \|/)
  })

  it('commits NO derived counts in the page — the whole point of #953', () => {
    // The regression that matters now is the opposite of the old one: someone
    // re-splicing a generated table back into the committed page reinstates the
    // conflict. A number inside the markers is the tell.
    const page = readRepo('docs/guides/development-practices.md')
    for (const [begin, end] of [
      [TALLY_BEGIN, TALLY_END],
      [CLASS_BEGIN, CLASS_END],
    ]) {
      const start = page.indexOf(begin)
      const stop = page.indexOf(end)
      expect(start, `${begin} missing from the page`).toBeGreaterThan(-1)
      const region = page.slice(start, stop)
      expect(
        region,
        `${begin} contains a generated table row again — that reinstates the ` +
          'conflict #953 removed. Tallies belong in docs/practices/tallies.generated.md.',
      ).not.toMatch(/^\|.*\d+ of \d+/m)
    }
  })

  it('appears exactly once — a second copy is the failure this replaced', () => {
    const page = readRepo('docs/guides/development-practices.md')
    expect(page.split(TALLY_BEGIN).length - 1).toBe(1)
    expect(page.split(TALLY_END).length - 1).toBe(1)
  })

  it('quotes one denominator, on every row', () => {
    const block = tallyMarkdown(rows)
    const denominators = new Set([...block.matchAll(/\d+ of (\d+)/g)].map((m) => m[1]))
    // The four hand-typed copies quoted 99, 210, 236 and 248 simultaneously.
    expect([...denominators]).toEqual([String(rows.length)])
  })

  it('names every repo it counts', () => {
    // A repo with no note still gets a row; this catches the reverse — a note
    // for a repo the tally no longer knows about, which reads as coverage.
    const block = tallyMarkdown(rows)
    for (const repo of Object.keys(REPO_NOTES)) {
      expect(block, `${repo} has a note but no row`).toContain(`**${repo}**`)
    }
  })

  it('refuses to append when the markers are missing', () => {
    // Appending a second table silently is exactly how the page grew four.
    expect(() => spliceTally('# a page with no markers\n', 'block')).toThrow(/markers not found/)
  })

  it('replaces the block rather than duplicating it', () => {
    const page = `before\n${TALLY_BEGIN}\nold\n${TALLY_END}\nafter`
    const out = spliceTally(page, `${TALLY_BEGIN}\nnew\n${TALLY_END}`)
    expect(out).toBe(`before\n${TALLY_BEGIN}\nnew\n${TALLY_END}\nafter`)
    expect(out).not.toContain('old')
  })
})

describe('class tally is generated, not transcribed', () => {
  const rows = readRepo('docs/practices/evidence.jsonl')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))

  it('generates from the dataset without throwing (#953 — no longer committed)', () => {
    const block = classMarkdown(rows)
    expect(block).toContain(CLASS_BEGIN)
    expect(block).toContain(CLASS_END)
    // The ranking is the finding, so assert it is actually ordered rather than
    // just present — an unsorted tally is the one wrong answer that matters.
    const counts = [...block.matchAll(/\| (\d+) \| \d+% \|/g)].map((m) => Number(m[1]))
    expect(counts.length).toBeGreaterThan(2)
    expect([...counts].sort((a, b) => b - a)).toEqual(counts)
  })

  it('appears exactly once', () => {
    const page = readRepo('docs/guides/development-practices.md')
    expect(page.split(CLASS_BEGIN).length - 1).toBe(1)
  })

  it('is ordered by count, because the ranking is the finding', () => {
    // The committed table ranked boundary above process; the data has it the
    // other way. A tally fixed to the CLASSES order would have hidden that.
    const counts = [...classMarkdown(rows).matchAll(/^\| \*?\*?([a-z-]+)\*?\*? \| (\d+) \|/gm)].map(
      (m) => Number(m[2]),
    )
    expect(counts.length).toBe(5)
    expect([...counts].sort((a, b) => b - a)).toEqual(counts)
  })

  it('counts every classified row exactly once', () => {
    // Guards against a class silently vanishing from CLASSES: the block's own
    // total must equal the number of rows carrying a known class.
    const known = rows.filter((r) =>
      ['fail-open', 'boundary', 'drift', 'visibility', 'process'].includes(r.class),
    )
    const block = classMarkdown(rows)
    const total = Number(/\*\*(\d+)\*\* classified rows/.exec(block)![1])
    expect(total).toBe(known.length)
  })

  it('--write renders both blocks into one generated file, never one', () => {
    // Emitting them in separate runs is how one ends up current and the other
    // stale. Still true after #953 moved them out of the committed page --
    // the destination changed, the one-pass requirement did not.
    const file = renderTallies(tallyMarkdown(rows), classMarkdown(rows))
    expect(file).toContain(TALLY_BEGIN)
    expect(file).toContain(CLASS_BEGIN)
    expect(file).toContain(tallyMarkdown(rows))
    expect(file).toContain(classMarkdown(rows))
    // Says what it is: a git-ignored file has no history to explain itself.
    expect(file).toMatch(/GENERATED FILE/)
  })

  it('refuses to append when its own markers are missing', () => {
    expect(() => spliceTally('# no markers\n', 'b', CLASS_BEGIN, CLASS_END)).toThrow(
      /markers not found/,
    )
  })
})

// ---------------------------------------------------------------------------
// H4/H5 gate metrics (#914)
//
// Every step name asserted below is one the estate really produced -- taken from
// the 154 failing steps across 12 repos in the 7 days to 2026-07-30, not
// invented. A classifier tested against imagined names would pass while
// mis-reading production, which is the whole failure mode this metric replaces.
// ---------------------------------------------------------------------------

describe('classifyFailingStep', () => {
  it('classifies the checks a local gate could run', () => {
    for (const [name, kind] of [
      ['Test', 'test'],
      ['Format check', 'format'],
      ['Type check', 'typecheck'],
      ['Lint', 'lint'],
      ['RLS-dependent tests', 'rls-test'],
      ['Core ownership guard', 'ownership'],
      ['Practices corpus is append-only', 'corpus-guard'],
      ['Validate modules', 'terraform-validate'],
      ['SAST (Bandit)', 'sast'],
      ['gitleaks git history scan', 'gitleaks'],
      ['Destructive-plan guard', 'destructive-plan'],
      ['Plugin Terraform guard', 'plugin-terraform'],
      // Both run a script that is deterministic, offline and seconds long:
      // `uv run python scripts/error_branch_coverage.py --check` and
      // `sh scripts/biffo.sh check adr-numbering`. Classified from what the
      // step RUNS, not from its name (#1167).
      ['Error-branch coverage', 'coverage'],
      ['ADR numbering guard', 'adr-guard'],
    ] as const) {
      expect(classifyFailingStep(name), name).toEqual({ kind, catchable: true })
    }
  })

  it('classifies what no local check could have caught', () => {
    for (const [name, kind] of [
      ['Publish', 'publish'],
      ['Sync and audit core-v<version>', 'publish'],
      ['Dependency audit', 'dependency-audit'],
      ['Set up Python', 'setup'],
      // Deterministic and offline, but minutes not seconds — fails the third
      // limb of H4's criterion, and excluded by name in local-gates.md.
      ['Build portal', 'build'],
      ['Apply the tabsii schema', 'deploy'],
      ['Build and deploy plugin frontends', 'deploy'],
      ['Run terraform apply -input=false -auto-approve', 'deploy'],
      ['Run sh scripts/biffo.sh check release-subject', 'release-subject'],
      // Every one of these invokes AWS against a live environment — two
      // `aws lambda invoke`s and an `aws s3 sync` — so no offline check
      // reproduces them (#1167).
      ['Apply DDL imports', 'schema-apply'],
      ['Initialise database schema', 'schema-apply'],
      ['Sync portal to S3', 'deploy'],
      // Needs a token and the network, unlike the coverage CHECK above it.
      ['Coverage upload', 'coverage-upload'],
    ] as const) {
      expect(classifyFailingStep(name), name).toEqual({ kind, catchable: false })
    }
  })

  it('reads an unnamed step, which arrives as "Run <command>"', () => {
    expect(classifyFailingStep('Run pnpm run test')).toEqual({ kind: 'test', catchable: true })
    expect(classifyFailingStep('Run terraform -chdir=terraform fmt -check -recursive')).toEqual({
      kind: 'terraform-fmt',
      catchable: true,
    })
  })

  it('does not let a generic word outrank the specific step it appears in', () => {
    // Each of these matches an earlier-or-later pattern it must not be assigned
    // to. Order in STEP_KINDS is load-bearing; this is the test that fails if it
    // gets reordered.
    expect(classifyFailingStep('Build and deploy plugin frontends').kind).toBe('deploy')
    expect(classifyFailingStep('Sync and audit core-v<version>').kind).toBe('publish')
    expect(classifyFailingStep('RLS-dependent tests').kind).toBe('rls-test')
    // "Build portal" contains neither, but plain `build` must not fall through
    // to the generic `test`/`lint` patterns either.
    expect(classifyFailingStep('Build portal').kind).toBe('build')
  })

  it('returns null -- not false -- for a step it has never seen', () => {
    // A default of `false` would improve the headline every time CI grew a step
    // this file does not know, i.e. the metric would get better by going blind.
    expect(classifyFailingStep('Summon a badger')).toEqual({
      kind: 'unclassified',
      catchable: null,
    })
  })
})

describe('summariseGates', () => {
  it('computes the share over classified steps only', () => {
    const result = summariseGates([
      { name: 'Test' },
      { name: 'Lint' },
      { name: 'Format check' },
      { name: 'Publish' },
      { name: 'Summon a badger' },
    ])
    expect(result.failingSteps).toBe(5)
    expect(result.locallyCatchable).toBe(3)
    expect(result.notLocallyCatchable).toBe(1)
    expect(result.unclassified).toBe(1)
    // 3 of 4 classified -- the unclassified step is in neither side of the ratio.
    expect(result.share).toBe(75)
  })

  it('breaks the headline down by kind so it can be argued with', () => {
    const result = summariseGates([{ name: 'Test' }, { name: 'Test' }, { name: 'Lint' }])
    expect(result.byKind).toEqual({ test: 2, lint: 1 })
  })

  it('returns a null share for no steps, not a clean 0%', () => {
    const result = summariseGates([])
    expect(result.failingSteps).toBe(0)
    expect(result.share).toBeNull()
  })

  it('records WHICH step names it could not classify, with their counts', () => {
    // A bare `unclassified: 12` says the metric went blind but not to what, so
    // the fix needs a human to go and re-derive the names from the jobs API --
    // which is exactly the step nobody took for the fortnight this shipped
    // (#1167). Most-frequent first: that is the pattern worth writing.
    const result = summariseGates([
      { name: 'Summon a badger' },
      { name: 'Summon a badger' },
      { name: 'Feed the badger' },
      { name: 'Test' },
    ])
    expect(result.unclassifiedNames).toEqual([
      { name: 'Summon a badger', count: 2 },
      { name: 'Feed the badger', count: 1 },
    ])
  })
})

describe('gatesForWindow', () => {
  const steps = {
    coveredSince: '2026-07-16T00:00:00.000Z',
    failing: [{ name: 'Test', at: Date.parse('2026-07-20T00:00:00Z') }],
  }

  it('measures a window inside the fetch', () => {
    expect(gatesForWindow(steps, '2026-07-23T00:00:00.000Z').share).toBe(100)
  })

  it('refuses a window that reaches back further than the fetch', () => {
    // The 90d window over a 14d jobs fetch. Reporting the fortnight's share as
    // the quarter's would be a partial masquerading as a whole.
    const result = gatesForWindow(steps, '2026-05-01T00:00:00.000Z')
    expect(result.error).toBe('unmeasured')
    expect(result.coveredSince).toBe(steps.coveredSince)
    expect(result.share).toBeUndefined()
  })

  it('reports unmeasured when no jobs were fetched at all', () => {
    expect(gatesForWindow(null, '2026-07-23T00:00:00.000Z').error).toBe('unmeasured')
  })
})

describe('aggregateGates', () => {
  it('recomputes the share from summed counts, not by averaging percentages', () => {
    const repos = {
      big: { gates: summariseGates(Array.from({ length: 80 }, () => ({ name: 'Test' }))) },
      small: { gates: summariseGates([{ name: 'Publish' }]) },
    }
    const result = aggregateGates(repos)
    expect(result.repos).toBe(2)
    expect(result.failingSteps).toBe(81)
    // Averaging the two repo shares would give 50%. Weighting by steps is 98.8%.
    expect(result.share).toBe(98.8)
  })

  it('excludes an unmeasured repo rather than letting it contribute a zero', () => {
    const repos = {
      measured: { gates: summariseGates([{ name: 'Test' }]) },
      blind: { gates: { error: 'unmeasured' } },
      broken: { error: 'unmeasured' },
    }
    const result = aggregateGates(repos)
    expect(result.repos).toBe(1)
    expect(result.share).toBe(100)
  })

  it('reports a null share when nothing was measured', () => {
    expect(aggregateGates({ blind: { gates: { error: 'unmeasured' } } }).share).toBeNull()
  })

  it('merges the unclassified names across repos so the estate view names them', () => {
    const repos = {
      a: { gates: summariseGates([{ name: 'Summon a badger' }, { name: 'Test' }]) },
      b: { gates: summariseGates([{ name: 'Summon a badger' }, { name: 'Feed the badger' }]) },
    }
    expect(aggregateGates(repos).unclassifiedNames).toEqual([
      { name: 'Summon a badger', count: 2 },
      { name: 'Feed the badger', count: 1 },
    ])
  })
})

describe('classificationBlindness', () => {
  // H4's primary outcome metric is a share over CLASSIFIED steps, so every step
  // the pattern list has never seen leaves the denominator silently. On
  // 2026-08-03, 12 of 17 estate failing steps were unclassified and the
  // headline read 80% locally-catchable; over all 17 it was 47%. Nothing
  // failed, because `unclassified` was reported and never asserted on (#1167).
  it('fails when unclassified steps are too large a share of the denominator', () => {
    const result = classificationBlindness({
      failingSteps: 17,
      unclassified: 12,
      unclassifiedNames: [
        { name: 'Apply DDL imports', count: 5 },
        { name: 'Error-branch coverage', count: 3 },
      ],
    })
    expect(result.ok).toBe(false)
    // The names are the actionable part -- a share alone sends you back to the
    // jobs API to find out what to add.
    expect(result.summary).toContain('Apply DDL imports')
    expect(result.summary).toContain('12 of 17')
  })

  it('passes when every failing step was classified', () => {
    const result = classificationBlindness({
      failingSteps: 17,
      unclassified: 0,
      unclassifiedNames: [],
    })
    expect(result.ok).toBe(true)
  })

  it('passes when nothing failed at all -- there is no denominator to go blind', () => {
    expect(
      classificationBlindness({ failingSteps: 0, unclassified: 0, unclassifiedNames: [] }).ok,
    ).toBe(true)
  })

  it('tolerates one unseen name in a large sample rather than crying wolf daily', () => {
    // A brand-new step name is normal estate churn. The threshold exists so the
    // audit means something when it does fire -- a guard that is red every
    // morning trains people to stop reading it, which is the argument
    // protection-audit.sh makes at length.
    const result = classificationBlindness({
      failingSteps: 40,
      unclassified: 1,
      unclassifiedNames: [{ name: 'Summon a badger', count: 1 }],
    })
    expect(result.ok).toBe(true)
  })

  it('fails a small sample that is entirely unclassified', () => {
    // 2 of 2 is 100% blind. Sample size does not rescue it: the share is the
    // whole denominator, not a rounding artefact.
    expect(
      classificationBlindness({
        failingSteps: 2,
        unclassified: 2,
        unclassifiedNames: [{ name: 'Summon a badger', count: 2 }],
      }).ok,
    ).toBe(false)
  })

  it('says so when a pre-existing snapshot has counts but no names', () => {
    // Every snapshot collected before #1167 is this shape. An empty list would
    // read as "looked for names, found none", which is a different claim.
    const result = classificationBlindness({ failingSteps: 17, unclassified: 12 })
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('names not recorded')
  })

  it('refuses to pass a window it could not measure', () => {
    // `unmeasured` is not `nothing was blind` -- the same distinction
    // gatesForWindow preserves.
    const result = classificationBlindness({ error: 'unmeasured' })
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('unmeasured')
  })
})

describe('isTotalFetchFailure', () => {
  // The 2026-07-30 incident: all 15 repos 401'd because cron cannot read the
  // keyring, and the collector still wrote a well-formed snapshot containing no
  // data. Partial failure must stay graceful; total failure must not.
  it('is fatal when every repo failed', () => {
    expect(isTotalFetchFailure(15, 15)).toBe(true)
  })

  it('is not fatal when even one repo was read', () => {
    expect(isTotalFetchFailure(14, 15)).toBe(false)
  })

  it('is not fatal when nothing failed', () => {
    expect(isTotalFetchFailure(0, 15)).toBe(false)
  })

  it('does not fire on an empty target list, which is a no-op not a failure', () => {
    // `--repo <slug>` with a typo targets nothing. That deserves a different
    // message, not a claim that the credential broke.
    expect(isTotalFetchFailure(0, 0)).toBe(false)
  })
})

describe('diagnoseTotalFetchFailure', () => {
  // The message this replaced asserted "the cause is credentials" whatever the
  // error said. On 2026-08-02 that was wrong: GitHub's GraphQL node budget
  // started rejecting the bulk PR fetch, and the operator was sent after a
  // keyring that was working. A confidently wrong diagnosis costs more than none.
  const nodeLimit =
    'GraphQL: By the time this query traverses to the authors connection, it is requesting up to 1,000,000 possible nodes which exceeds the maximum limit of 500,000.'

  it('names the node budget, and explicitly rules out credentials', () => {
    const message = diagnoseTotalFetchFailure(nodeLimit)
    expect(message).toMatch(/node-budget/i)
    expect(message).toMatch(/NOT credentials/)
  })

  it('says retrying at a lower limit will not help, because the estimate is static', () => {
    expect(diagnoseTotalFetchFailure(nodeLimit)).toMatch(/every --limit/)
  })

  it('still names credentials for the 401 that motivated the guard', () => {
    expect(diagnoseTotalFetchFailure('HTTP 401: Bad credentials')).toMatch(/keyring/)
  })

  it('distinguishes a rate limit from both', () => {
    expect(diagnoseTotalFetchFailure('HTTP 403: API rate limit exceeded')).toMatch(/rate limit/i)
  })

  it('admits ignorance rather than guessing credentials', () => {
    // The failure mode being fixed: a cause it has never seen must not be
    // reported as the one cause it knows.
    const message = diagnoseTotalFetchFailure('ECONNRESET: socket hang up')
    expect(message).toMatch(/not one this script recognises/)
    expect(message).not.toMatch(/keyring/)
  })

  it('does not claim a cause when there is no error to read', () => {
    expect(diagnoseTotalFetchFailure(undefined)).toMatch(/not one this script recognises/)
  })
})

// ---------------------------------------------------------------------------
// Amplification and the morning standup (#918)
// ---------------------------------------------------------------------------

describe('normaliseSubject', () => {
  it('collapses the same upstream change arriving in different repos', () => {
    // These differ only by PR number, which is exactly what made them look like
    // distinct work in the 2026-07-29 reading.
    expect(normaliseSubject('chore(shared): sync template-shared files (#30)')).toBe(
      normaliseSubject('chore(shared): sync template-shared files (#19)'),
    )
  })

  it('does not collapse genuinely different subjects', () => {
    expect(normaliseSubject('fix(api): a (#1)')).not.toBe(normaliseSubject('fix(api): b (#2)'))
  })

  it('leaves an issue reference that is not a trailing PR number alone', () => {
    expect(normaliseSubject('fix: handle (#12) in the parser')).toContain('(#12)')
  })
})

describe('summariseAmplification', () => {
  // Modelled on the real shape: one subject, 7 rounds across 3 repos.
  const sweep = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      subject: `chore(shared): sync template-shared files (#${i})`,
    }))

  it('counts rounds above the first as avoidable, not the whole sweep', () => {
    const result = summariseAmplification({ a: sweep(7), b: sweep(7), c: sweep(7) })
    expect(result.totalMerges).toBe(21)
    // One round across three repos is the mechanism working: 3 merges are floor.
    expect(result.avoidableMerges).toBe(18)
    expect(result.top[0].rounds).toBe(7)
    expect(result.top[0].repos).toBe(3)
  })

  it('ignores a subject that only ever hit one repo, however often', () => {
    // Ten commits of the same message in one repo is not amplification, it is
    // just repetition — and indicting it would make every fix-on-fix chain
    // look like a distribution problem.
    const result = summariseAmplification({ a: sweep(10) })
    expect(result.avoidableMerges).toBe(0)
    expect(result.top).toEqual([])
  })

  it('ignores a change that reached many repos exactly once — the mechanism working', () => {
    const once = [{ subject: 'chore(shared): sync template-shared files (#1)' }]
    const result = summariseAmplification({ a: once, b: once, c: once, d: once })
    expect(result.avoidableMerges).toBe(0)
  })

  it('reports the avoidable share of everything that landed', () => {
    const result = summariseAmplification({
      a: [...sweep(4), { subject: 'feat: real work (#99)' }],
      b: sweep(4),
      c: sweep(4),
    })
    // 12 sweep merges across 3 repos => 9 avoidable, of 13 total.
    expect(result.avoidableMerges).toBe(9)
    expect(result.avoidableShare).toBe(69.2)
  })

  it('returns a null share when nothing landed at all', () => {
    expect(summariseAmplification({}).avoidableShare).toBeNull()
  })
})

describe('reviewCoverage (#952)', () => {
  it('counts a PR as reviewed on any review event, not only an approval', () => {
    // The bar is "someone looked", not "someone approved". On a solo-operator
    // estate an approval requirement would block every merge, so requiring one
    // would measure the policy rather than the practice.
    const got = reviewCoverage([
      { number: 1, reviews: [{ state: 'COMMENTED' }] },
      { number: 2, reviews: [{ state: 'CHANGES_REQUESTED' }] },
      { number: 3, reviews: [{ state: 'APPROVED' }] },
      { number: 4, reviews: [] },
    ])

    expect(got.reviewed).toBe(3)
    expect(got.unreviewed).toBe(1)
    expect(got.reviewedShare).toBe(75)
  })

  it('can reach zero — a metric that cannot get worse measures nothing', () => {
    // The property the practices page insists on: name the value that would make
    // this bad, and check it is reachable. A day of unreviewed self-merges is
    // exactly the condition this exists to make visible, and it reads 0.
    const got = reviewCoverage([
      { number: 1, reviews: [] },
      { number: 2, reviews: [] },
    ])

    expect(got.reviewedShare).toBe(0)
    expect(got.unreviewed).toBe(2)
  })

  it('treats a missing reviews field as unreviewed rather than crashing', () => {
    // `gh` omits the key entirely on some responses; an undefined must not be
    // read as "fine".
    const got = reviewCoverage([{ number: 1 }])

    expect(got.reviewedShare).toBe(0)
  })
})
