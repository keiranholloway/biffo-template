import { describe, expect, it } from 'vitest'
import { INSTANCE_NAV_LINKS } from './instance-nav'

/**
 * The base template must ship this seam with an EMPTY default (ADR-0028).
 *
 * The file is user-owned, so it is seeded once and then belongs to the
 * instance. Shipping a link here would push a template opinion into a file no
 * upgrade can ever correct — and the template has no admin surface of its own
 * that isn't already in `nav.tsx`.
 */
describe('INSTANCE_NAV_LINKS', () => {
  it('is empty in the base template', () => {
    expect(INSTANCE_NAV_LINKS).toEqual([])
  })
})
