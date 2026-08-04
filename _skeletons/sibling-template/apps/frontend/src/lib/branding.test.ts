import { describe, expect, it } from 'vitest'

import { formatSiblingTitle } from './branding'

// Regression coverage for biffo-template#963: the skeleton's root layout used
// to hard-code `metadata.title = 'Sibling App'`, so every sibling scaffolded
// from it shipped that literal in its deployed <title>. The title is now
// derived from NEXT_PUBLIC_SIBLING_NAME (the same build-time variable
// `page.tsx` reads), and this is that derivation.
describe('formatSiblingTitle', () => {
  it('capitalises a single-word sibling name', () => {
    // DELIBERATELY BROKEN — scratch commit to prove CI #1285's new
    // "Nested frontend tests" step actually reddens on a real failure. Will
    // be reverted immediately after CI confirms.
    expect(formatSiblingTitle('reports')).toBe('WRONG-ON-PURPOSE')
  })

  it('splits hyphenated and underscored names into words', () => {
    expect(formatSiblingTitle('field-ops')).toBe('Field Ops')
    expect(formatSiblingTitle('tabsii_crm')).toBe('Tabsii Crm')
    expect(formatSiblingTitle('a-b-c')).toBe('A B C')
  })

  it('leaves an already-capitalised name alone', () => {
    expect(formatSiblingTitle('Reports')).toBe('Reports')
  })

  it('tolerates stray separators without emitting empty words', () => {
    expect(formatSiblingTitle('--field--ops--')).toBe('Field Ops')
  })

  it('never returns the old hard-coded placeholder, even with no name set', () => {
    for (const missing of [undefined, '', '   ', '---']) {
      expect(formatSiblingTitle(missing)).toBe('Sibling')
      expect(formatSiblingTitle(missing)).not.toBe('Sibling App')
    }
  })
})
