import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NoAccess } from './no-access'

const { pushMock, logoutMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  logoutMock: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

vi.mock('@/context/auth-context', () => ({
  useAuth: () => ({ logout: logoutMock }),
}))

/**
 * #1310 — the refusal page was a dead end.
 *
 * Its only action was labelled "Back to sign in", which names the one thing a
 * signed-in person does not need; being signed in is the precondition for being
 * refused here rather than redirected. Nothing on the page suggested they had a
 * working home to go to.
 *
 * ## What these tests can and cannot prove
 *
 * They pin the OFFER: which actions exist, how they are labelled, what order
 * they appear in, and that the `'none'` variant does not promise a home page.
 *
 * They cannot prove where the offer LANDS. `/login/` is an indirection through
 * `resolveDestination`, whose destinations are instance-owned data (#1098) that
 * this repo never sees — so "a Brand HQ clicking this reaches the CRM" is only
 * verifiable on a deployed instance. What is template-owned, and tested here, is
 * that the page names a destination at all and picks the right one of the two
 * offers for how the caller arrived.
 */
describe('NoAccess', () => {
  beforeEach(() => {
    pushMock.mockClear()
    logoutMock.mockClear()
  })

  it('offers a route onward, not only "Back to sign in"', () => {
    const { getByRole, queryByText } = render(<NoAccess title="No access" message="Nope." />)

    // The whole complaint: the single action told a signed-in user to sign in.
    expect(queryByText('Back to sign in')).not.toBeInTheDocument()
    expect(getByRole('link', { name: 'Go to your home page' })).toBeInTheDocument()
  })

  it('keeps the href at the login route, which forwards through resolveDestination', () => {
    // Deliberately NOT a hardcoded app path: the login page routes an
    // already-signed-in caller by their own roles, so this one href resolves to
    // their landing at click time with no second copy of the rules.
    //
    // Matched loosely on the trailing slash on purpose. The source literal is
    // `/login/`, but `next/link` normalises it away under jsdom because the
    // app's `trailingSlash: true` is not in play here — asserting the strict
    // form would be testing the harness. The canonical form of every source
    // href is guarded properly by `internal-links.test.ts` (#275), which reads
    // the literals rather than the rendered DOM.
    const { getByRole } = render(<NoAccess title="No access" message="Nope." />)

    expect(getByRole('link', { name: 'Go to your home page' }).getAttribute('href')).toMatch(
      /^\/login\/?$/,
    )
  })

  it('puts the action before the "contact your administrator" caveat', () => {
    // The actionable part is where they CAN go, so it must not sit below advice
    // to go and ask someone.
    const { container, getByRole } = render(<NoAccess title="No access" message="Nope." />)

    const link = getByRole('link', { name: 'Go to your home page' })
    const caveat = container.querySelector('p.text-gray-500')
    // "in the wrong place", not "you have nothing" -- this variant HAS a home.
    expect(caveat).toHaveTextContent("Contact your administrator if you think that's wrong.")
    expect(link.compareDocumentPosition(caveat as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('offers sign-out alongside the way home', () => {
    const { getByRole } = render(<NoAccess title="No access" message="Nope." />)

    expect(getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })

  it('signs the caller out and sends them to the form', () => {
    const { getByRole } = render(<NoAccess title="No access" message="Nope." />)

    getByRole('button', { name: 'Sign out' }).click()

    expect(logoutMock).toHaveBeenCalledTimes(1)
    expect(pushMock).toHaveBeenCalledWith('/login/')
  })

  describe('recovery="none"', () => {
    it('does NOT offer a home page, because /login/ would loop back here', () => {
      // This variant is rendered by /login/no-access/, which IS
      // resolveDestination's `noAccess` outcome -- so the forwarding link would
      // return the caller to the page they are standing on. Promising them a
      // home page would be a label that visibly fails.
      const { queryByRole } = render(<NoAccess title="No access" message="Nope." recovery="none" />)

      expect(queryByRole('link', { name: 'Go to your home page' })).not.toBeInTheDocument()
    })

    it('offers the one honest exit: a different account', () => {
      const { getByRole } = render(<NoAccess title="No access" message="Nope." recovery="none" />)

      const action = getByRole('button', { name: 'Sign in with a different account' })
      action.click()

      expect(logoutMock).toHaveBeenCalledTimes(1)
      expect(pushMock).toHaveBeenCalledWith('/login/')
    })

    it('asks for access to be GRANTED, not for a misplacement to be corrected', () => {
      // Both sentences already existed at the two call sites; moving them into
      // the component must not collapse them into one. Someone with no surface
      // at all needs access granted -- "if you think that's wrong" would be the
      // wrong advice, and was this page's copy before the move.
      const { container, getByRole } = render(
        <NoAccess title="No access" message="Nope." recovery="none" />,
      )

      const action = getByRole('button', { name: 'Sign in with a different account' })
      const caveat = container.querySelector('p.text-gray-500')
      expect(caveat).toHaveTextContent('Contact your administrator to request access.')
      expect(action.compareDocumentPosition(caveat as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    })
  })
})
