import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain .mjs so it runs on bare node in CI with no install,
// like every other script in scripts/. Tested from here so the logic has one home.
import {
  assess,
  countEvidence,
  countTableRows,
  hasRemovalTrailer,
  REMOVAL_TRAILER,
} from '../../../scripts/practices-monotonic.mjs'

const table = (rows: string[]) => ['| A | B | C |', '| --- | --- | --- |', ...rows].join('\n')

describe('practices corpus monotonicity guard', () => {
  it('counts evidence records, ignoring blank lines', () => {
    expect(countEvidence('{"a":1}\n{"b":2}\n\n')).toBe(2)
    expect(countEvidence('')).toBe(0)
  })

  it('counts data rows across EVERY table, not just the scoreboard', () => {
    // The correction that makes this guard work. Scored against the real
    // incidents, a scoreboard-only count missed #774 entirely: its 93 deleted
    // lines were 50 rows from the three-cell "Where the cycles go" and "Skills
    // used" tables. Those record what things cost and whether a skill worked.
    const md = [
      '# Doc',
      table(['| x | y | z |', '| p | q | r |']),
      '',
      '| # | Failure | Class | Where | Fix | Status |',
      '| --- | --- | --- | --- | --- | --- |',
      '| #1 | broke | drift | a | b | open |',
    ].join('\n')
    expect(countTableRows(md)).toBe(3)
  })

  it('does not count header or separator rows', () => {
    expect(countTableRows(table([]))).toBe(0)
  })

  it('is indifferent to prose, so reflowing text is not a loss', () => {
    const a = `some prose\n${table(['| x | y | z |'])}`
    const b = `some\nprose\nrewrapped\nover\nlines\n${table(['| x | y | z |'])}`
    expect(countTableRows(a)).toBe(countTableRows(b))
  })

  it('fails when either corpus shrinks', () => {
    const out = assess({ evidence: 100, tableRows: 200 }, { evidence: 93, tableRows: 156 }, false)
    expect(out.ok).toBe(false)
    expect(out.losses).toHaveLength(2)
  })

  it('passes on growth', () => {
    expect(
      assess({ evidence: 100, tableRows: 200 }, { evidence: 104, tableRows: 210 }, false).ok,
    ).toBe(true)
  })

  it('passes on no change', () => {
    expect(
      assess({ evidence: 100, tableRows: 200 }, { evidence: 100, tableRows: 200 }, false).ok,
    ).toBe(true)
  })

  it('allows a shrink that a commit explicitly acknowledges', () => {
    // Rows genuinely should be removed sometimes — a duplicate, or two rows
    // merged. The trailer makes that reviewable in history rather than a
    // decision someone made in a terminal.
    const out = assess({ evidence: 100, tableRows: 200 }, { evidence: 99, tableRows: 200 }, true)
    expect(out.ok).toBe(true)
    expect(out.losses).toHaveLength(1) // still reported, just not fatal
  })

  it('detects the trailer in a commit message', () => {
    expect(hasRemovalTrailer(`fix: thing\n\n${REMOVAL_TRAILER} merged two duplicate rows\n`)).toBe(
      true,
    )
    expect(hasRemovalTrailer('fix: thing\n\nno trailer here\n')).toBe(false)
  })
})
