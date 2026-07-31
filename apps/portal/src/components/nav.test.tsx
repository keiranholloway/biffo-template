import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InstanceNavLink } from '@/lib/instance-nav-contract'
import { Nav } from './nav'

vi.mock('@/context/auth-context', () => ({
  useAuth: () => ({ session: null, logout: vi.fn() }),
}))

/**
 * The instance-owned nav registry (ADR-0028), mocked as a live array so a test
 * can populate it. The array identity is stable, so `nav.tsx` reads whatever
 * these tests put in it at render time.
 */
const instanceLinks = vi.hoisted(() => [] as { href: string; label: string }[])
vi.mock('@/instance-nav', () => ({ INSTANCE_NAV_LINKS: instanceLinks }))

afterEach(() => {
  instanceLinks.length = 0
})

describe('Nav', () => {
  it('links to the core admin surfaces', () => {
    render(<Nav />)
    expect(screen.getByRole('link', { name: 'Workflows' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Prompt library' })).toBeInTheDocument()
  })

  it('no longer surfaces the retired standalone prompt assistant', () => {
    render(<Nav />)
    // The assistant now lives in an in-context drawer (ADR-0016), not a nav entry.
    expect(screen.queryByRole('link', { name: 'Prompt assistant' })).not.toBeInTheDocument()
  })
})

/**
 * The #769 seam. An instance cannot add an admin route without also making it
 * discoverable, so before this existed every instance surface meant a permanent
 * declared divergence in this template-owned file. These tests keep the seam
 * from silently rotting: delete the registry render from `nav.tsx` and they go
 * red.
 */
describe('Nav — instance-owned entries (ADR-0028)', () => {
  const declare = (...links: InstanceNavLink[]): void => {
    instanceLinks.push(...links)
  }

  // NOTE: don't assert on the rendered `href` attribute here. Outside a Next
  // build, `next/link` normalises against the DEFAULT `trailingSlash: false`
  // (vitest never loads next.config.ts), so it strips the very slash this app
  // ships with. Canonicalisation is asserted directly, on the resolver, in
  // lib/instance-nav-contract.test.ts; what this file proves is that `nav.tsx`
  // renders the registry AND pipes it through that resolver.
  it('renders an entry declared in the user-owned registry', () => {
    declare({ href: '/admin/demo-requests/', label: 'Demo requests' })
    render(<Nav />)
    expect(screen.getByRole('link', { name: 'Demo requests' })).toBeInTheDocument()
  })

  it('renders instance entries after the core links, in declaration order', () => {
    declare(
      { href: '/admin/demo-requests/', label: 'Demo requests' },
      { href: '/admin/franchisees/', label: 'Franchisees' },
    )
    render(<Nav />)
    const labels = screen.getAllByRole('link').map((el) => el.textContent)
    expect(labels.slice(-2)).toEqual(['Demo requests', 'Franchisees'])
    expect(labels.indexOf('Prompt library')).toBeLessThan(labels.indexOf('Demo requests'))
  })

  it('renders the entries through the resolver, not raw', () => {
    declare(
      { href: '/admin/x/', label: 'X' },
      // Same canonical href — de-duplicated by the resolver.
      { href: '/admin/x', label: 'X again' },
      // Unusable — dropped by the resolver rather than rendered as a dead link.
      { href: '', label: 'No href' },
      { href: 'https://example.com/', label: 'External' },
    )
    render(<Nav />)
    expect(screen.getByRole('link', { name: 'X' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'X again' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'No href' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'External' })).not.toBeInTheDocument()
  })

  it('renders no extra links when the instance declares none', () => {
    render(<Nav />)
    const labels = screen.getAllByRole('link').map((el) => el.textContent)
    expect(labels).toEqual([
      'Microservices',
      'Marketplace',
      'Plugins',
      'Endpoints',
      'Users',
      'Workflows',
      'Agent runs',
      'Prompt library',
    ])
  })
})
