'use client'

import { useEffect, useState, type ReactNode } from 'react'
import type { CognitoUserSession } from 'amazon-cognito-identity-js'
import { getCurrentSession } from '@/lib/auth'

// ---------------------------------------------------------------------------
// PUBLIC IS THE DEFAULT — read this before reaching for auth.
//
// A sibling app serves UNAUTHENTICATED content by default. That is the
// go-live state for most products: a page you drop under src/app/ is public
// the moment it deploys, with no auth code at all. Do NOT gate the whole app.
//
// This module is the *opt-in*: wrap only the routes/pages that genuinely need
// a signed-in user in <AuthGate>. Everything you don't wrap stays public.
//
// AuthGate does NOT sign anyone in — a sibling never owns authentication
// (ADR-0007). It reads the session the core portal already established (via
// getCurrentSession in ./auth.ts); if there isn't one, it bounces the visitor
// to the portal's login with `return_to` pointing back at the exact page they
// were trying to reach, so they land right back here once signed in.
//
// A SESSION IS NOT AN AUTHORISATION. "Somebody is signed in" and "this person
// is allowed here" are different questions, and this gate answers both: pass
// `requireGroups` and/or `authorize` for the second one. Ask for it explicitly
// on any page whose content is not for every signed-in user — a wrapper that
// only checked for a session is exactly how the core portal shipped its whole
// /admin console to any authenticated visitor (biffo-template#1104), and how
// each sibling that hand-rolled the missing half got it wrong differently.
//
// The session it yields carries the ID token you pass to THIS sibling's own
// backend (createApiClient in ./api-client.ts) — never to the core API
// directly (ADR-0002). The backend re-verifies that JWT itself.
// ---------------------------------------------------------------------------

const CORE_PORTAL_URL = process.env['NEXT_PUBLIC_CORE_PORTAL_URL'] ?? ''
const SIBLING_PATH_PREFIX = process.env['NEXT_PUBLIC_SIBLING_PATH_PREFIX'] ?? ''

type GateState =
  { kind: 'checking' } | { kind: 'redirecting' } | { kind: 'authed'; session: CognitoUserSession }

/** The default refusal wording, used when a caller supplies none of its own. */
const DEFAULT_NO_ACCESS_MESSAGE =
  "Your account doesn't have access to this page. Contact your administrator if you think that's wrong."

/**
 * The caller's Cognito groups, or `[]`.
 *
 * Fails CLOSED in every degenerate case — no `cognito:groups` claim (the
 * ordinary state of a user in no groups), a claim that is not an array of
 * strings, or a token that cannot be decoded at all. An empty list satisfies
 * no requirement, so a malformed token is refused rather than waved through:
 * the alternative is a gate whose bypass is "present a token it cannot parse".
 *
 * Exported because a sibling's own code often needs the same reading — do not
 * re-derive it, and do not treat it as authorisation. The core API re-verifies
 * the JWT and applies the real scoping on every forwarded call (ADR-0002);
 * this only decides what the UI offers.
 */
export function sessionGroups(session: CognitoUserSession): string[] {
  let claim: unknown
  try {
    claim = session.getIdToken().decodePayload()['cognito:groups']
  } catch {
    return []
  }
  if (!Array.isArray(claim)) return []
  return claim.filter((group): group is string => typeof group === 'string')
}

/**
 * The URL to send an unauthenticated visitor back to after they log in.
 *
 * Prefer the live location (so a deep protected route returns to itself); fall
 * back to this sibling's root prefix when there is no DOM (SSR/prerender).
 */
function currentReturnTo(): string {
  if (typeof window !== 'undefined') {
    return window.location.pathname + window.location.search
  }
  return `${SIBLING_PATH_PREFIX}/`
}

/**
 * Whether a resolved session satisfies the gate's requirements.
 *
 * Both conditions must hold, and an `authorize` predicate that throws counts
 * as a refusal — same reasoning as `sessionGroups`: the failure mode of an
 * authorisation check must never be "allowed".
 */
function permitted(
  session: CognitoUserSession,
  requireGroups: string[] | undefined,
  authorize: ((session: CognitoUserSession) => boolean) | undefined,
): boolean {
  if (requireGroups !== undefined && requireGroups.length > 0) {
    const held = sessionGroups(session)
    if (!requireGroups.some((group) => held.includes(group))) return false
  }
  if (authorize !== undefined) {
    try {
      if (!authorize(session)) return false
    } catch {
      return false
    }
  }
  return true
}

type AuthGateProps = {
  /**
   * What to render once a valid session exists. Either plain nodes, or a
   * render function that receives the session — use the function form when the
   * protected UI needs the ID token to call this sibling's backend:
   *
   *   <AuthGate>{(session) => <Dashboard token={session.getIdToken().getJwtToken()} />}</AuthGate>
   */
  children: ReactNode | ((session: CognitoUserSession) => ReactNode)
  /**
   * Shown while the session is being read and during the redirect bounce.
   * Defaults to a centered spinner (see globals.css).
   */
  fallback?: ReactNode
  /**
   * Cognito groups, ANY of which admits the caller. Omitting this means "any
   * signed-in user" — a real and common answer, but make it a decision rather
   * than an oversight.
   */
  requireGroups?: string[]
  /**
   * Anything group membership cannot express: a permission claim, a role
   * fetched from this sibling's own backend and closed over, a tenant match.
   * Applied in addition to `requireGroups`; both must pass.
   *
   * Name the predicate after what the PAGE needs, not after the nearest role
   * you already have a helper for. A completion report is for whoever may read
   * enrolments — gating it on an authoring permission refuses exactly the
   * oversight roles it is built for, and that one nearly shipped.
   */
  authorize?: (session: CognitoUserSession) => boolean
  /**
   * Refusal wording, in this product's voice. Say what the page was, not what
   * the check was: "You don't have access to training reports."
   */
  noAccessMessage?: string
  /** Replace the whole refusal surface, when a message is not enough. */
  noAccess?: ReactNode
}

/**
 * Gate a route/page behind the shared portal session.
 *
 * Public is the default for a sibling; this is how you make ONE page private
 * without touching the rest of the app:
 *
 *   'use client'
 *   import { AuthGate } from '@/lib/auth-gate'
 *   export default function Page() {
 *     return <AuthGate><h1>Members only</h1></AuthGate>
 *   }
 *
 * No session → the visitor is redirected to the core portal's login and
 * returned here afterwards. Valid session → `children` render.
 *
 * And when the page is not for every signed-in user, say so:
 *
 *   <AuthGate requireGroups={['admin']} noAccessMessage="You don't have access to reports.">
 *     <Reports />
 *   </AuthGate>
 *
 * A refused caller is shown the no-access surface, NOT redirected: they are
 * already signed in, so sending them to a login page either loops them
 * straight back or strands them on a form that cannot help.
 */
export function AuthGate({
  children,
  fallback,
  requireGroups,
  authorize,
  noAccessMessage,
  noAccess,
}: AuthGateProps) {
  const [state, setState] = useState<GateState>({ kind: 'checking' })

  useEffect(() => {
    let cancelled = false
    void getCurrentSession().then((session) => {
      if (cancelled) return
      setState(session === null ? { kind: 'redirecting' } : { kind: 'authed', session })
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (state.kind === 'redirecting' && CORE_PORTAL_URL) {
      const returnTo = encodeURIComponent(currentReturnTo())
      window.location.href = `${CORE_PORTAL_URL}/login?return_to=${returnTo}`
    }
  }, [state])

  if (state.kind !== 'authed') {
    return (
      fallback ?? (
        <main className="center-screen">
          <div className="spinner" />
        </main>
      )
    )
  }

  // Authorisation is decided during render, not stored in `state`, so a caller
  // may pass a fresh array or arrow literal on every render without either
  // re-running the session fetch or needing a dependency-array escape hatch.
  if (!permitted(state.session, requireGroups, authorize)) {
    return (
      noAccess ?? (
        <main className="center-screen">
          <div>
            <h1>No access</h1>
            <p>{noAccessMessage ?? DEFAULT_NO_ACCESS_MESSAGE}</p>
          </div>
        </main>
      )
    )
  }

  return <>{typeof children === 'function' ? children(state.session) : children}</>
}
