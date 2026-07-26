import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InstalledPluginDetail } from './InstalledPluginDetail'
import type * as PluginApiModule from '@/lib/plugin-api'
import type { InstalledPlugin } from '@/lib/plugin-api'

// getIdToken must be a stable reference across renders (matching the real
// AuthProvider, which wraps it in useCallback) -- InstalledPluginDetail's
// effect depends on it, so a fresh function on every useAuth() call (the
// naive `() => ({ getIdToken: () => ... })` pattern) re-fires the effect
// every render, which re-sets state, which re-renders, forever.
const stableGetIdToken = () => 'fake-token'
vi.mock('@/context/auth-context', () => ({
  useAuth: () => ({ getIdToken: stableGetIdToken }),
}))

vi.mock('@/lib/api-client', () => ({
  createApiClient: () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }),
}))

const { fetchInstalledPlugins } = vi.hoisted(() => ({ fetchInstalledPlugins: vi.fn() }))
vi.mock('@/lib/plugin-api', async () => {
  const actual = await vi.importActual<typeof PluginApiModule>('@/lib/plugin-api')
  return { ...actual, fetchInstalledPlugins }
})

const rbacPlugin: InstalledPlugin = {
  name: 'rbac',
  version: '0.1.0',
  description: 'Fine-grained role-based access control.',
  tables: [
    {
      name: 'rbac_roles',
      columns: [
        {
          name: 'name',
          type: 'String(100)',
          primary_key: false,
          nullable: false,
          index: false,
          default: null,
          description: '',
        },
      ],
      indexes: [],
    },
    { name: 'rbac_permissions', columns: [], indexes: [] },
  ],
  routes: [
    { method: 'GET', path: '/roles', table: 'rbac_roles', operation: 'list', description: '' },
    { method: 'POST', path: '/roles', table: 'rbac_roles', operation: 'create', description: '' },
    {
      method: 'GET',
      path: '/permissions',
      table: 'rbac_permissions',
      operation: 'list',
      description: '',
    },
  ],
  has_admin_ingress: false,
}

describe('InstalledPluginDetail', () => {
  beforeEach(() => {
    fetchInstalledPlugins.mockReset()
  })

  it('shows a loading state before the fetch resolves', () => {
    fetchInstalledPlugins.mockReturnValue(new Promise(() => {}))
    render(<InstalledPluginDetail name="rbac" />)
    expect(document.querySelector('.animate-pulse')).not.toBeNull()
  })

  it('renders the matching installed plugin, including its tables and routes', async () => {
    fetchInstalledPlugins.mockResolvedValue([rbacPlugin])
    render(<InstalledPluginDetail name="rbac" />)

    expect(await screen.findByRole('heading', { name: 'rbac' })).toBeInTheDocument()
    expect(screen.getByText('v0.1.0')).toBeInTheDocument()
    expect(screen.getByText('Fine-grained role-based access control.')).toBeInTheDocument()

    // Table names appear in both the Tables section and as Endpoint group headings.
    expect(screen.getAllByText('rbac_roles').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('1 column')).toBeInTheDocument()
    expect(screen.getAllByText('rbac_permissions').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('0 columns')).toBeInTheDocument()

    // Endpoints render as full, callable Core API paths, grouped by table,
    // with their HTTP method and CRUD operation.
    expect(screen.getAllByText('/api/v1/plugins/rbac/roles')).toHaveLength(2) // GET + POST
    expect(screen.getByText('/api/v1/plugins/rbac/permissions')).toBeInTheDocument()
    expect(screen.getAllByText('GET')).toHaveLength(2)
    expect(screen.getByText('POST')).toBeInTheDocument()
    expect(screen.getAllByText('list')).toHaveLength(2)
    expect(screen.getByText('create')).toBeInTheDocument()
  })

  it('shows an empty state when a plugin declares no routes', async () => {
    fetchInstalledPlugins.mockResolvedValue([{ ...rbacPlugin, routes: [] }])
    render(<InstalledPluginDetail name="rbac" />)

    expect(await screen.findByText('Endpoints (0)')).toBeInTheDocument()
    expect(screen.getByText('No routes declared.')).toBeInTheDocument()
  })

  it('links the admin panel to the bare path, with no trailing slash', async () => {
    // The API Gateway route in front of the shared plugin host has no
    // unauthenticated route for the trailing-slash form at all (AWS rejects
    // a route_key ending in a bare "/" -- biffo-template#631) -- the bare
    // path is the only form reachable without a token, confirmed against a
    // real deployment. A trailing slash here would 401 for every admin.
    fetchInstalledPlugins.mockResolvedValue([{ ...rbacPlugin, has_admin_ingress: true }])
    render(<InstalledPluginDetail name="rbac" />)

    const link = await screen.findByRole('link', { name: 'Open admin panel' })
    expect(link).toHaveAttribute('href', '/api/v1/plugins/rbac/admin')
  })

  it('shows no admin panel link when the plugin has no admin_ingress', async () => {
    fetchInstalledPlugins.mockResolvedValue([rbacPlugin])
    render(<InstalledPluginDetail name="rbac" />)

    await screen.findByRole('heading', { name: 'rbac' })
    expect(screen.queryByRole('link', { name: 'Open admin panel' })).not.toBeInTheDocument()
  })

  it('shows a not-installed message when no installed plugin matches the name', async () => {
    fetchInstalledPlugins.mockResolvedValue([rbacPlugin])
    render(<InstalledPluginDetail name="does-not-exist" />)

    expect(await screen.findByText(/is not installed/i)).toBeInTheDocument()
    expect(screen.getByText(/Back to installed plugins/i)).toBeInTheDocument()
  })

  it('shows an error message when the fetch fails', async () => {
    fetchInstalledPlugins.mockRejectedValue(new Error('network down'))
    render(<InstalledPluginDetail name="rbac" />)

    await waitFor(() => {
      expect(screen.getByText('network down')).toBeInTheDocument()
    })
  })

  it('re-fetches when the name prop changes', async () => {
    fetchInstalledPlugins.mockResolvedValue([rbacPlugin])
    const { rerender } = render(<InstalledPluginDetail name="rbac" />)
    await screen.findByRole('heading', { name: 'rbac' })

    rerender(<InstalledPluginDetail name="does-not-exist" />)

    await screen.findByText(/is not installed/i)
  })
})
