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

function fakeSession(idToken: string) {
  return {
    getIdToken: () => ({ getJwtToken: () => idToken }),
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
