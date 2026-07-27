import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain .mjs so the collector runs on bare node from a
// scheduled workflow that installs nothing. Imported here so the logic has one
// home rather than a TypeScript copy that can drift from it — same arrangement
// as destructive-plan.mjs and packaged-root-assets.mjs.
import {
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
  classifyWork,
  filterToWindow,
} from '../../../scripts/practices-metrics.mjs'
// @ts-expect-error -- plain .mjs, same arrangement as above.
import { grade, fmt, renderDashboard } from '../../../scripts/practices-dashboard.mjs'

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

describe('summariseEstate', () => {
  const repo = (side: string, merges: number, delivery: number, rework: number, toil: number) => ({
    side,
    workMix: {
      merges,
      delivery,
      rework,
      toil,
      quality: 0,
      docs: 0,
      unconventional: 0,
      toilRatio: rework + toil,
    },
    contention: { greenButUnmergedHours: 10 },
  })

  /**
   * Merge-weighted, not an average of averages — otherwise a repo with three
   * merges swings the headline as hard as one with four hundred.
   */
  it('weights the estate figure by merge volume', () => {
    const estate = summariseEstate({
      big: repo('platform', 400, 25, 50, 25),
      small: repo('product', 4, 100, 0, 0),
    })
    expect(estate.merges).toBe(404)
    expect(estate.platformShare).toBe(99)
    // 200 rework + 100 toil of 404, not the mean of 75% and 0%
    expect(estate.toilRatio).toBe(74.3)
  })

  it('reports the product-feature share as a fraction of ALL merges', () => {
    const estate = summariseEstate({
      plat: repo('platform', 60, 50, 50, 0),
      prod: repo('product', 40, 50, 50, 0),
    })
    // 20 product features out of 100 total merges
    expect(estate.productFeatureShare).toBe(20)
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
