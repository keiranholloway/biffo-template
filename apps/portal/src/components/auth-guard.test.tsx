import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthGuard } from './auth-guard'

const { pushMock, useAuthMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  useAuthMock: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

vi.mock('@/context/auth-context', () => ({
  useAuth: () =>
    useAuthMock() as {
      session: { id: string } | null
      loading: boolean
    },
}))

describe('AuthGuard', () => {
  beforeEach(() => {
    pushMock.mockClear()
    useAuthMock.mockReturnValue({ session: null, loading: false })
  })

  it('renders children when authenticated', () => {
    useAuthMock.mockReturnValue({
      session: { id: 'user-123' },
      loading: false,
    })

    const { getByText } = render(
      <AuthGuard>
        <div>Protected content</div>
      </AuthGuard>,
    )

    expect(getByText('Protected content')).toBeInTheDocument()
  })

  it('redirects to login with return_to when not authenticated', async () => {
    // Set up window.location to simulate deep link
    const testPathname = '/admin/users/'
    const testSearch = '?sort=name'

    Object.defineProperty(window, 'location', {
      value: {
        pathname: testPathname,
        search: testSearch,
        href: `http://localhost:3000${testPathname}${testSearch}`,
      },
      writable: true,
      configurable: true,
    })

    render(
      <AuthGuard>
        <div>Protected content</div>
      </AuthGuard>,
    )

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith(expect.stringContaining('/login/?return_to='))
    })

    // Verify the return_to contains both pathname and search
    expect(pushMock.mock.calls).toHaveLength(1)
    const callUrl = pushMock.mock.calls[0]?.[0] as string
    const urlParams = new URLSearchParams(callUrl.split('?')[1])
    const returnTo = urlParams.get('return_to')

    expect(returnTo).toBe(testPathname + testSearch)
  })

  it('preserves query strings in the return_to param', async () => {
    const testPathname = '/admin/settings/'
    const testSearch = '?tab=profile&view=details'

    Object.defineProperty(window, 'location', {
      value: {
        pathname: testPathname,
        search: testSearch,
        href: `http://localhost:3000${testPathname}${testSearch}`,
      },
      writable: true,
      configurable: true,
    })

    render(
      <AuthGuard>
        <div>Protected content</div>
      </AuthGuard>,
    )

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalled()
    })

    expect(pushMock.mock.calls).toHaveLength(1)
    const callUrl = pushMock.mock.calls[0]?.[0] as string
    const urlParams = new URLSearchParams(callUrl.split('?')[1])
    const returnTo = urlParams.get('return_to')

    expect(returnTo).toContain('tab=profile')
    expect(returnTo).toContain('view=details')
  })

  it('shows loading spinner while session is being checked', () => {
    useAuthMock.mockReturnValue({
      session: null,
      loading: true,
    })

    const { container } = render(
      <AuthGuard>
        <div>Protected content</div>
      </AuthGuard>,
    )

    // Check for loading spinner element
    const spinner = container.querySelector('.animate-spin')
    expect(spinner).toBeInTheDocument()
  })

  it('does not redirect when loading', () => {
    useAuthMock.mockReturnValue({
      session: null,
      loading: true,
    })

    render(
      <AuthGuard>
        <div>Protected content</div>
      </AuthGuard>,
    )

    expect(pushMock).not.toHaveBeenCalled()
  })
})
