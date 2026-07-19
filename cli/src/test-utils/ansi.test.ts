import { Chalk } from 'chalk'
import { describe, expect, it } from 'vitest'
import { stripAnsi } from './ansi.js'

// A chalk instance forced into truecolor, so this test is independent of
// whether the runner happens to have a TTY. That independence is the whole
// point: it is exactly what the assertions this helper defends were missing.
const colour = new Chalk({ level: 3 })

describe('stripAnsi', () => {
  it('leaves plain text untouched', () => {
    expect(stripAnsi('3 template-owned file(s) would change')).toBe(
      '3 template-owned file(s) would change',
    )
  })

  it('removes styling that chalk interleaves mid-sentence', () => {
    const styled = `  ${colour.bold('3')} template-owned file(s) would change`
    expect(styled).not.toBe(stripAnsi(styled))
    expect(stripAnsi(styled)).toBe('  3 template-owned file(s) would change')
  })

  it('removes nested and multi-style sequences', () => {
    const styled = colour.red(`a ${colour.bold.underline('b')} ${colour.dim('c')}`)
    expect(stripAnsi(styled)).toBe('a b c')
  })

  it('removes OSC-8 hyperlinks', () => {
    const esc = '\u001B'
    const bel = '\u0007'
    expect(stripAnsi(`${esc}]8;;https://example.com${bel}label${esc}]8;;${bel}`)).toBe('label')
  })

  it('is a no-op when chalk itself is colour-disabled', () => {
    expect(stripAnsi(new Chalk({ level: 0 }).bold('3'))).toBe('3')
  })
})
