import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentSession: vi.fn(),
}))

vi.mock('@/lib/api-client', () => ({
  ApiError: class ApiError extends Error {},
  createApiClient: vi.fn(),
}))

// process.env is read at module-evaluation time (page.tsx isn't run through
// Next's build-time NEXT_PUBLIC_ inlining here, just plain Vite/Node) — stub
// it and dynamically import afterwards so HomePage sees the value.
process.env['NEXT_PUBLIC_CORE_PORTAL_URL'] = 'https://core.example.com'
process.env['NEXT_PUBLIC_SIBLING_PATH_PREFIX'] = '/my-sibling'

const { getCurrentSession } = await import('@/lib/auth')
const { createApiClient } = await import('@/lib/api-client')
const { default: HomePage } = await import('./page')

function fakeSession(idToken: string) {
  return {
    getIdToken: () => ({ getJwtToken: () => idToken }),
  } as unknown as Awaited<ReturnType<typeof getCurrentSession>>
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('HomePage', () => {
  it('renders "Hello <username>" once the session and whoami call resolve', async () => {
    vi.mocked(getCurrentSession).mockResolvedValueOnce(fakeSession('a-jwt'))
    vi.mocked(createApiClient).mockReturnValue({
      get: vi.fn().mockResolvedValueOnce({ username: 'keiran' }),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    })

    render(<HomePage />)

    await waitFor(() => {
      expect(screen.getByText(/Hello keiran/)).toBeInTheDocument()
    })
  })

  it('redirects to the core portal login when there is no session', async () => {
    vi.mocked(getCurrentSession).mockResolvedValueOnce(null)

    // jsdom's real window.location throws "Not implemented: navigation" if
    // .href is actually set to a new URL — replace it with a plain object
    // so we can just inspect what the page tried to navigate to.
    const originalLocation = window.location
    Object.defineProperty(window, 'location', {
      value: { href: '' },
      writable: true,
      configurable: true,
    })

    render(<HomePage />)

    await waitFor(() => {
      expect(window.location.href).toContain('/login?return_to=')
    })

    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    })
  })
})
