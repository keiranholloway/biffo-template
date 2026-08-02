import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentSession: vi.fn(),
}))

// Read at module-evaluation time; stub before the dynamic import below so the
// component sees the value (same pattern as page.test.tsx).
process.env['NEXT_PUBLIC_CORE_PORTAL_URL'] = 'https://core.example.com'
process.env['NEXT_PUBLIC_SIBLING_PATH_PREFIX'] = '/my-sibling'

const { getCurrentSession } = await import('@/lib/auth')
const { AuthGate } = await import('./auth-gate')

function fakeSession(idToken: string, claims: Record<string, unknown> = {}) {
  return {
    getIdToken: () => ({ getJwtToken: () => idToken, decodePayload: () => claims }),
  } as unknown as Awaited<ReturnType<typeof getCurrentSession>>
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AuthGate', () => {
  it('renders children once a valid session resolves', async () => {
    vi.mocked(getCurrentSession).mockResolvedValueOnce(fakeSession('a-jwt'))

    render(
      <AuthGate>
        <p>secret content</p>
      </AuthGate>,
    )

    await waitFor(() => {
      expect(screen.getByText('secret content')).toBeInTheDocument()
    })
  })

  it('passes the session to a render-prop child', async () => {
    vi.mocked(getCurrentSession).mockResolvedValueOnce(fakeSession('token-1234'))

    render(<AuthGate>{(session) => <p>token: {session.getIdToken().getJwtToken()}</p>}</AuthGate>)

    await waitFor(() => {
      expect(screen.getByText('token: token-1234')).toBeInTheDocument()
    })
  })

  it('redirects to the core portal login, returning to the current path, when there is no session', async () => {
    vi.mocked(getCurrentSession).mockResolvedValueOnce(null)

    // jsdom's real window.location throws on navigation — swap in a plain
    // object so we can inspect the attempted href (same trick as page.test.tsx).
    const originalLocation = window.location
    Object.defineProperty(window, 'location', {
      value: { href: '', pathname: '/my-sibling/example/members/', search: '' },
      writable: true,
      configurable: true,
    })

    render(
      <AuthGate>
        <p>secret content</p>
      </AuthGate>,
    )

    await waitFor(() => {
      expect(window.location.href).toBe(
        'https://core.example.com/login?return_to=' +
          encodeURIComponent('/my-sibling/example/members/'),
      )
    })
    expect(screen.queryByText('secret content')).not.toBeInTheDocument()

    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    })
  })
})

/**
 * A session is not an authorisation.
 *
 * `AuthGate` used to answer one question — is anybody signed in? — so every
 * sibling that needed "signed in AND allowed" hand-rolled the second half.
 * The core portal's own guard had the identical hole and shipped it: any
 * authenticated user rendered the whole /admin console (biffo-template#1104).
 * A sibling that hand-rolls it gets it wrong differently each time; one such
 * gate very nearly shipped gating completion reports on an *authoring*
 * permission, which would have refused precisely the oversight roles the
 * reports exist for.
 *
 * So the second question is asked here, once, with one refusal surface.
 */
describe('AuthGate authorisation', () => {
  it('renders children when the session carries one of the required groups', async () => {
    vi.mocked(getCurrentSession).mockResolvedValueOnce(
      fakeSession('a-jwt', { 'cognito:groups': ['editor'] }),
    )

    render(
      <AuthGate requireGroups={['admin', 'editor']}>
        <p>secret content</p>
      </AuthGate>,
    )

    await waitFor(() => {
      expect(screen.getByText('secret content')).toBeInTheDocument()
    })
  })

  it('refuses a signed-in user whose token has no groups claim at all', async () => {
    vi.mocked(getCurrentSession).mockResolvedValueOnce(fakeSession('a-jwt'))

    render(
      <AuthGate requireGroups={['admin']}>
        <p>secret content</p>
      </AuthGate>,
    )

    await waitFor(() => {
      expect(screen.getByRole('heading')).toHaveTextContent('No access')
    })
    expect(screen.queryByText('secret content')).not.toBeInTheDocument()
  })

  it('does not bounce a refused user to the portal login — they are already signed in', async () => {
    vi.mocked(getCurrentSession).mockResolvedValueOnce(fakeSession('a-jwt'))

    const originalLocation = window.location
    Object.defineProperty(window, 'location', {
      value: { href: '', pathname: '/my-sibling/reports/', search: '' },
      writable: true,
      configurable: true,
    })

    render(
      <AuthGate requireGroups={['admin']}>
        <p>secret content</p>
      </AuthGate>,
    )

    await waitFor(() => {
      expect(screen.getByRole('heading')).toHaveTextContent('No access')
    })
    expect(window.location.href).toBe('')

    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    })
  })

  it('honours an `authorize` predicate for anything groups cannot express', async () => {
    vi.mocked(getCurrentSession).mockResolvedValueOnce(
      fakeSession('a-jwt', { 'custom:permissions': 'enrollments.read' }),
    )

    render(
      <AuthGate
        authorize={(session) =>
          session.getIdToken().decodePayload()['custom:permissions'] === 'enrollments.read'
        }
      >
        <p>secret content</p>
      </AuthGate>,
    )

    await waitFor(() => {
      expect(screen.getByText('secret content')).toBeInTheDocument()
    })
  })

  it('shows the caller-supplied refusal message rather than the generic one', async () => {
    vi.mocked(getCurrentSession).mockResolvedValueOnce(fakeSession('a-jwt'))

    render(
      <AuthGate requireGroups={['admin']} noAccessMessage="You don't have access to reports.">
        <p>secret content</p>
      </AuthGate>,
    )

    await waitFor(() => {
      expect(screen.getByText("You don't have access to reports.")).toBeInTheDocument()
    })
  })

  it('fails closed when the ID token cannot be decoded', async () => {
    vi.mocked(getCurrentSession).mockResolvedValueOnce({
      getIdToken: () => {
        throw new Error('malformed token')
      },
    } as unknown as Awaited<ReturnType<typeof getCurrentSession>>)

    render(
      <AuthGate requireGroups={['admin']}>
        <p>secret content</p>
      </AuthGate>,
    )

    await waitFor(() => {
      expect(screen.getByRole('heading')).toHaveTextContent('No access')
    })
  })

  it('still yields on the session alone when nothing is required', async () => {
    // Public-by-default is the sibling contract; asking only for a session
    // stays a legitimate, and common, thing to want.
    vi.mocked(getCurrentSession).mockResolvedValueOnce(fakeSession('a-jwt'))

    render(
      <AuthGate>
        <p>secret content</p>
      </AuthGate>,
    )

    await waitFor(() => {
      expect(screen.getByText('secret content')).toBeInTheDocument()
    })
  })
})
