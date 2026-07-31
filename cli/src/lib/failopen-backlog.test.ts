/**
 * The fail-open backlog metric (#956).
 *
 * The corpus records fail-opens faithfully and converted almost none of them
 * into work: `unfiled` — recorded, no issue ever created — sat at 8 of 90 when
 * this was written, and nothing measured it, so the gap was invisible in every
 * number the dashboard reported.
 *
 * These tests pin the two properties that make it trustworthy rather than
 * decorative: it must refuse to report zero when it cannot read the corpus, and
 * it must count a fail-open recorded under `alsoClass` the same as a primary one.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs collector, no types
import { summariseFailOpenBacklog } from '../../../scripts/practices-metrics.mjs'

const NOW = new Date('2026-07-31T00:00:00Z')

function corpusOf(rows: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'biffo-corpus-'))
  const file = join(dir, 'evidence.jsonl')
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return file
}

describe('summariseFailOpenBacklog', () => {
  it('reports unmeasured, NOT zeros, when the corpus cannot be read', () => {
    // The whole file's stated rule. A zero here would render as a clean estate
    // on the dashboard, which is the most expensive possible wrong answer for a
    // metric whose subject is checks that pass without checking.
    const result = summariseFailOpenBacklog('/nonexistent/evidence.jsonl', NOW)

    expect(result).toEqual({ error: 'unmeasured' })
    expect(result.unfixed).toBeUndefined()
  })

  it('reports unmeasured on a corpus that exists but does not parse', () => {
    const dir = mkdtempSync(join(tmpdir(), 'biffo-corpus-'))
    const file = join(dir, 'evidence.jsonl')
    writeFileSync(file, 'not json at all\n')
    try {
      expect(summariseFailOpenBacklog(file, NOW)).toEqual({ error: 'unmeasured' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('counts a fail-open recorded under alsoClass', () => {
    // Roughly a fifth of the fail-open rows carry it secondarily. Counting only
    // `class` would under-report the backlog and make it look like it was
    // shrinking on days it was not.
    const file = corpusOf([
      { class: 'fail-open', status: 'open', date: '2026-07-01' },
      { class: 'visibility', alsoClass: ['fail-open'], status: 'open', date: '2026-07-01' },
      { class: 'visibility', alsoClass: ['process'], status: 'open', date: '2026-07-01' },
    ])

    expect(summariseFailOpenBacklog(file, NOW)).toMatchObject({ total: 2, unfixed: 2 })
  })

  it('treats fixed, closed and fixed-downstream as done', () => {
    const file = corpusOf([
      { class: 'fail-open', status: 'fixed' },
      { class: 'fail-open', status: 'closed' },
      { class: 'fail-open', status: 'fixed downstream' },
      { class: 'fail-open', status: 'partly fixed' },
    ])

    // `partly fixed` is outstanding: one instance closed, the class still open.
    expect(summariseFailOpenBacklog(file, NOW)).toMatchObject({ total: 4, unfixed: 1 })
  })

  it('counts unfiled separately, because that is the one that is a target', () => {
    const file = corpusOf([
      { class: 'fail-open', status: 'unfiled', date: '2026-07-20' },
      { class: 'fail-open', status: 'open', date: '2026-07-20' },
    ])

    expect(summariseFailOpenBacklog(file, NOW)).toMatchObject({ unfixed: 2, unfiled: 1 })
  })

  it('ages the oldest outstanding finding, ignoring the fixed ones', () => {
    const file = corpusOf([
      { class: 'fail-open', status: 'fixed', date: '2020-01-01' }, // ancient but done
      { class: 'fail-open', status: 'open', date: '2026-07-01' },
    ])

    expect(summariseFailOpenBacklog(file, NOW)).toMatchObject({ oldestUnfixedDays: 30 })
  })

  it('reports a null age rather than 0 when no outstanding row carries a date', () => {
    // 0 would read as "nothing is old", which is the opposite of "we do not know".
    const file = corpusOf([{ class: 'fail-open', status: 'open' }])

    expect(summariseFailOpenBacklog(file, NOW).oldestUnfixedDays).toBeNull()
  })

  it('breaks the outstanding rows down by status', () => {
    const file = corpusOf([
      { class: 'fail-open', status: 'open' },
      { class: 'fail-open', status: 'open' },
      { class: 'fail-open', status: 'unfiled' },
      { class: 'fail-open', status: 'fixed' },
    ])

    expect(summariseFailOpenBacklog(file, NOW).byStatus).toEqual({ open: 2, unfiled: 1 })
  })
})
