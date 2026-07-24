import { describe, expect, it } from 'vitest'
import type { CatalogTriggerField } from '@/lib/orchestration-api'
import { buildSampleEvent, formatSampleEvent, parseSampleEvent } from './sample-event'

describe('buildSampleEvent', () => {
  it('seeds one example value per declared field, by type', () => {
    const fields: CatalogTriggerField[] = [
      { name: 'status', label: 'Status', type: 'enum', values: ['new', 'won', 'lost'] },
      { name: 'score', label: 'Score', type: 'number', values: [] },
      { name: 'company', label: 'Company', type: 'string', values: [] },
      { name: 'vip', label: 'VIP', type: 'boolean', values: [] },
    ]
    expect(buildSampleEvent(fields)).toEqual({
      status: 'new', // first enum value
      score: 42,
      company: 'Acme Inc', // string value inferred from the field name
      vip: true,
    })
  })

  it('infers a believable string value from the field name', () => {
    const fields: CatalogTriggerField[] = [
      { name: 'email', label: 'Email', type: 'string', values: [] },
      { name: 'demo_request_id', label: 'Demo request ID', type: 'string', values: [] },
      { name: 'username', label: 'Username', type: 'string', values: [] },
      { name: 'brand_slug', label: 'Brand slug', type: 'string', values: [] },
      { name: 'notes', label: 'Notes', type: 'string', values: [] },
    ]
    expect(buildSampleEvent(fields)).toEqual({
      email: 'user@example.com',
      demo_request_id: 'example-demo_request_id-1',
      username: 'Example Name',
      brand_slug: 'example-slug',
      notes: 'example notes', // no rule matched → generic placeholder
    })
  })

  it('falls back to a placeholder for an enum with no declared values', () => {
    expect(buildSampleEvent([{ name: 'stage', label: 'Stage', type: 'enum', values: [] }])).toEqual(
      { stage: 'example stage' },
    )
  })

  it('yields an empty object for a trigger with no fields', () => {
    expect(buildSampleEvent([])).toEqual({})
  })
})

describe('parseSampleEvent', () => {
  it('treats blank text as an empty event, not an error', () => {
    expect(parseSampleEvent('   ')).toEqual({ event: {}, error: null })
  })

  it('parses a JSON object', () => {
    expect(parseSampleEvent('{"a": 1}')).toEqual({ event: { a: 1 }, error: null })
  })

  it('rejects invalid JSON', () => {
    const result = parseSampleEvent('{not json}')
    expect(result.event).toBeNull()
    expect(result.error).toMatch(/not valid JSON/)
  })

  it('rejects a non-object (array / scalar)', () => {
    expect(parseSampleEvent('[1, 2]').error).toMatch(/must be a JSON object/)
    expect(parseSampleEvent('42').error).toMatch(/must be a JSON object/)
  })

  it('round-trips through formatSampleEvent', () => {
    const event = { status: 'won', score: 42 }
    const parsed = parseSampleEvent(formatSampleEvent(event))
    expect(parsed.event).toEqual(event)
  })
})
