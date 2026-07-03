import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import EndpointsPage from './page'
import type * as EndpointApiModule from '@/lib/endpoint-api'
import type { Endpoint } from '@/lib/endpoint-api'

vi.mock('@/context/auth-context', () => ({
  useAuth: () => ({ getIdToken: () => 'fake-token' }),
}))

vi.mock('@/lib/api-client', () => ({
  createApiClient: () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }),
}))

const { fetchEndpoints } = vi.hoisted(() => ({ fetchEndpoints: vi.fn() }))
vi.mock('@/lib/endpoint-api', async () => {
  const actual = await vi.importActual<typeof EndpointApiModule>('@/lib/endpoint-api')
  return { ...actual, fetchEndpoints }
})

const endpoints: Endpoint[] = [
  {
    source: 'plugin',
    plugin: 'rbac',
    table: 'rbac_roles',
    operation: 'list',
    method: 'GET',
    path: '/api/v1/plugins/rbac/roles',
    required_role: [],
  },
  {
    source: 'plugin',
    plugin: 'rbac',
    table: 'rbac_roles',
    operation: 'create',
    method: 'POST',
    path: '/api/v1/plugins/rbac/roles',
    required_role: ['admin'],
  },
]

describe('EndpointsPage', () => {
  beforeEach(() => {
    fetchEndpoints.mockReset()
  })

  it('renders the live endpoints with method, path and role', async () => {
    fetchEndpoints.mockResolvedValue(endpoints)

    render(<EndpointsPage />)

    await waitFor(() => {
      expect(screen.getAllByText('/api/v1/plugins/rbac/roles')).toHaveLength(2)
    })
    expect(screen.getByText('POST')).toBeInTheDocument()
    expect(screen.getByText('admin')).toBeInTheDocument()
    // empty required_role renders as "any authenticated"
    expect(screen.getByText('any authenticated')).toBeInTheDocument()
  })

  it('shows an empty state when nothing is exposed', async () => {
    fetchEndpoints.mockResolvedValue([])

    render(<EndpointsPage />)

    await waitFor(() => {
      expect(screen.getByText('No endpoints exposed yet')).toBeInTheDocument()
    })
  })

  it('shows an error message when the fetch fails', async () => {
    fetchEndpoints.mockRejectedValue(new Error('network down'))

    render(<EndpointsPage />)

    await waitFor(() => {
      expect(screen.getByText('network down')).toBeInTheDocument()
    })
  })
})
