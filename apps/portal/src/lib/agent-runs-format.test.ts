import { describe, expect, it } from 'vitest'
import { formatCost, formatDuration } from './agent-runs-format'

describe('formatDuration', () => {
  it('renders sub-second, second, minute and null cases', () => {
    expect(formatDuration('2026-07-20T09:30:00.000Z', '2026-07-20T09:30:00.250Z')).toBe('250ms')
    expect(formatDuration('2026-07-20T09:30:00.000Z', '2026-07-20T09:30:01.400Z')).toBe('1.4s')
    expect(formatDuration('2026-07-20T09:30:00.000Z', '2026-07-20T09:31:30.000Z')).toBe('1m 30s')
    expect(formatDuration(null, '2026-07-20T09:30:01Z')).toBe('—')
    // A completed-before-started clock skew reads as unknown, not negative.
    expect(formatDuration('2026-07-20T09:30:05Z', '2026-07-20T09:30:00Z')).toBe('—')
  })
})

describe('formatCost', () => {
  it('renders four-decimal dollars and a dash for null', () => {
    expect(formatCost(0.0123)).toBe('$0.0123')
    expect(formatCost(null)).toBe('—')
  })
})
