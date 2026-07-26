import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PluginsPage from './page'
import type * as PluginApiModule from '@/lib/plugin-api'
import type { InstalledPlugin } from '@/lib/plugin-api'

vi.mock('@/context/auth-context', () => ({
  useAuth: () => ({ getIdToken: () => 'fake-token' }),
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
  tables: [{ name: 'rbac_roles', columns: [], indexes: [] }],
  routes: [
    { method: 'GET', path: '/roles', table: 'rbac_roles', operation: 'list', description: '' },
  ],
  has_admin_ingress: false,
}

describe('PluginsPage', () => {
  beforeEach(() => {
    fetchInstalledPlugins.mockReset()
  })

  it('renders installed plugins once loaded', async () => {
    fetchInstalledPlugins.mockResolvedValue([rbacPlugin])

    render(<PluginsPage />)

    await waitFor(() => {
      expect(screen.getByText('rbac')).toBeInTheDocument()
    })
  })

  it('shows a polished empty state when no plugins are installed', async () => {
    fetchInstalledPlugins.mockResolvedValue([])

    render(<PluginsPage />)

    await waitFor(() => {
      expect(screen.getByText('No plugins installed yet')).toBeInTheDocument()
    })
    expect(screen.getByText(/services\/orchestrator/)).toBeInTheDocument()
  })

  it('shows an error message when the fetch fails', async () => {
    fetchInstalledPlugins.mockRejectedValue(new Error('network down'))

    render(<PluginsPage />)

    await waitFor(() => {
      expect(screen.getByText('network down')).toBeInTheDocument()
    })
  })
})
