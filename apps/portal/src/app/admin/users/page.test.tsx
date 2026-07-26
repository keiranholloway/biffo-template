import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import UsersPage from './page'
import type * as UserAdminApiModule from '@/lib/user-admin-api'
import type { AdminUser } from '@/lib/user-admin-api'

const { useAuthMock } = vi.hoisted(() => ({ useAuthMock: vi.fn() }))

vi.mock('@/context/auth-context', () => ({
  useAuth: useAuthMock,
}))

/** A fake session whose ID token carries the given sub — used to make the
 * signed-in admin "be" a specific row (#630's self-lockout guard). */
function sessionWithSub(sub: string) {
  return { getIdToken: () => ({ payload: { sub } }) }
}

vi.mock('@/lib/api-client', () => ({
  createApiClient: () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }),
}))

const {
  fetchUsers,
  fetchGroups,
  fetchOrganizations,
  createOrganization,
  createUser,
  assignGroup,
  removeGroup,
  suspendUser,
  reactivateUser,
  deleteUser,
} = vi.hoisted(() => ({
  fetchUsers: vi.fn(),
  fetchGroups: vi.fn(),
  fetchOrganizations: vi.fn(),
  createOrganization: vi.fn(),
  createUser: vi.fn(),
  assignGroup: vi.fn(),
  removeGroup: vi.fn(),
  suspendUser: vi.fn(),
  reactivateUser: vi.fn(),
  deleteUser: vi.fn(),
}))

vi.mock('@/lib/user-admin-api', async () => {
  const actual = await vi.importActual<typeof UserAdminApiModule>('@/lib/user-admin-api')
  return {
    ...actual, // keeps ASSIGNABLE_GROUPS
    fetchUsers,
    fetchGroups,
    fetchOrganizations,
    createOrganization,
    createUser,
    assignGroup,
    removeGroup,
    suspendUser,
    reactivateUser,
    deleteUser,
  }
})

const alice: AdminUser = {
  username: 'alice@example.com',
  sub: 's1',
  email: 'alice@example.com',
  status: 'CONFIRMED',
  enabled: true,
  groups: ['editor'],
  created_at: null,
  given_name: 'Alice',
  family_name: 'Anderson',
  phone_number: null,
  organization_id: null,
  organization_name: null,
  job_role: null,
  address_line1: null,
  address_line2: null,
  city: null,
  region: null,
  postal_code: null,
  country: null,
}

const bob: AdminUser = {
  username: 'bob@example.com',
  sub: 's2',
  email: 'bob@example.com',
  status: 'CONFIRMED',
  enabled: false,
  groups: [],
  created_at: null,
  given_name: 'Bob',
  family_name: 'Baker',
  phone_number: null,
  organization_id: null,
  organization_name: null,
  job_role: null,
  address_line1: null,
  address_line2: null,
  city: null,
  region: null,
  postal_code: null,
  country: null,
}

describe('UsersPage', () => {
  beforeEach(() => {
    for (const fn of [
      fetchUsers,
      fetchGroups,
      fetchOrganizations,
      createOrganization,
      createUser,
      assignGroup,
      removeGroup,
      suspendUser,
      reactivateUser,
      deleteUser,
    ]) {
      fn.mockReset()
    }
    fetchGroups.mockResolvedValue({ groups: ['admin', 'editor', 'viewer'] })
    fetchOrganizations.mockResolvedValue({ organizations: [] })
    useAuthMock.mockReturnValue({ getIdToken: () => 'fake-token', session: undefined })
  })

  it('renders users with email, status and groups', async () => {
    fetchUsers.mockResolvedValue({ users: [alice, bob], next_token: null })

    render(<UsersPage />)

    expect(await screen.findByText('alice@example.com')).toBeInTheDocument()
    // "editor" also appears in the create-form checkboxes, so match ≥1.
    expect(screen.getAllByText('editor').length).toBeGreaterThanOrEqual(1)
    // bob is disabled -> shows the suspended badge
    expect(screen.getByText('suspended')).toBeInTheDocument()
  })

  it('shows an empty state when there are no users', async () => {
    fetchUsers.mockResolvedValue({ users: [], next_token: null })
    render(<UsersPage />)
    expect(await screen.findByText('No users yet')).toBeInTheDocument()
  })

  it('creates a user from the form', async () => {
    fetchUsers.mockResolvedValue({ users: [], next_token: null })
    createUser.mockResolvedValue(alice)

    render(<UsersPage />)
    await screen.findByText('No users yet')

    fireEvent.change(screen.getByPlaceholderText('person@example.com'), {
      target: { value: 'new@example.com' },
    })
    fireEvent.change(screen.getByPlaceholderText('Jamie'), { target: { value: 'New' } })
    fireEvent.change(screen.getByPlaceholderText('Rivera'), { target: { value: 'User' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }))

    await waitFor(() => {
      expect(createUser).toHaveBeenCalledWith(expect.anything(), {
        email: 'new@example.com',
        given_name: 'New',
        family_name: 'User',
        phone_number: undefined,
        groups: [],
        organization_id: undefined,
        job_role: undefined,
        address_line1: undefined,
        address_line2: undefined,
        city: undefined,
        region: undefined,
        postal_code: undefined,
        country: undefined,
      })
    })
  })

  it('suspends an enabled user', async () => {
    fetchUsers.mockResolvedValue({ users: [alice], next_token: null })
    suspendUser.mockResolvedValue({ ...alice, enabled: false })

    render(<UsersPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Suspend' }))

    await waitFor(() => {
      expect(suspendUser).toHaveBeenCalledWith(expect.anything(), 'alice@example.com')
    })
  })

  it('reactivates a suspended user', async () => {
    fetchUsers.mockResolvedValue({ users: [bob], next_token: null })
    reactivateUser.mockResolvedValue({ ...bob, enabled: true })

    render(<UsersPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Reactivate' }))

    await waitFor(() => {
      expect(reactivateUser).toHaveBeenCalledWith(expect.anything(), 'bob@example.com')
    })
  })

  it('deletes a user', async () => {
    fetchUsers.mockResolvedValue({ users: [alice], next_token: null })
    deleteUser.mockResolvedValue(undefined)

    render(<UsersPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(deleteUser).toHaveBeenCalledWith(expect.anything(), 'alice@example.com')
    })
  })

  it('assigns a group via the add-group select', async () => {
    fetchUsers.mockResolvedValue({ users: [alice], next_token: null })
    assignGroup.mockResolvedValue({ ...alice, groups: ['editor', 'admin'] })

    render(<UsersPage />)
    const select = await screen.findByLabelText('Add group to alice@example.com')
    fireEvent.change(select, { target: { value: 'admin' } })

    await waitFor(() => {
      expect(assignGroup).toHaveBeenCalledWith(expect.anything(), 'alice@example.com', 'admin')
    })
  })

  it('removes a group via the chip', async () => {
    fetchUsers.mockResolvedValue({ users: [alice], next_token: null })
    removeGroup.mockResolvedValue({ ...alice, groups: [] })

    render(<UsersPage />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Remove editor from alice@example.com' }),
    )

    await waitFor(() => {
      expect(removeGroup).toHaveBeenCalledWith(expect.anything(), 'alice@example.com', 'editor')
    })
  })

  it('surfaces an error when the fetch fails', async () => {
    fetchUsers.mockRejectedValue(new Error('boom'))
    render(<UsersPage />)
    expect(await screen.findByText('boom')).toBeInTheDocument()
  })

  it('populates the group picker from the API (custom taxonomy)', async () => {
    fetchUsers.mockResolvedValue({ users: [], next_token: null })
    fetchGroups.mockResolvedValue({ groups: ['admin', 'billing'] })

    render(<UsersPage />)

    // The custom "billing" group (not in the hardcoded fallback) appears as an
    // assignable checkbox in the Add-user form.
    expect(await screen.findByLabelText('billing')).toBeInTheDocument()
  })

  describe('self-lockout guard (#630)', () => {
    it("disables Suspend and Delete on the signed-in admin's own row", async () => {
      useAuthMock.mockReturnValue({ getIdToken: () => 'fake-token', session: sessionWithSub('s1') })
      fetchUsers.mockResolvedValue({ users: [alice, bob], next_token: null })

      render(<UsersPage />)
      await screen.findByText('alice@example.com')

      const rows = screen.getAllByRole('row')
      const aliceRow = rows.find((r) => r.textContent.includes('alice@example.com'))
      const bobRow = rows.find((r) => r.textContent.includes('bob@example.com'))

      expect(aliceRow).toBeDefined()
      expect(bobRow).toBeDefined()

      expect(within(aliceRow!).getByRole('button', { name: 'Suspend' })).toBeDisabled()

      expect(within(aliceRow!).getByRole('button', { name: 'Delete' })).toBeDisabled()
      expect(screen.getByText('(you)')).toBeInTheDocument()

      // bob is a different user — unaffected.

      expect(within(bobRow!).getByRole('button', { name: 'Reactivate' })).not.toBeDisabled()
    })

    it("does not disable another admin's row", async () => {
      useAuthMock.mockReturnValue({
        getIdToken: () => 'fake-token',
        session: sessionWithSub('a-different-sub'),
      })
      fetchUsers.mockResolvedValue({ users: [alice], next_token: null })

      render(<UsersPage />)
      expect(await screen.findByRole('button', { name: 'Suspend' })).not.toBeDisabled()
      expect(screen.queryByText('(you)')).not.toBeInTheDocument()
    })

    it('disables removing the admin group, but not other groups, on the own row', async () => {
      const self = { ...alice, groups: ['admin', 'editor'] }
      useAuthMock.mockReturnValue({ getIdToken: () => 'fake-token', session: sessionWithSub('s1') })
      fetchUsers.mockResolvedValue({ users: [self], next_token: null })

      render(<UsersPage />)
      await screen.findByText('alice@example.com')

      expect(
        screen.getByRole('button', { name: 'Remove admin from alice@example.com' }),
      ).toBeDisabled()
      expect(
        screen.getByRole('button', { name: 'Remove editor from alice@example.com' }),
      ).not.toBeDisabled()
    })
  })
})
