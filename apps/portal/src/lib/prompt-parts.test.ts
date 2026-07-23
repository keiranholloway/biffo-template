import { describe, expect, it } from 'vitest'
import { isComponentPart, isInlinePart, normalizeParts } from './prompt-parts'

describe('normalizeParts', () => {
  it('treats a plain string as a single inline part (backward shape)', () => {
    expect(normalizeParts('Enrich this lead.')).toEqual([{ inline: 'Enrich this lead.' }])
  })

  it('normalises null and blank strings to an empty list', () => {
    expect(normalizeParts(null)).toEqual([])
    expect(normalizeParts(undefined)).toEqual([])
    expect(normalizeParts('   ')).toEqual([])
  })

  it('passes an ordered-parts list through, coercing values', () => {
    const parts = normalizeParts([
      { component: 'house-style', values: {} },
      { inline: 'Do the task.' },
      { component: 'lead-scorer', values: { region: 'Midlands' } },
    ])
    expect(parts).toEqual([
      { component: 'house-style', values: {} },
      { inline: 'Do the task.' },
      { component: 'lead-scorer', values: { region: 'Midlands' } },
    ])
  })

  it('drops malformed entries and non-string values', () => {
    const parts = normalizeParts([
      { inline: 'keep' },
      { nonsense: true },
      42,
      { component: 'c', values: { good: 'x', bad: 5 } },
    ])
    expect(parts).toEqual([{ inline: 'keep' }, { component: 'c', values: { good: 'x' } }])
  })

  it('exposes working type guards', () => {
    expect(isInlinePart({ inline: 'x' })).toBe(true)
    expect(isComponentPart({ component: 'c', values: {} })).toBe(true)
    expect(isComponentPart({ inline: 'x' })).toBe(false)
  })
})
