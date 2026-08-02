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

// The query string the page is mounted with. Mutable so a test can put a
// `return_to` in the URL the way AuthGuard's bounce does — the default of `{}`
// keeps every existing test on the no-return_to path.
let searchParams: Record<string, string> = {}
const replaceMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  useSearchParams: () => ({ get: (key: string) => searchParams[key] ?? null }),
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
  replaceMock.mockClear()
  searchParams = {}
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

/**
 * #1106 — a `return_to` that outlives the user it belonged to is not a deep
 * link, it is a leftover.
 *
 * Reproduced by the reporter's route: an admin is forwarded to /admin/; the
 * browser is bounced back to /login/?return_to=%2Fadmin%2F; "Not you? Sign
 * out" is clicked; a unit-scoped learner signs in. `resolveDestination`'s rule
 * 1 — "a valid returnTo wins" — outranks every role rule, so the learner
 * inherited the admin's destination and landed in the infrastructure console.
 *
 * Rule 1 is right in general. What was wrong is that nothing invalidated the
 * destination when the identity it was resolved for went away.
 */
describe('LoginPage — return_to must not outlive the user it belonged to', () => {
  const ADMIN = {
    sub: 'a',
    email: 'admin@example.com',
    username: 'a',
    user_id: 'u1',
    is_platform_admin: true,
    permissions: [],
    marketplace_role: null,
    roles: [],
  }
  const LEARNER = {
    sub: 's',
    email: 'learner@demo.example.com',
    username: 'u',
    user_id: 'u2',
    is_platform_admin: false,
    permissions: [],
    marketplace_role: null,
    roles: [{ role: 'Unit Staff', scope_level: 'unit' }],
  }

  beforeEach(() => {
    // The real `logout()` drops the session from context, which re-renders this
    // page with `session === null`. The mock must do the same or the test is
    // exercising a sign-out that never happened.
    logoutMock.mockImplementation(() => {
      currentSession = null
    })
  })

  afterEach(() => {
    currentSession = null
    logoutMock.mockReset()
  })

  /** Arrive signed in as the admin, with the bounce's return_to in the URL. */
  function arriveAsAdminBouncedFromAdminConsole() {
    searchParams = { return_to: '/admin/' }
    currentSession = mockSession()
    fetchWhoamiMock.mockResolvedValue(ADMIN)
    render(<LoginPage />)
  }

  it('routes the next person by role, not to the previous user’s destination', async () => {
    arriveAsAdminBouncedFromAdminConsole()

    const signOut = await screen.findByRole('button', { name: 'Not you? Sign out' })
    fireEvent.click(signOut)

    // The admin's own forward to /admin/ was legitimate — it is the next
    // person's destination this is about.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Not you? Sign out' })).not.toBeInTheDocument()
    })
    pushMock.mockClear()
    assignMock.mockClear()

    fetchWhoamiMock.mockResolvedValue(LEARNER)
    loginMock.mockResolvedValue({ kind: 'success', session: mockSession() })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: LEARNER.email } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    // A unit-scoped role lands on /crm/ (rule 5 in login-routing.ts), which
    // is a sibling app, so it leaves the portal with a full page load.
    //
    // This expectation was '/lms/' when the test was written earlier today.
    // ADR-0105 moved training into the CRM's unit workspace, so a unit worker's
    // home is /crm/ again. What this test is actually about is unchanged: the
    // next person to sign in must be routed by THEIR role, not to the previous
    // user's destination.
    await waitFor(() => {
      expect(assignMock).toHaveBeenCalledWith('/crm/')
    })
    expect(pushMock).not.toHaveBeenCalledWith('/admin/')
  })

  it('strips return_to from the address bar, so a reload cannot resurrect it', async () => {
    arriveAsAdminBouncedFromAdminConsole()

    const signOut = await screen.findByRole('button', { name: 'Not you? Sign out' })
    fireEvent.click(signOut)

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/login/')
    })
  })

  it('still honours a deep link for someone who never signed out', async () => {
    // The legitimate case rule 1 exists for (ADR-0007): a sibling app found no
    // session, bounced here with return_to, and the person who signs in is the
    // person who was sent.
    searchParams = { return_to: '/lms/course/abc/' }
    loginMock.mockResolvedValue({ kind: 'success', session: mockSession() })
    fetchWhoamiMock.mockResolvedValue(LEARNER)

    render(<LoginPage />)
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: LEARNER.email } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => {
      expect(assignMock).toHaveBeenCalledWith('/lms/course/abc/')
    })
    expect(replaceMock).not.toHaveBeenCalled()
  })
})
