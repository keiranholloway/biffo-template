import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CognitoUserSession } from 'amazon-cognito-identity-js'
import LoginPage from './page'

const {
  pushMock,
  loginMock,
  requestPasswordReset,
  confirmPasswordReset,
  completeNewPassword,
  setSessionMock,
  fetchWhoamiMock,
} = vi.hoisted(() => ({
  pushMock: vi.fn(),
  loginMock: vi.fn(),
  requestPasswordReset: vi.fn(),
  confirmPasswordReset: vi.fn(),
  completeNewPassword: vi.fn(),
  setSessionMock: vi.fn(),
  fetchWhoamiMock: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => ({ get: () => null }),
}))

const logoutMock = vi.fn()
// A session here means "already signed in", which is the forward path.
let currentSession: unknown = null
vi.mock('@/context/auth-context', () => ({
  useAuth: () => ({
    login: loginMock,
    setSession: setSessionMock,
    session: currentSession,
    logout: logoutMock,
  }),
}))

vi.mock('@/lib/auth', () => ({
  requestPasswordReset,
  confirmPasswordReset,
  completeNewPassword,
}))

vi.mock('@/lib/api-client', () => ({
  createApiClient: () => ({ get: vi.fn() }),
}))

vi.mock('@/lib/whoami-api', () => ({
  fetchWhoami: fetchWhoamiMock,
}))

// Cross-app destinations leave the portal, so the page uses a full page load
// (window.location.assign) rather than the client-side router — see
// isWithinPortal. jsdom implements no navigation, so it has to be stubbed, and
// asserting on the RIGHT one of the two is the point: a client-side push to
// /crm/ would look fine in a test that stubbed isWithinPortal to true, and
// break in a browser, because the portal app has no such route.
const assignMock = vi.fn()
beforeEach(() => {
  assignMock.mockClear()
  // Built explicitly rather than spread from window.location: that is a class
  // instance, and spreading it drops its prototype (@typescript-eslint/no-misused-spread).
  Object.defineProperty(window, 'location', {
    value: { href: '', pathname: '/login/', search: '', assign: assignMock },
    writable: true,
    configurable: true,
  })
})

// Cognito surfaces failures as Error instances whose `name` is the exception code.
function cognitoError(name: string): Error {
  const err = new Error(name)
  err.name = name
  return err
}

function openResetFlow() {
  render(<LoginPage />)
  fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }))
}

function requestCodeFor(username: string) {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: username } })
  fireEvent.click(screen.getByRole('button', { name: 'Send reset code' }))
}

function submitNewPassword(code: string, pw: string, confirm = pw) {
  fireEvent.change(screen.getByLabelText('Reset code'), { target: { value: code } })
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: pw } })
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: confirm } })
  fireEvent.click(screen.getByRole('button', { name: 'Reset password' }))
}

/** Mock session with ID token that can be read */
function mockSession(overrides?: Partial<CognitoUserSession>): CognitoUserSession {
  return {
    getIdToken: () => ({
      getJwtToken: () => 'mock-token',
      decodePayload: () => ({ 'cognito:groups': [] }),
    }),
    ...overrides,
  } as unknown as CognitoUserSession
}

describe('LoginPage password reset', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the forgot-password link on the sign-in form and opens the reset view', () => {
    render(<LoginPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }))
    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send reset code' })).toBeInTheDocument()
  })

  it('requests a reset code, then confirms with the code and new password', async () => {
    requestPasswordReset.mockResolvedValue(undefined)
    confirmPasswordReset.mockResolvedValue(undefined)

    openResetFlow()
    requestCodeFor('founder@example.com')

    await waitFor(() => {
      expect(requestPasswordReset).toHaveBeenCalledWith('founder@example.com')
    })
    expect(await screen.findByLabelText('Reset code')).toBeInTheDocument()

    submitNewPassword('123456', 'NewPassw0rd!')

    await waitFor(() => {
      expect(confirmPasswordReset).toHaveBeenCalledWith(
        'founder@example.com',
        '123456',
        'NewPassw0rd!',
      )
    })
    // On success it drops back to the sign-in form.
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('does not disclose whether the account exists when the user is unknown', async () => {
    requestPasswordReset.mockRejectedValue(cognitoError('UserNotFoundException'))

    openResetFlow()
    requestCodeFor('ghost@example.com')

    // Generic notice, and it still advances to code entry (no enumeration).
    expect(
      await screen.findByText(/if an account exists for that email address/i),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Reset code')).toBeInTheDocument()
  })

  it('surfaces a rate-limit error when requesting a code too often', async () => {
    requestPasswordReset.mockRejectedValue(cognitoError('LimitExceededException'))

    openResetFlow()
    requestCodeFor('founder@example.com')

    expect(await screen.findByText(/too many attempts/i)).toBeInTheDocument()
    // Did not advance to the confirm step.
    expect(screen.queryByLabelText('Reset code')).not.toBeInTheDocument()
  })

  it('shows a friendly message for a mismatched code', async () => {
    requestPasswordReset.mockResolvedValue(undefined)
    confirmPasswordReset.mockRejectedValue(cognitoError('CodeMismatchException'))

    openResetFlow()
    requestCodeFor('founder@example.com')
    await screen.findByLabelText('Reset code')
    submitNewPassword('000000', 'NewPassw0rd!')

    expect(await screen.findByText(/that code is not correct/i)).toBeInTheDocument()
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('shows a friendly message for an expired code', async () => {
    requestPasswordReset.mockResolvedValue(undefined)
    confirmPasswordReset.mockRejectedValue(cognitoError('ExpiredCodeException'))

    openResetFlow()
    requestCodeFor('founder@example.com')
    await screen.findByLabelText('Reset code')
    submitNewPassword('123456', 'NewPassw0rd!')

    expect(await screen.findByText(/that code has expired/i)).toBeInTheDocument()
  })

  it('shows a friendly message when confirmation is rate-limited', async () => {
    requestPasswordReset.mockResolvedValue(undefined)
    confirmPasswordReset.mockRejectedValue(cognitoError('LimitExceededException'))

    openResetFlow()
    requestCodeFor('founder@example.com')
    await screen.findByLabelText('Reset code')
    submitNewPassword('123456', 'NewPassw0rd!')

    expect(await screen.findByText(/too many attempts/i)).toBeInTheDocument()
  })

  it('rejects mismatched new passwords before calling Cognito', async () => {
    requestPasswordReset.mockResolvedValue(undefined)

    openResetFlow()
    requestCodeFor('founder@example.com')
    await screen.findByLabelText('Reset code')
    submitNewPassword('123456', 'NewPassw0rd!', 'Different!')

    expect(await screen.findByText('Passwords do not match')).toBeInTheDocument()
    expect(confirmPasswordReset).not.toHaveBeenCalled()
  })

  it('can return to the sign-in form from the reset view', async () => {
    openResetFlow()
    fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
  })
})

describe('LoginPage role-based routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('routes to /crm/ for users with tenant-level roles', async () => {
    const whoami = {
      sub: 'sub-123',
      email: 'founder@example.com',
      username: 'founder@example.com',
      user_id: 'user-123',
      is_platform_admin: false,
      permissions: [],
      marketplace_role: null,
      roles: [{ role: 'manager', scope_level: 'tenant' }],
    }

    loginMock.mockResolvedValue({
      kind: 'success',
      session: mockSession(),
    })

    fetchWhoamiMock.mockResolvedValue(whoami)

    render(<LoginPage />)
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'founder@example.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => {
      expect(assignMock).toHaveBeenCalledWith('/crm/')
    })
  })

  it('routes to /admin/ for users in the admin Cognito group', async () => {
    const whoami = {
      sub: 'sub-123',
      email: 'admin@example.com',
      username: 'admin@example.com',
      user_id: 'user-123',
      is_platform_admin: false,
      permissions: [],
      marketplace_role: null,
      roles: [],
    }

    const sessionWithAdminGroup: CognitoUserSession = {
      getIdToken: () => ({
        getJwtToken: () => 'mock-token',
        decodePayload: () => ({ 'cognito:groups': ['admin'] }),
      }),
    } as unknown as CognitoUserSession

    loginMock.mockResolvedValue({
      kind: 'success',
      session: sessionWithAdminGroup,
    })

    fetchWhoamiMock.mockResolvedValue(whoami)

    render(<LoginPage />)
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'admin@example.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/admin/')
    })
  })

  it('routes to /login/no-access/ for users with no roles or access', async () => {
    const whoami = {
      sub: 'sub-123',
      email: 'user@example.com',
      username: 'user@example.com',
      user_id: 'user-123',
      is_platform_admin: false,
      permissions: [],
      marketplace_role: null,
      roles: [],
    }

    loginMock.mockResolvedValue({
      kind: 'success',
      session: mockSession(),
    })

    fetchWhoamiMock.mockResolvedValue(whoami)

    render(<LoginPage />)
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => {
      expect(assignMock).toHaveBeenCalledWith('/login/no-access/')
    })
  })
})

describe('LoginPage — arriving already signed in', () => {
  // Sign-in is shared across every surface on this origin, so landing here with
  // a live session is ordinary (a bookmark, a stale link), not a sign someone
  // wants to switch account. Re-presenting the password form is noise.
  afterEach(() => {
    currentSession = null
    logoutMock.mockClear()
  })

  it('routes an already-authenticated visitor instead of asking again', async () => {
    currentSession = mockSession()
    fetchWhoamiMock.mockResolvedValue({
      sub: 's',
      email: 'e',
      username: 'u',
      user_id: 'u1',
      is_platform_admin: false,
      permissions: [],
      marketplace_role: null,
      roles: [{ role: 'HQ Admin', scope_level: 'tenant' }],
    })

    render(<LoginPage />)

    await waitFor(() => {
      expect(assignMock).toHaveBeenCalledWith('/crm/')
    })
  })

  it('offers a way out, because signing out is shared across every surface', async () => {
    currentSession = mockSession()
    fetchWhoamiMock.mockResolvedValue({
      sub: 's',
      email: 'e',
      username: 'u',
      user_id: 'u1',
      is_platform_admin: false,
      permissions: [],
      marketplace_role: null,
      roles: [{ role: 'HQ Admin', scope_level: 'tenant' }],
    })

    render(<LoginPage />)

    const signOut = await screen.findByRole('button', { name: 'Not you? Sign out' })
    fireEvent.click(signOut)
    expect(logoutMock).toHaveBeenCalled()
  })
})
