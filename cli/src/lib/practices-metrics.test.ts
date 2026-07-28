import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain .mjs so the collector runs on bare node from a
// scheduled workflow that installs nothing. Imported here so the logic has one
// home rather than a TypeScript copy that can drift from it — same arrangement
// as destructive-plan.mjs and packaged-root-assets.mjs.
import {
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
  mergeContention,
  parseGitLog,
  percentile,
  prChurn,
  rate,
  runsForPr,
  summariseEstate,
  summariseRepo,
  summariseRework,
  summariseWorkMix,
  classifyMergeSide,
  classifyWork,
  filterToWindow,
} from '../../../scripts/practices-metrics.mjs'
// @ts-expect-error -- plain .mjs, same arrangement as above.
import {
  grade,
  fmt,
  renderDashboard,
  renderSessions,
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

describe('integrationHealth', () => {
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
    expect(estate.productFeatureShare).toBe(50)
  })

  it('reports the product-feature share as a fraction of ALL merges', () => {
    const estate = summariseEstate({
      plat: repo('platform', ['feat: a', 'fix: b']),
      prod: repo('product', ['feat: c', 'fix: d']),
    })
    // 1 product feature out of 4 total merges
    expect(estate.productFeatureShare).toBe(25)
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
    expect(estate.productFeatureShare).toBeNull()
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
})
