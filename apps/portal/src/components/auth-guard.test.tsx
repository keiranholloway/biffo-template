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

/**
 * A stand-in for the CognitoUserSession the real context yields, carrying only
 * what the guard reads: the ID token's decoded claims. `groups` of `undefined`
 * models the token of a user in no Cognito groups at all — the claim is simply
 * absent, which is exactly what the learner in #1104 presented.
 */
function sessionWithGroups(groups: string[] | undefined) {
  return {
    id: 'user-123',
    getIdToken: () => ({
      decodePayload: () => (groups === undefined ? {} : { 'cognito:groups': groups }),
    }),
  }
}

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

/**
 * #1104 — a session is not an authorisation.
 *
 * The guard used to yield on `session !== null` alone, so every signed-in user
 * rendered the whole /admin console: the microservices list with the estate's
 * deployment topology, and an "Add a user" form with an admin/editor/viewer
 * selector and an enabled submit button. The Core API refused each call
 * (`Administrator access required`), which is the last line of defence working
 * — not the only one that should exist.
 */
describe('AuthGuard requireGroup', () => {
  beforeEach(() => {
    pushMock.mockClear()
  })

  it('renders children when the session carries the required group', () => {
    useAuthMock.mockReturnValue({ session: sessionWithGroups(['admin']), loading: false })

    const { getByText } = render(
      <AuthGuard requireGroup="admin">
        <div>Protected content</div>
      </AuthGuard>,
    )

    expect(getByText('Protected content')).toBeInTheDocument()
  })

  it('refuses a signed-in user whose token has no groups claim at all', () => {
    // The exact shape of the #1104 reporter's token: authenticated, one
    // unit-scoped role in the database, `cognito:groups` absent entirely.
    useAuthMock.mockReturnValue({ session: sessionWithGroups(undefined), loading: false })

    const { queryByText, getByRole } = render(
      <AuthGuard requireGroup="admin">
        <div>Protected content</div>
      </AuthGuard>,
    )

    expect(queryByText('Protected content')).not.toBeInTheDocument()
    expect(getByRole('heading')).toHaveTextContent('No access')
  })

  it('refuses a signed-in user who holds other groups but not the required one', () => {
    useAuthMock.mockReturnValue({
      session: sessionWithGroups(['editor', 'viewer']),
      loading: false,
    })

    const { queryByText } = render(
      <AuthGuard requireGroup="admin">
        <div>Protected content</div>
      </AuthGuard>,
    )

    expect(queryByText('Protected content')).not.toBeInTheDocument()
  })

  it('does not bounce a refused user back to login', () => {
    // They ARE signed in. Pushing them at /login/ would either loop or strand
    // them, and #1106 showed what a stale return_to does on that page.
    useAuthMock.mockReturnValue({ session: sessionWithGroups(undefined), loading: false })

    render(
      <AuthGuard requireGroup="admin">
        <div>Protected content</div>
      </AuthGuard>,
    )

    expect(pushMock).not.toHaveBeenCalled()
  })

  it('offers a refused user somewhere to go, not just a sign-in link (#1310)', () => {
    // The refusal is from THIS surface only. Their roles may well admit another,
    // and /login/ forwards them to it through `resolveDestination` -- so this
    // page must name that route rather than telling a signed-in person to sign
    // in. WHERE it lands is instance-owned data and only verifiable deployed.
    useAuthMock.mockReturnValue({ session: sessionWithGroups(undefined), loading: false })

    const { getByRole, queryByText } = render(
      <AuthGuard requireGroup="admin">
        <div>Protected content</div>
      </AuthGuard>,
    )

    expect(queryByText('Back to sign in')).not.toBeInTheDocument()
    // Loose on the trailing slash: next/link drops it under jsdom, and the
    // source literal is guarded by internal-links.test.ts (#275) instead.
    expect(getByRole('link', { name: 'Go to your home page' }).getAttribute('href')).toMatch(
      /^\/login\/?$/,
    )
  })

  it('fails closed when the ID token cannot be decoded', () => {
    useAuthMock.mockReturnValue({
      session: {
        id: 'user-123',
        getIdToken: () => {
          throw new Error('malformed token')
        },
      },
      loading: false,
    })

    const { queryByText } = render(
      <AuthGuard requireGroup="admin">
        <div>Protected content</div>
      </AuthGuard>,
    )

    expect(queryByText('Protected content')).not.toBeInTheDocument()
  })

  it('still yields on session alone when no group is required', () => {
    // The guard stays usable for surfaces that only need "signed in" — the
    // point is that admin-ness must be asked for, not that it is implied.
    useAuthMock.mockReturnValue({ session: sessionWithGroups(undefined), loading: false })

    const { getByText } = render(
      <AuthGuard>
        <div>Protected content</div>
      </AuthGuard>,
    )

    expect(getByText('Protected content')).toBeInTheDocument()
  })
})
