import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain .mjs so the standup runs on bare node, same
// arrangement as practices-metrics.mjs.
import {
  countPriorRows,
  recurrenceMultiplier,
  rank,
  closeLoop,
  readPath,
  buildFindings,
  FINDING_KINDS,
  snapshotAgeDays,
} from '../../../scripts/practices-standup.mjs'

/**
 * The shape the .mjs returns. Declared locally rather than annotating `any`:
 * these assertions are the only description of the contract that exists in
 * TypeScript, so a wrong field name should fail here.
 */
type Finding = {
  kind: string
  label?: string
  headline?: string
  repo?: string
  rank?: number
  promoted?: boolean
  score: number | null
  costMinutes: number | null
  priorRows: number
  multiplier: number
}

describe('countPriorRows', () => {
  const corpus = [
    { summary: 'shared-sync distributed a stale gate to eight repos' },
    { summary: 'RECURRENCE: shared file drift reached the satellite repos again' },
    { summary: 'something entirely unrelated about Terraform state' },
  ]

  it('counts rows matching any declared term', () => {
    expect(countPriorRows(corpus, ['shared-sync', 'shared file'])).toEqual({
      rows: 2,
      explicitRecurrences: 1,
    })
  })

  it('matches case-insensitively', () => {
    expect(countPriorRows([{ summary: 'HooksPath was wrong' }], ['hookspath']).rows).toBe(1)
  })

  it('counts nothing rather than everything when no term matches', () => {
    expect(countPriorRows(corpus, ['nonexistent-shape']).rows).toBe(0)
  })
})

describe('recurrenceMultiplier', () => {
  it('starts at 1 for an unseen shape', () => {
    expect(recurrenceMultiplier({ rows: 0, explicitRecurrences: 0 })).toBe(1)
  })

  it('rises with prior rows', () => {
    expect(recurrenceMultiplier({ rows: 2, explicitRecurrences: 0 })).toBe(1.5)
  })

  it('adds weight for an explicitly recorded recurrence', () => {
    expect(recurrenceMultiplier({ rows: 2, explicitRecurrences: 1 })).toBe(1.8)
  })

  it('caps, so a well-documented shape cannot own the ranking forever', () => {
    // `fail-open` has 60 corpus rows. Uncapped it would outrank everything every
    // day on the strength of being best recorded, which inverts the intent.
    expect(recurrenceMultiplier({ rows: 60, explicitRecurrences: 9 })).toBe(2.5)
  })
})

describe('rank', () => {
  const f = (kind: string, score: number | null, priorRows = 0) => ({
    kind,
    score,
    priorRows,
    multiplier: 1,
    costMinutes: score,
  })

  it('orders priced findings by score, highest first', () => {
    const ordered = rank([f('a', 10), f('b', 90), f('c', 50)])
    expect(ordered.map((x: Finding) => x.kind)).toEqual(['b', 'c', 'a'])
    expect(ordered[0].rank).toBe(1)
  })

  it('puts unpriced findings after priced ones rather than scoring them zero', () => {
    // Scoring null as 0 would rank an unmeasured finding below a trivial one and
    // make "we did not measure it" indistinguishable from "it cost nothing".
    const ordered = rank([f('unpriced', null), f('cheap', 1)])
    expect(ordered.map((x: Finding) => x.kind)).toEqual(['cheap', 'unpriced'])
  })

  it('promotes a shape with three or more prior rows into the top three', () => {
    const ordered = rank([f('big', 900), f('mid', 500), f('also', 400), f('known', null, 5)])
    expect(ordered[2].kind).toBe('known')
    expect(ordered[2].promoted).toBe(true)
    // and it did not displace the top two, which are genuinely more expensive
    expect(ordered.slice(0, 2).map((x: Finding) => x.kind)).toEqual(['big', 'mid'])
  })

  it('marks promotion visibly rather than folding it into the number', () => {
    const ordered = rank([f('a', 900), f('b', 800), f('c', 700), f('known', 1, 4)])
    const known = ordered.find((x: Finding) => x.kind === 'known')
    expect(known.promoted).toBe(true)
    // The score is untouched — the promotion is a policy, not an adjustment.
    expect(known.score).toBe(1)
  })

  it('does not mark a finding promoted when it already earned its place', () => {
    const ordered = rank([f('known', 900, 5), f('b', 1)])
    expect(ordered[0].promoted).toBeUndefined()
  })
})

describe('readPath', () => {
  const snap = {
    windows: { 1: { repos: { 'o/r': { contention: { greenButUnmergedHours: 13.8 } } } } },
  }

  it('reads a bracketed repo slug containing a slash', () => {
    expect(readPath(snap, 'windows.1.repos["o/r"].contention.greenButUnmergedHours')).toBe(13.8)
  })

  it('returns undefined for a path that does not exist', () => {
    expect(readPath(snap, 'windows.1.repos["nope"].contention.x')).toBeUndefined()
  })
})

describe('closeLoop', () => {
  const snap = { windows: { 1: { estate: { gates: { share: 60 } } } } }
  const last = { label: 'gates', metric: 'windows.1.estate.gates.share', metricValue: 70 }

  it('reports improvement when the metric fell', () => {
    expect(closeLoop(last, snap)).toMatchObject({ verdict: 'improved', delta: -10, now: 60 })
  })

  it('distinguishes "did not move" from "moved the wrong way"', () => {
    // Collapsing these would lose the distinction that decides what to do next:
    // one says the fix missed, the other that it backfired.
    expect(closeLoop({ ...last, metricValue: 60 }, snap).verdict).toBe('did not move')
    expect(closeLoop({ ...last, metricValue: 50 }, snap).verdict).toBe('moved the wrong way')
  })

  it('says so when today cannot measure the metric at all', () => {
    const blind = { windows: { 1: { estate: {} } } }
    expect(closeLoop(last, blind).verdict).toBe('unmeasurable today')
  })

  it('returns null when there is no previous choice', () => {
    expect(closeLoop(null, snap)).toBeNull()
  })
})

describe('buildFindings', () => {
  const snapshot = {
    windows: {
      1: {
        amplification: {
          totalMerges: 226,
          avoidableMerges: 69,
          avoidableShare: 30.5,
          top: [
            {
              subject: 'chore(shared): sync template-shared files',
              repos: 12,
              merges: 81,
              rounds: 6.8,
            },
          ],
        },
        estate: {
          gates: {
            locallyCatchable: 5,
            notLocallyCatchable: 2,
            share: 71.4,
            unclassified: 0,
            byKind: { test: 5 },
          },
        },
        repos: {
          'tabsii-com/tabsii-platform': {
            role: 'instance',
            mergedPrs: 34,
            contention: { greenButUnmergedHours: 13.8, racedShare: 44.1, repushRate: 47.1 },
            integration: { failures: 0, redMinutes: 0 },
          },
          'tabsii-com/tabsii-marketplace': {
            role: 'sibling',
            mergedPrs: 9,
            contention: { greenButUnmergedHours: 0.6, racedShare: 22.2, repushRate: 66.7 },
            integration: { failures: 1, redMinutes: 215.8, unresolvedFailures: 0 },
          },
        },
      },
    },
  }

  it('finds amplification, contention and a red branch from one snapshot', () => {
    const found = buildFindings(snapshot, [], [])
    expect(found.map((f: Finding) => f.kind).sort()).toEqual(
      ['amplification', 'caughtSecond', 'contention', 'redBranch'].sort(),
    )
  })

  it('attributes contention to the worst repo, not the estate', () => {
    // An estate total names nobody, and the fix (branch protection) is per-repo.
    const c = buildFindings(snapshot, [], []).find((f: Finding) => f.kind === 'contention')
    expect(c.repo).toBe('tabsii-com/tabsii-platform')
    expect(c.costMinutes).toBe(828) // 13.8h
    expect(c.headline).toContain('95.8% of the estate') // its share of the contention
  })

  it('leaves the arming finding unpriced rather than inventing a cost', () => {
    const found = buildFindings(snapshot, [], [{ name: 'arming', ok: false, summary: '4 dead' }])
    const a = found.find((f: Finding) => f.kind === 'armingRegression')
    expect(a.costMinutes).toBeNull()
    expect(a.score).toBeNull()
  })

  it('raises a finding’s score when the corpus already knows the shape', () => {
    const corpus = FINDING_KINDS.amplification.terms.map((t: string) => ({
      summary: `a row about ${t}`,
    }))
    const plain = buildFindings(snapshot, [], []).find((f: Finding) => f.kind === 'amplification')
    const known = buildFindings(snapshot, corpus, []).find(
      (f: Finding) => f.kind === 'amplification',
    )
    expect(known.multiplier).toBeGreaterThan(plain.multiplier)
    expect(known.score).toBeGreaterThan(plain.score)
    expect(known.costMinutes).toBe(plain.costMinutes) // cost is evidence; only weight moved
  })

  it('produces nothing rather than guessing when the window is empty', () => {
    expect(buildFindings({ windows: { 1: { repos: {} } } }, [], [])).toEqual([])
  })
})

describe('snapshotAgeDays', () => {
  // The guard exists because the tool failed this on its own first real use: run
  // from the primary checkout, the newest snapshot was two days old (today's lives
  // on chore/practices-snapshots, never merged to dev) and it ranked it silently.
  const now = new Date('2026-07-30T09:00:00Z')

  it('is 0 for today', () => {
    expect(snapshotAgeDays('2026-07-30.json', now)).toBe(0)
  })

  it('counts whole days for a stale snapshot', () => {
    expect(snapshotAgeDays('2026-07-28.json', now)).toBe(2)
  })

  it('is 0 regardless of time of day — the cron runs at 04:30', () => {
    expect(snapshotAgeDays('2026-07-30.json', new Date('2026-07-30T23:59:00Z'))).toBe(0)
  })

  it('returns null for a filename it cannot date rather than guessing', () => {
    expect(snapshotAgeDays('estate-audits.json', now)).toBeNull()
  })
})
