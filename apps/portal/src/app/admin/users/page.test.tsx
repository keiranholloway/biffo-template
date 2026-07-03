import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import UsersPage from './page'
import type * as UserAdminApiModule from '@/lib/user-admin-api'
import type { AdminUser } from '@/lib/user-admin-api'

vi.mock('@/context/auth-context', () => ({
  useAuth: () => ({ getIdToken: () => 'fake-token' }),
}))

vi.mock('@/lib/api-client', () => ({
  createApiClient: () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }),
}))

const {
  fetchUsers,
  createUser,
  assignGroup,
  removeGroup,
  suspendUser,
  reactivateUser,
  deleteUser,
} = vi.hoisted(() => ({
  fetchUsers: vi.fn(),
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
}

const bob: AdminUser = {
  username: 'bob@example.com',
  sub: 's2',
  email: 'bob@example.com',
  status: 'CONFIRMED',
  enabled: false,
  groups: [],
  created_at: null,
}

describe('UsersPage', () => {
  beforeEach(() => {
    for (const fn of [
      fetchUsers,
      createUser,
      assignGroup,
      removeGroup,
      suspendUser,
      reactivateUser,
      deleteUser,
    ]) {
      fn.mockReset()
    }
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
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }))

    await waitFor(() => {
      expect(createUser).toHaveBeenCalledWith(expect.anything(), {
        email: 'new@example.com',
        groups: [],
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
})
