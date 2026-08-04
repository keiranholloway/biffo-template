'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/context/auth-context'

/**
 * The one surface the portal shows a signed-in person it cannot serve.
 *
 * There were two ways to be refused and only one of them had a face: the
 * `/login/no-access/` route, reached when `resolveDestination` can find no
 * landing for an account. The other — asking for a page your groups do not
 * cover — had none at all, because nothing checked (#1104). Both now render
 * this, so "you are signed in, and this is not for you" looks the same
 * wherever it happens and is written once in the product's voice rather than
 * improvised per call site.
 *
 * ## Why the way out is a prop, not one hardcoded link (#1310)
 *
 * Every visitor here is signed in — that is the precondition for being refused
 * rather than redirected — so the single action this page used to offer, "Back
 * to sign in", named the one thing that was not their problem. It read as a
 * dead end.
 *
 * The obvious fix is to call `resolveDestination` here and link to whatever it
 * returns. That does not work, and it is worth recording why, because it looks
 * like it should:
 *
 * 1. **The refusal site has no `whoami`.** `AuthGuard` holds a Cognito session,
 *    not the API's identity payload, and `resolveDestination` needs the roles.
 *    Fetching it here would add a request, a loading state and an error path to
 *    the component whose entire job is to render reliably when something else
 *    has already gone wrong.
 * 2. **At the other site the answer is this page.** `/login/no-access/` is
 *    reached precisely *because* `resolveDestination` returned `noAccess`, so
 *    calling it again yields a link to the page you are already on.
 *
 * `/login/` is the better indirection, and it is not a hardcoded guess: the
 * login page forwards an already-signed-in caller through `resolveDestination`
 * itself, so that one href resolves to "wherever this person's roles land them"
 * at click time, with no second copy of the rules and nothing to drift. What
 * was wrong was never the `href` — it was the label, describing what the link
 * undoes instead of where it goes.
 *
 * ## `recovery` exists because that indirection loops for one of the two sites
 *
 * For a caller refused from *one* surface, `/login/` genuinely forwards them
 * home. For a caller `resolveDestination` found *no* surface for, it forwards
 * them straight back here — a real loop, and the dead end #1310 named. Their
 * only honest exit is to stop being that identity, so `'none'` offers sign-out
 * alone and never promises a home page that does not exist.
 */
export function NoAccess({
  title,
  message,
  recovery = 'home',
}: {
  title: string
  message: string
  /**
   * What this caller can still do, which differs by how they got here.
   *
   * - `'home'` — refused from one surface, but their roles may well admit
   *   another. Offer the forwarding link, plus sign-out.
   * - `'none'` — no surface resolved for them at all. Offer sign-out only; the
   *   forwarding link would return them to this page.
   */
  recovery?: 'home' | 'none'
}) {
  const { logout } = useAuth()
  const router = useRouter()

  const signOut = () => {
    logout()
    // They are being un-signed-in, so /login/ now presents the form rather than
    // forwarding — which is what makes this the route to a different account
    // from a page that admits none of this one's surfaces.
    router.push('/login/')
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-sm rounded-xl border border-dashed border-gray-300 bg-white p-8">
        <h1 className="text-lg font-semibold text-gray-900">{title}</h1>
        <p className="mt-2 text-sm text-gray-600">{message}</p>

        {/* The actionable part comes before the caveat, deliberately (#1310). */}
        <div className="mt-4 flex flex-col items-start gap-2">
          {recovery === 'home' && (
            <Link href="/login/" className="text-sm font-medium text-blue-600 hover:underline">
              Go to your home page
            </Link>
          )}
          <button
            type="button"
            onClick={signOut}
            className="text-sm font-medium text-blue-600 hover:underline"
          >
            {recovery === 'home' ? 'Sign out' : 'Sign in with a different account'}
          </button>
        </div>

        {/*
          The caveat follows the action, and differs with it: someone refused
          from one area may simply be in the wrong place, while someone with no
          surface at all needs access granted. Both sentences were already in
          the product at the two call sites -- they moved here so the ORDER is
          guaranteed by the component rather than by each caller's prose.
        */}
        <p className="mt-4 text-sm text-gray-500">
          {recovery === 'home'
            ? "Contact your administrator if you think that's wrong."
            : 'Contact your administrator to request access.'}
        </p>
      </div>
    </div>
  )
}
