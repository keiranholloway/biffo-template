import { describe, expect, it } from 'vitest'
import type { CatalogTrigger } from './orchestration-api'
import {
  filterTriggers,
  groupTriggersBySource,
  matchesQuery,
  optionLabel,
  originOf,
  triggerKeyOf,
} from './trigger-catalog'

const demo: CatalogTrigger = {
  source: 'biffo.core',
  detail_type: 'demo.requested',
  label: 'Demo requested',
  description: 'Someone submits the "Book a demo" form.',
  origin: 'declared',
}

const lead: CatalogTrigger = {
  source: 'biffo.core',
  detail_type: 'lead.captured',
  label: 'Lead captured',
  description: 'A lead comes in from the website.',
  origin: 'declared',
}

const billing: CatalogTrigger = {
  source: 'tabsii.billing',
  detail_type: 'invoice.paid',
  label: 'invoice.paid',
  description: 'Seen on the event bus.',
  origin: 'observed',
}

const all = [demo, lead, billing]

describe('triggerKeyOf', () => {
  it('joins source and detail_type with a pipe', () => {
    expect(triggerKeyOf(demo)).toBe('biffo.core|demo.requested')
  })
})

describe('originOf', () => {
  it('reads an explicit origin', () => {
    expect(originOf(billing)).toBe('observed')
    expect(originOf(demo)).toBe('declared')
  })

  it('defaults to declared when the API predates the field', () => {
    const withoutOrigin: CatalogTrigger = { ...demo }
    delete withoutOrigin.origin
    expect(originOf(withoutOrigin)).toBe('declared')
  })
})

describe('matchesQuery', () => {
  it('matches everything on an empty or whitespace query', () => {
    expect(matchesQuery(demo, '')).toBe(true)
    expect(matchesQuery(demo, '   ')).toBe(true)
  })

  it('matches case-insensitively on label, source, detail_type and description', () => {
    expect(matchesQuery(demo, 'DEMO REQ')).toBe(true)
    expect(matchesQuery(billing, 'tabsii')).toBe(true)
    expect(matchesQuery(lead, 'captured')).toBe(true)
    expect(matchesQuery(lead, 'website')).toBe(true)
  })

  it('matches on origin so users can search for observed triggers', () => {
    expect(matchesQuery(billing, 'observed')).toBe(true)
    expect(matchesQuery(demo, 'observed')).toBe(false)
  })

  it('rejects a non-match', () => {
    expect(matchesQuery(demo, 'invoice')).toBe(false)
  })
})

describe('filterTriggers', () => {
  it('narrows to matches', () => {
    expect(filterTriggers(all, 'invoice')).toEqual([billing])
  })

  it('always retains the selected trigger even when it does not match', () => {
    expect(filterTriggers(all, 'invoice', 'biffo.core|demo.requested')).toEqual([demo, billing])
  })

  it('does not duplicate the selected trigger when it also matches', () => {
    expect(filterTriggers(all, 'invoice', 'tabsii.billing|invoice.paid')).toEqual([billing])
  })

  it('returns everything for an empty query', () => {
    expect(filterTriggers(all, '')).toEqual(all)
  })
})

describe('groupTriggersBySource', () => {
  it('groups by source, preserving catalog order within and across groups', () => {
    expect(groupTriggersBySource(all)).toEqual([
      { source: 'biffo.core', triggers: [demo, lead] },
      { source: 'tabsii.billing', triggers: [billing] },
    ])
  })

  it('keeps a source together even when its triggers are not adjacent', () => {
    const groups = groupTriggersBySource([demo, billing, lead])
    expect(groups.map((g) => g.source)).toEqual(['biffo.core', 'tabsii.billing'])
    expect(groups[0]?.triggers).toEqual([demo, lead])
  })

  it('returns nothing for an empty catalog', () => {
    expect(groupTriggersBySource([])).toEqual([])
  })
})

describe('optionLabel', () => {
  it('marks observed triggers inline, since an <option> cannot carry a badge', () => {
    expect(optionLabel(billing)).toBe('invoice.paid (observed)')
    expect(optionLabel(demo)).toBe('Demo requested')
  })
})
