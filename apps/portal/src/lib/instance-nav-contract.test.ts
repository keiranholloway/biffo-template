import { describe, expect, it } from 'vitest'
import {
  type InstanceNavLink,
  normalizeInstanceHref,
  resolveInstanceNavLinks,
} from './instance-nav-contract'

describe('normalizeInstanceHref', () => {
  it('adds the trailing slash this static export requires (#275)', () => {
    expect(normalizeInstanceHref('/admin/demo-requests')).toBe('/admin/demo-requests/')
  })

  it('leaves an already-canonical href alone', () => {
    expect(normalizeInstanceHref('/admin/demo-requests/')).toBe('/admin/demo-requests/')
  })

  it('slashes the path portion, not the query or hash', () => {
    expect(normalizeInstanceHref('/admin/demo-requests?status=new')).toBe(
      '/admin/demo-requests/?status=new',
    )
    expect(normalizeInstanceHref('/admin/demo-requests#top')).toBe('/admin/demo-requests/#top')
  })
})

describe('resolveInstanceNavLinks', () => {
  it('is empty for the template default', () => {
    expect(resolveInstanceNavLinks([])).toEqual([])
  })

  it('preserves declaration order', () => {
    const links: InstanceNavLink[] = [
      { href: '/admin/b/', label: 'B' },
      { href: '/admin/a/', label: 'A' },
    ]
    expect(resolveInstanceNavLinks(links).map((l) => l.label)).toEqual(['B', 'A'])
  })

  it('canonicalises hrefs', () => {
    expect(resolveInstanceNavLinks([{ href: '/admin/demo-requests', label: 'Demo' }])).toEqual([
      { href: '/admin/demo-requests/', label: 'Demo' },
    ])
  })

  it('trims surrounding whitespace', () => {
    expect(resolveInstanceNavLinks([{ href: ' /admin/x/ ', label: ' X ' }])).toEqual([
      { href: '/admin/x/', label: 'X' },
    ])
  })

  it('drops entries that would render an unusable link', () => {
    const links = [
      { href: '/admin/ok/', label: 'Ok' },
      { href: '/admin/blank-label/', label: '   ' },
      { href: '', label: 'No href' },
      // Not an internal absolute path — the nav is for portal routes only.
      { href: 'https://example.com/', label: 'External' },
      { href: 'admin/relative/', label: 'Relative' },
    ]
    expect(resolveInstanceNavLinks(links).map((l) => l.label)).toEqual(['Ok'])
  })

  it('de-duplicates by canonical href, first declaration winning', () => {
    const links = [
      { href: '/admin/x/', label: 'First' },
      { href: '/admin/x', label: 'Second' },
    ]
    expect(resolveInstanceNavLinks(links)).toEqual([{ href: '/admin/x/', label: 'First' }])
  })

  it('fails soft rather than throwing, so a bad entry cannot blank the admin nav', () => {
    // The nav renders inside app/admin/layout.tsx — throwing here would take
    // down every admin page at once, not just one link.
    const links = [undefined, null, { label: 'Ok', href: '/admin/ok/' }] as InstanceNavLink[]
    expect(() => resolveInstanceNavLinks(links)).not.toThrow()
    expect(resolveInstanceNavLinks(links).map((l) => l.label)).toEqual(['Ok'])
    expect(resolveInstanceNavLinks(undefined)).toEqual([])
  })
})
