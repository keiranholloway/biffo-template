import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CognitoUserSession } from 'amazon-cognito-identity-js'
import LoginPage from './page'
import AuthLayout from '../layout'
import { FORWARD_DELAY_MS } from './constants'

const {
  pushMock,
  loginMock,
  requestPasswordReset,
  confirmPasswordReset,
  completeNewPassword,
  setSessionMock,
  resolveWhoamiMock,
} = vi.hoisted(() => ({
  pushMock: vi.fn(),
  loginMock: vi.fn(),
  requestPasswordReset: vi.fn(),
  confirmPasswordReset: vi.fn(),
  completeNewPassword: vi.fn(),
  setSessionMock: vi.fn(),
  resolveWhoamiMock: vi.fn(),
}))

// The query string the page is mounted with. Mutable so a test can put a
// `return_to` in the URL the way AuthGuard's bounce does — the default of `{}`
// keeps every existing test on the no-return_to path.
let searchParams: Record<string, string> = {}
const replaceMock = vi.fn()
/**
 * An instance-shaped destination map, supplied through the seam the page reads
 * (#1098).
 *
 * These assertions are about the page's NAVIGATION branch -- `router.push` for
 * an in-portal destination, `window.location.assign` for a cross-app one -- so
 * they need a destination that is genuinely cross-app. The template default
 * sends every role outcome to `/admin/`, which is in-portal and would route
 * these cases through the router, quietly testing the other branch. Declaring a
 * map here keeps each test asserting what it was written to assert, and proves
 * the seam actually reaches the page.
 */
const ORG_DESTINATION = '/crm/'
vi.mock('@/instance-login-destinations', () => ({
  INSTANCE_LOGIN_DESTINATIONS: {
    orgScoped: '/crm/',
    unitScoped: '/crm/',
    marketplace: '/marketplace/',
  },
  DEFAULT_LOGIN_DESTINATIONS: {
    admin: '/admin/',
    platformAdmin: '/admin/',
    orgScoped: '/admin/',
    unitScoped: '/admin/',
    marketplace: '/admin/',
    noAccess: '/login/no-access/',
  },
}))

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
  // The page calls resolveWhoami, which wraps fetchWhoami and degrades to the
  // ID token's claims when a deployment does not serve /api/v1/whoami. Its own
  // fallback behaviour is tested in lib/whoami-api.test.ts; here it stands in
  // for "the identity lookup", however it was obtained.
  resolveWhoami: resolveWhoamiMock,
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

  it('routes tenant-level roles to the orgScoped destination', async () => {
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

    resolveWhoamiMock.mockResolvedValue(whoami)

    render(<LoginPage />)
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'founder@example.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => {
      expect(assignMock).toHaveBeenCalledWith(ORG_DESTINATION)
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

    resolveWhoamiMock.mockResolvedValue(whoami)

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

    resolveWhoamiMock.mockResolvedValue(whoami)

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
    resolveWhoamiMock.mockResolvedValue({
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
      expect(assignMock).toHaveBeenCalledWith(ORG_DESTINATION)
    })
  })

  it('gives up after one attempt when the identity lookup fails, instead of retrying forever', async () => {
    // Regression: the forwarding effect's catch set `forwarding` back to false,
    // and `forwarding` was in its own dependency array — so clearing it re-ran
    // the effect, which called the lookup again, without limit.
    //
    // Against biffo-platform's dev API, which answered 404 to /api/v1/whoami,
    // that was ~800 requests in seven minutes and the user simply saw the sign-in
    // form return. Sign-in had SUCCEEDED at Cognito every time; the failure was
    // read as a rejected password, and two days were spent resetting one.
    //
    // A count assertion rather than a "settles" assertion: the old code also
    // eventually rendered the form, so anything weaker passes on the bug.
    currentSession = mockSession()
    // Reset rather than merely re-stub: this describe block has no
    // clearAllMocks, so call counts accumulate across its tests and the
    // assertion below would be counting earlier tests' lookups too.
    resolveWhoamiMock.mockReset()
    resolveWhoamiMock.mockRejectedValue(new Error('Not Found'))

    render(<LoginPage />)

    // The forward attempt now runs after a deliberate delay (FORWARD_DELAY_MS,
    // #1942) rather than immediately — wait for it to actually happen and fail
    // before counting, rather than for the ever-present "Sign in" heading.
    await screen.findByText('Not Found')
    // Let any re-entrant effect run before counting.
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(resolveWhoamiMock).toHaveBeenCalledTimes(1)
  })

  it('says why it could not route, rather than silently re-presenting the form', async () => {
    // The other half of the same incident: failing silently made a broken API
    // indistinguishable from a wrong password.
    currentSession = mockSession()
    resolveWhoamiMock.mockRejectedValue(new Error('Not Found'))

    render(<LoginPage />)

    expect(await screen.findByText('Not Found')).toBeInTheDocument()
  })

  it('offers a way out, because signing out is shared across every surface', async () => {
    currentSession = mockSession()
    resolveWhoamiMock.mockResolvedValue({
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

  /**
   * #1942 — landing on /login/ with a live session used to redirect on the
   * same render pass that showed "Signing you in… Not you? Sign out": no
   * identity was ever named, and the sign-out link had no real window to be
   * clicked before the browser was already leaving.
   */
  it('names the resolved identity in the "Signing you in" text, not just that it is happening', async () => {
    currentSession = {
      getIdToken: () => ({
        getJwtToken: () => 'mock-token',
        decodePayload: () => ({ 'cognito:groups': [], email: 'founder@example.com' }),
      }),
    }
    resolveWhoamiMock.mockResolvedValue({
      sub: 's',
      email: 'founder@example.com',
      username: 'founder@example.com',
      user_id: 'u1',
      is_platform_admin: false,
      permissions: [],
      marketplace_role: null,
      roles: [{ role: 'HQ Admin', scope_level: 'tenant' }],
    })

    render(<LoginPage />)

    // Before the fix this said only "Signing you in…" — never which account.
    expect(await screen.findByText('Signing you in as founder@example.com…')).toBeInTheDocument()
  })

  it('gives "Not you? Sign out" a real window before redirecting, instead of firing on the same render pass', async () => {
    vi.useFakeTimers()
    try {
      currentSession = mockSession()
      resolveWhoamiMock.mockResolvedValue({
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

      // "Not you? Sign out" is on screen, and the redirect must not already
      // have happened — that is the whole "real window to click it" claim.
      expect(screen.getByRole('button', { name: 'Not you? Sign out' })).toBeInTheDocument()
      expect(assignMock).not.toHaveBeenCalled()
      expect(pushMock).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(FORWARD_DELAY_MS + 50)

      expect(assignMock).toHaveBeenCalledWith(ORG_DESTINATION)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the pending redirect when "Not you? Sign out" is clicked during the delay window', async () => {
    // Regression for the second half of #1942: showing the button is not
    // enough if clicking it during the window loses a race against the timer
    // that was already scheduled.
    vi.useFakeTimers()
    try {
      currentSession = mockSession()
      resolveWhoamiMock.mockResolvedValue({
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

      fireEvent.click(screen.getByRole('button', { name: 'Not you? Sign out' }))

      // Advance well past when the (cancelled) redirect would have fired.
      await vi.advanceTimersByTimeAsync(FORWARD_DELAY_MS + 100)

      expect(logoutMock).toHaveBeenCalled()
      expect(assignMock).not.toHaveBeenCalled()
      expect(pushMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
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
    resolveWhoamiMock.mockResolvedValue(ADMIN)
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

    resolveWhoamiMock.mockResolvedValue(LEARNER)
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
      expect(assignMock).toHaveBeenCalledWith(ORG_DESTINATION)
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
    resolveWhoamiMock.mockResolvedValue(LEARNER)

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

describe('LoginPage — brand tokens (issue #1945)', () => {
  // apps/portal/ had no branding mechanism at all: every one of these classes
  // was a Tailwind starter-default (bg-gray-50, text-gray-900, bg-blue-600 /
  // hover:bg-blue-700, text-white, bg-red-50) hardcoded into this page, across
  // all three of its states. Asserted by pattern, not by one class the fix
  // happened to touch, so a partial regression to the old palette is caught
  // the same way a full one would be.
  //
  // Every render below composes <LoginPage /> inside <AuthLayout>, the real
  // route-group wrapper (`(auth)/layout.tsx`) that Next.js puts around it in
  // the actual route tree — not the page in isolation. The full-viewport
  // background div lives in that layout, not in page.tsx: a sweep that
  // rendered page.tsx alone could report every legacy class gone while a
  // hardcoded bg-gray-50 survived one file up, structurally invisible to a
  // container scoped to page.tsx's own output (#1956).
  const LEGACY_COLOR_CLASS =
    /\b(?:bg|text|border|ring|hover:bg|hover:text)-(?:gray|blue|red)-\d{2,3}\b|(?:^|\s)bg-white(?:\s|$)|(?:^|\s)text-white(?:\s|$)/

  function expectNoLegacyColorClasses(container: HTMLElement) {
    const classNames = Array.from(container.querySelectorAll('[class]'))
      .map((el) => el.className)
      .join(' ')
    expect(classNames).not.toMatch(LEGACY_COLOR_CLASS)
  }

  afterEach(() => {
    vi.clearAllMocks()
    currentSession = null
  })

  it('uses theme-token classes, not hardcoded gray/blue, on the sign-in form', () => {
    const { container } = render(
      <AuthLayout>
        <LoginPage />
      </AuthLayout>,
    )

    expect(screen.getByRole('heading', { name: 'Sign in' })).toHaveClass('text-on-surface')
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveClass(
      'bg-primary',
      'text-on-primary',
      'hover:bg-primary-hover',
    )
    expect(screen.getByRole('button', { name: 'Forgot password?' })).toHaveClass('text-primary')
    expectNoLegacyColorClasses(container)
  })

  it('uses theme-token classes on the forgot-password (reset) form', () => {
    const { container } = render(
      <AuthLayout>
        <LoginPage />
      </AuthLayout>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }))

    expect(screen.getByRole('heading', { name: 'Reset your password' })).toHaveClass(
      'text-on-surface',
    )
    expect(screen.getByRole('button', { name: 'Send reset code' })).toHaveClass('bg-primary')
    expectNoLegacyColorClasses(container)
  })

  it('uses theme-token classes on the set-new-password form', async () => {
    loginMock.mockResolvedValue({
      kind: 'new_password_required',
      user: {},
      userAttributes: {},
    })
    const { container } = render(
      <AuthLayout>
        <LoginPage />
      </AuthLayout>,
    )
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    const heading = await screen.findByRole('heading', { name: 'Set a new password' })
    expect(heading).toHaveClass('text-on-surface')
    expect(screen.getByRole('button', { name: 'Set password' })).toHaveClass('bg-primary')
    expectNoLegacyColorClasses(container)
  })

  it('shows a sign-in error with the error-container tokens, not bg-red-50', async () => {
    loginMock.mockRejectedValue(new Error('boom'))
    const { container } = render(
      <AuthLayout>
        <LoginPage />
      </AuthLayout>,
    )
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    const errorText = await screen.findByText('boom')
    expect(errorText).toHaveClass('bg-error-container', 'text-on-error-container')
    expectNoLegacyColorClasses(container)
  })

  it('gives the (auth) route-group wrapper the surface-variant token, not bg-gray-50', () => {
    const { container } = render(
      <AuthLayout>
        <LoginPage />
      </AuthLayout>,
    )

    // Direct DOM access, not a testing-library query: this is the layout's
    // own wrapper div, which has no role or text content to query by.
    const wrapper = container.firstElementChild
    expect(wrapper).toHaveClass('bg-surface-variant')
    expectNoLegacyColorClasses(container)
  })
})
