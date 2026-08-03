import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain .mjs so the tool runs on bare node with no build
// step, the same arrangement as practices-metrics.mjs. Imported here so the
// logic has one home rather than a TypeScript copy that can drift from it.
import {
  MATCH_GRACE_MS,
  VERDICT,
  adjudicateRun,
  evictionKilledJob,
  isInstanceId,
  parseEvictions,
  summarise,
} from '../../../scripts/runner-drop-forensics.mjs'

/**
 * Build a CloudTrail `lookup-events` entry. The shape matters more than it
 * looks: the real record is a JSON **string** under `CloudTrailEvent`, and the
 * instance IDs sit in `serviceEventDetails.instanceIdSet`, not in the empty
 * top-level `Resources` array.
 */
function evictionEvent(instanceIds: string[], eventTime: string) {
  return {
    EventName: 'BidEvictedEvent',
    Resources: [],
    CloudTrailEvent: JSON.stringify({
      eventTime,
      eventName: 'BidEvictedEvent',
      eventType: 'AwsServiceEvent',
      serviceEventDetails: { instanceIdSet: instanceIds },
    }),
  }
}

/** A job that stopped without a verdict — the signature of a killed runner. */
function lostJob(overrides: Record<string, unknown> = {}) {
  return {
    name: 'JS (lint, types, test, audit)',
    conclusion: 'failure',
    runner_name: 'i-0343b41422951ce4b',
    started_at: '2026-07-30T17:45:09Z',
    completed_at: '2026-07-30T17:58:09Z',
    steps: [
      { name: 'Set up job', conclusion: 'success' },
      { name: 'Install', conclusion: null },
    ],
    ...overrides,
  }
}

describe('isInstanceId', () => {
  it('accepts both the 8- and 17-hex-digit EC2 forms', () => {
    expect(isInstanceId('i-0b26948129cfd56f3')).toBe(true)
    expect(isInstanceId('i-04c99509')).toBe(true)
  })

  it('rejects a GitHub-hosted runner name rather than treating it as unmatched', () => {
    // The distinction this protects is "could not see the input" vs "nothing
    // there" — the estate's most-repeated defect class.
    expect(isInstanceId('GitHub Actions 1000017440')).toBe(false)
    expect(isInstanceId(null)).toBe(false)
    expect(isInstanceId(undefined)).toBe(false)
  })
})

describe('parseEvictions', () => {
  it('reads instance IDs out of the nested CloudTrailEvent string', () => {
    const evictions = parseEvictions([
      evictionEvent(['i-0343b41422951ce4b'], '2026-07-30T17:48:30Z'),
    ])
    expect(evictions.get('i-0343b41422951ce4b')).toBe('2026-07-30T17:48:30Z')
  })

  it('expands an event that reclaimed a whole pool at once', () => {
    // AWS took twelve runners in a single second on 2026-07-30; one event, many
    // instances. Reading only the first would leave eleven jobs unexplained.
    const ids = ['i-004621d85b243774a', 'i-01976335b3c54e49a', 'i-034fff51ce60a82ae']
    const evictions = parseEvictions([evictionEvent(ids, '2026-07-30T15:48:40Z')])
    expect([...evictions.keys()]).toEqual(ids)
  })

  it('survives a malformed record instead of failing the whole lookup', () => {
    const events = [
      { CloudTrailEvent: 'not json at all' },
      { CloudTrailEvent: JSON.stringify({ eventTime: null }) },
      evictionEvent(['i-0b26948129cfd56f3'], '2026-07-27T11:13:25Z'),
    ]
    expect(parseEvictions(events).size).toBe(1)
  })

  it('keeps the earliest sighting when pagination repeats an instance', () => {
    const evictions = parseEvictions([
      evictionEvent(['i-0a71db9f4ddc26df4'], '2026-08-01T07:15:15Z'),
      evictionEvent(['i-0a71db9f4ddc26df4'], '2026-08-01T09:00:00Z'),
    ])
    expect(evictions.get('i-0a71db9f4ddc26df4')).toBe('2026-08-01T07:15:15Z')
  })

  it('returns empty rather than throwing on no events', () => {
    expect(parseEvictions([]).size).toBe(0)
    expect(parseEvictions(undefined).size).toBe(0)
  })
})

describe('evictionKilledJob', () => {
  it('matches an eviction inside the job window', () => {
    expect(evictionKilledJob(lostJob(), '2026-07-30T17:48:30Z')).toBe(true)
  })

  it('tolerates the 4-second real-world margin via the grace window', () => {
    // i-0bfec05c84f2a7030 finished 4s after its eviction. Zero tolerance plus a
    // little clock skew would report that reclamation as unexplained and send
    // someone hunting instance logs that do not exist.
    const job = lostJob({
      started_at: '2026-07-29T12:03:02Z',
      completed_at: '2026-07-29T12:04:09Z',
    })
    expect(evictionKilledJob(job, '2026-07-29T12:04:05Z')).toBe(true)
    expect(MATCH_GRACE_MS).toBeGreaterThan(4_000)
  })

  it('rejects an eviction well outside the window, so a pooled host is not misblamed', () => {
    // biffo-runners reuses instances across jobs. An eviction hours later must
    // not excuse a job that failed honestly on the same host earlier.
    expect(evictionKilledJob(lostJob(), '2026-07-30T23:59:00Z')).toBe(false)
    expect(evictionKilledJob(lostJob(), '2026-07-30T09:00:00Z')).toBe(false)
  })

  it('treats a still-running job as an open window', () => {
    const job = lostJob({ completed_at: null })
    expect(evictionKilledJob(job, '2026-07-30T17:48:30Z')).toBe(true)
  })

  it('is false when either timestamp is unreadable', () => {
    expect(evictionKilledJob(lostJob(), 'never')).toBe(false)
    expect(evictionKilledJob(lostJob({ started_at: null }), '2026-07-30T17:48:30Z')).toBe(false)
  })
})

describe('adjudicateRun', () => {
  const evictions = parseEvictions([evictionEvent(['i-0343b41422951ce4b'], '2026-07-30T17:48:30Z')])

  it('calls a reclaimed runner what it is', () => {
    const result = adjudicateRun([lostJob()], evictions)
    expect(result.verdict).toBe(VERDICT.SPOT_RECLAIMED)
    expect(result.jobs[0].evictedAt).toBe('2026-07-30T17:48:30Z')
  })

  it('leaves a genuine gate failure alone even when the fleet was being reclaimed', () => {
    // The ordering guard: a run whose step actually returned `failure` is not a
    // runner kill, and a coincident eviction must not launder it.
    const failed = lostJob({
      steps: [
        { name: 'Set up job', conclusion: 'success' },
        { name: 'Lint', conclusion: 'failure' },
      ],
    })
    expect(adjudicateRun([failed], evictions).verdict).toBe(VERDICT.REAL_FAILURE)
  })

  it('flags a runner death that no eviction explains', () => {
    // This is the case that would justify retaining instance logs. The corpus
    // holds zero of them today; if one appears, #1021's first checkbox is live
    // again.
    const orphan = lostJob({ runner_name: 'i-0deadbeefdeadbeef' })
    const result = adjudicateRun([orphan], evictions)
    expect(result.verdict).toBe(VERDICT.FLEET_FAULT_UNEXPLAINED)
    expect(result.jobs[0].evictedAt).toBeNull()
  })

  it('lets one unexplained death dominate a run that was otherwise reclaimed', () => {
    const result = adjudicateRun(
      [lostJob(), lostJob({ runner_name: 'i-0deadbeefdeadbeef' })],
      evictions,
    )
    expect(result.verdict).toBe(VERDICT.FLEET_FAULT_UNEXPLAINED)
    expect(result.jobs.map((j: { verdict: string }) => j.verdict)).toEqual([
      VERDICT.SPOT_RECLAIMED,
      VERDICT.FLEET_FAULT_UNEXPLAINED,
    ])
  })

  it('marks a GitHub-hosted job as uncorrelatable rather than unexplained', () => {
    const hosted = lostJob({ runner_name: 'GitHub Actions 1000017440' })
    expect(adjudicateRun([hosted], evictions).jobs[0].verdict).toBe(VERDICT.NOT_SELF_HOSTED)
  })

  it('ignores jobs that succeeded when deciding which instances to look up', () => {
    const ok = lostJob({ conclusion: 'success', runner_name: 'i-0deadbeefdeadbeef' })
    expect(adjudicateRun([ok, lostJob()], evictions).jobs).toHaveLength(1)
  })
})

describe('summarise', () => {
  it('counts every verdict, reporting zeroes rather than omitting them', () => {
    // An absent key reads as "none happened" and as "not measured"; the corpus
    // has been bitten by that ambiguity before, so all four are always present.
    const counts = summarise([
      { verdict: VERDICT.SPOT_RECLAIMED },
      { verdict: VERDICT.SPOT_RECLAIMED },
      { verdict: VERDICT.REAL_FAILURE },
    ])
    expect(counts).toEqual({
      [VERDICT.SPOT_RECLAIMED]: 2,
      [VERDICT.REAL_FAILURE]: 1,
      [VERDICT.FLEET_FAULT_UNEXPLAINED]: 0,
      [VERDICT.NOT_SELF_HOSTED]: 0,
    })
  })
})
