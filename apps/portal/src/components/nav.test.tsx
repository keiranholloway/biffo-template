import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstanceNavLink } from '@/lib/instance-nav-contract'
import type { InstalledPlugin } from '@/lib/plugin-api'
import { Nav } from './nav'

/**
 * A stand-in for the CognitoUserSession the real context yields, carrying
 * only what this file's tests read off it: the ID token's decoded claims.
 * Mirrors `auth-guard.test.tsx`'s `sessionWithGroups` — `groups` of
 * `undefined` models a token with no `cognito:groups` claim at all.
 */
function sessionWithGroups(groups: string[] | undefined) {
  return {
    getIdToken: () => ({
      decodePayload: () => (groups === undefined ? {} : { 'cognito:groups': groups }),
    }),
  }
}

/**
 * A single stable "signed out" value, reused (never recreated) across every
 * render `useAuth()` mock calls make while a test hasn't overridden it. The
 * real `useAuth()` memoises `getIdToken` via `useCallback([session])`, so its
 * identity is stable across renders as long as `session` hasn't changed —
 * mirroring that here matters, not just for realism: `nav.tsx`'s plugin-fetch
 * effect depends on `[session, getIdToken]`, and a mock that hands back a
 * *fresh* object (and fresh `getIdToken` closure) on every call defeats that
 * dependency array, so the effect re-fires every render, calls
 * `setPluginLinks` with a brand-new array every time (React can't bail out on
 * reference equality it never had), and the component render-loops forever.
 * Caught the hard way: an earlier version of this file used a fresh-object
 * default and ran the suite out of memory.
 */
const SIGNED_OUT_AUTH = { session: null, logout: (): void => {}, getIdToken: (): null => null }

const { useAuthMock, fetchInstalledPluginsMock } = vi.hoisted(() => ({
  useAuthMock: vi.fn(),
  fetchInstalledPluginsMock: vi.fn(),
}))

vi.mock('@/context/auth-context', () => ({
  useAuth: () => useAuthMock() as unknown,
}))

vi.mock('@/lib/api-client', () => ({
  createApiClient: () => ({ get: vi.fn() }),
}))

vi.mock('@/lib/plugin-api', () => ({
  fetchInstalledPlugins: fetchInstalledPluginsMock,
}))

/**
 * The instance-owned nav registry (ADR-0028), mocked as a live array so a test
 * can populate it. The array identity is stable, so `nav.tsx` reads whatever
 * these tests put in it at render time.
 */
const instanceLinks = vi.hoisted(() => [] as { href: string; label: string }[])
vi.mock('@/instance-nav', () => ({ INSTANCE_NAV_LINKS: instanceLinks }))

beforeEach(() => {
  // mockReturnValue fixes ONE object, returned by reference on every call —
  // unlike a default implementation closure, which would build a fresh one
  // per call. See SIGNED_OUT_AUTH's comment for why that distinction matters.
  useAuthMock.mockReturnValue(SIGNED_OUT_AUTH)
  fetchInstalledPluginsMock.mockReset()
  fetchInstalledPluginsMock.mockResolvedValue([])
})

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

  it('contributes nothing when the instance declares none', () => {
    // Asserted as a DIFFERENCE, not as an absolute list.
    //
    // This test previously hardcoded the eight core labels, and that broke the
    // first real instance it reached: biffo-platform's nav.tsx carries its own
    // 'Early access' link, so a template-owned test failed inside the upgrade
    // PR for a divergence the instance is entitled to have — and cannot fix,
    // because the test is template-owned and the next upgrade would revert any
    // edit. Found by running an actual `core upgrade`, not by any local run.
    //
    // It is the same mistake twice more in ADR-0028's original shape: a
    // template-owned test asserting the exact contents of something instances
    // are expected to customise. The registry's contribution is the only thing
    // this test can legitimately own.
    declare()
    render(<Nav />)
    const withNone = screen.getAllByRole('link').map((el) => el.textContent)
    cleanup()

    declare({ href: '/admin/instance-probe/', label: 'Instance probe' })
    render(<Nav />)
    const withOne = screen.getAllByRole('link').map((el) => el.textContent)

    expect(withOne).toEqual([...withNone, 'Instance probe'])
    expect(withNone).not.toContain('Instance probe')
    // Guards the guard: an empty nav would satisfy the diff vacuously.
    expect(withNone.length).toBeGreaterThan(3)
  })
})

/**
 * The #1555 seam: a plugin declares a nav entry, and until now nothing ever
 * rendered it. These prove `nav.tsx` actually calls through to
 * `fetchInstalledPlugins` / `resolvePluginNavLinks` and gates on the
 * caller's Cognito groups, not just that the contract module works in
 * isolation (that's `plugin-nav-contract.test.ts`'s job).
 */
describe('Nav — plugin-declared entries (#1555)', () => {
  function marketingPlugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
    return {
      name: 'marketing',
      version: '1.0.0',
      description: '',
      tables: [],
      routes: [],
      has_admin_ingress: true,
      admin_required_group: 'admin',
      admin_nav_label: 'Marketing',
      ...overrides,
    }
  }

  it('renders a plugin with an admin surface the caller can reach', async () => {
    useAuthMock.mockReturnValue({
      session: sessionWithGroups(['admin']),
      logout: vi.fn(),
      getIdToken: () => 'token',
    })
    fetchInstalledPluginsMock.mockResolvedValue([marketingPlugin()])

    render(<Nav />)

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Marketing' })).toBeInTheDocument()
    })
    expect(screen.getByRole('link', { name: 'Marketing' })).toHaveAttribute(
      'href',
      '/api/v1/plugins/marketing/admin',
    )
  })

  it('does not render a plugin with no declared admin surface', async () => {
    useAuthMock.mockReturnValue({
      session: sessionWithGroups(['admin']),
      logout: vi.fn(),
      getIdToken: () => 'token',
    })
    fetchInstalledPluginsMock.mockResolvedValue([
      marketingPlugin({ has_admin_ingress: false, admin_required_group: null }),
    ])

    render(<Nav />)

    await waitFor(() => {
      expect(fetchInstalledPluginsMock).toHaveBeenCalled()
    })
    expect(screen.queryByRole('link', { name: 'Marketing' })).not.toBeInTheDocument()
  })

  it('does not render a plugin whose required group the session lacks', async () => {
    useAuthMock.mockReturnValue({
      session: sessionWithGroups(['editor']),
      logout: vi.fn(),
      getIdToken: () => 'token',
    })
    fetchInstalledPluginsMock.mockResolvedValue([marketingPlugin()])

    render(<Nav />)

    await waitFor(() => {
      expect(fetchInstalledPluginsMock).toHaveBeenCalled()
    })
    expect(screen.queryByRole('link', { name: 'Marketing' })).not.toBeInTheDocument()
  })

  it('does not fetch plugins at all before the caller is signed in', () => {
    useAuthMock.mockReturnValue({ session: null, logout: vi.fn(), getIdToken: () => null })

    render(<Nav />)

    expect(fetchInstalledPluginsMock).not.toHaveBeenCalled()
  })
})
