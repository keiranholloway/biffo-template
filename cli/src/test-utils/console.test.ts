import { Chalk } from 'chalk'
import { describe, expect, it, vi } from 'vitest'
import { capturedLines, capturedOutput } from './console.js'

const colour = new Chalk({ level: 3 })

function spyWith(...calls: unknown[][]): { mock: { calls: unknown[][] } } {
  const spy = vi.fn()
  for (const call of calls) spy(...call)
  return spy as unknown as { mock: { calls: unknown[][] } }
}

describe('capturedOutput', () => {
  it('joins multi-argument calls with a space and calls with newlines', () => {
    expect(capturedOutput(spyWith(['a', 'b'], ['c']))).toBe('a b\nc')
  })

  it('strips chalk styling so assertions test content, not presentation', () => {
    const spy = spyWith([`  ${colour.bold('3')} template-owned file(s) would change`])
    expect(capturedOutput(spy)).toBe('  3 template-owned file(s) would change')
  })

  it('lets a negative assertion mean what it says', () => {
    // Without stripping, `not.toContain('STATUS')` would pass even when the
    // column *is* present, because chalk can split the word with escapes.
    const spy = spyWith([`NAME  ${colour.bold('STA') + colour.dim('TUS')}`])
    expect(capturedOutput(spy)).toContain('STATUS')
  })

  it('returns an empty string when nothing was logged', () => {
    expect(capturedOutput(spyWith())).toBe('')
  })
})

describe('capturedLines', () => {
  it('returns one stripped entry per call', () => {
    const spy = spyWith([colour.bold('NAME'), 'VERSION'], ['widgets', '1.0.0'])
    expect(capturedLines(spy)).toEqual(['NAME VERSION', 'widgets 1.0.0'])
  })
})
