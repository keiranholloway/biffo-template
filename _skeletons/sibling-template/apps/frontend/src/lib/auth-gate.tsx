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
// The session it yields carries the ID token you pass to THIS sibling's own
// backend (createApiClient in ./api-client.ts) — never to the core API
// directly (ADR-0002). The backend re-verifies that JWT itself.
// ---------------------------------------------------------------------------

const CORE_PORTAL_URL = process.env['NEXT_PUBLIC_CORE_PORTAL_URL'] ?? ''
const SIBLING_PATH_PREFIX = process.env['NEXT_PUBLIC_SIBLING_PATH_PREFIX'] ?? ''

type GateState =
  { kind: 'checking' } | { kind: 'redirecting' } | { kind: 'authed'; session: CognitoUserSession }

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
 */
export function AuthGate({ children, fallback }: AuthGateProps) {
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

  return <>{typeof children === 'function' ? children(state.session) : children}</>
}
