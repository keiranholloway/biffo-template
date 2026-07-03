import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import EndpointsPage from './page'
import { ApiError } from '@/lib/api-client'
import type * as ApiClientModule from '@/lib/api-client'
import type * as EndpointApiModule from '@/lib/endpoint-api'
import type { Endpoint } from '@/lib/endpoint-api'

vi.mock('@/context/auth-context', () => ({
  useAuth: () => ({ getIdToken: () => 'fake-token' }),
}))

// Preserve the real ApiError (the page maps by err.status) while stubbing the client.
vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('@/lib/api-client')
  return {
    ...actual,
    createApiClient: () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }),
  }
})

const { fetchEndpoints, changeEndpointPermission } = vi.hoisted(() => ({
  fetchEndpoints: vi.fn(),
  changeEndpointPermission: vi.fn(),
}))
vi.mock('@/lib/endpoint-api', async () => {
  const actual = await vi.importActual<typeof EndpointApiModule>('@/lib/endpoint-api')
  return { ...actual, fetchEndpoints, changeEndpointPermission }
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
  {
    source: 'core',
    plugin: null,
    table: 'widgets',
    operation: 'list',
    method: 'GET',
    path: '/api/v1/data/widgets',
    required_role: [],
  },
]

describe('EndpointsPage', () => {
  beforeEach(() => {
    fetchEndpoints.mockReset()
    changeEndpointPermission.mockReset()
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
    expect(screen.getAllByText('any authenticated').length).toBeGreaterThanOrEqual(1)
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

  it('offers a Change control only for plugin endpoints, not core', async () => {
    fetchEndpoints.mockResolvedValue(endpoints)

    render(<EndpointsPage />)

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Change' })).toHaveLength(2)
    })
    // the core row shows an "in code" hint instead
    expect(screen.getByText('in code')).toBeInTheDocument()
  })

  it('opens a PR when an admin changes a plugin permission, then shows the link', async () => {
    fetchEndpoints.mockResolvedValue(endpoints)
    changeEndpointPermission.mockResolvedValue({
      pr_url: 'https://github.com/o/r/pull/12',
      branch: 'biffo/endpoint-rbac',
    })
    const user = userEvent.setup()

    render(<EndpointsPage />)
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Change' })).toHaveLength(2)
    })

    // Edit the first plugin endpoint (list, currently any-authenticated).
    const firstChange = screen.getAllByRole('button', { name: 'Change' }).at(0)
    if (firstChange == null) throw new Error('expected a Change button')
    await user.click(firstChange)
    const form = screen.getByLabelText('Change permission for GET /api/v1/plugins/rbac/roles')
    // Require the editor role, then open the PR.
    await user.click(within(form).getByLabelText('editor'))
    await user.click(within(form).getByRole('button', { name: 'Open pull request' }))

    await waitFor(() => {
      expect(changeEndpointPermission).toHaveBeenCalledTimes(1)
    })
    const sentReq = changeEndpointPermission.mock.calls[0]?.[1] as
      EndpointApiModule.EndpointPermissionRequest | undefined
    expect(sentReq).toEqual({
      plugin: 'rbac',
      table: 'rbac_roles',
      operation: 'list',
      allowed: true,
      required_role: ['editor'],
    })
    const link = await screen.findByRole('link', { name: 'Review pull request' })
    expect(link).toHaveAttribute('href', 'https://github.com/o/r/pull/12')
  })

  it('maps a 409 from the signer to a friendly message', async () => {
    fetchEndpoints.mockResolvedValue(endpoints)
    changeEndpointPermission.mockRejectedValue(new ApiError(409, 'already set'))
    const user = userEvent.setup()

    render(<EndpointsPage />)
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Change' })).toHaveLength(2)
    })

    const firstChange = screen.getAllByRole('button', { name: 'Change' }).at(0)
    if (firstChange == null) throw new Error('expected a Change button')
    await user.click(firstChange)
    const form = screen.getByLabelText('Change permission for GET /api/v1/plugins/rbac/roles')
    await user.click(within(form).getByRole('button', { name: 'Open pull request' }))

    await waitFor(() => {
      expect(screen.getByText(/already set this way/i)).toBeInTheDocument()
    })
    // No success banner on failure.
    expect(screen.queryByRole('link', { name: 'Review pull request' })).not.toBeInTheDocument()
  })
})
