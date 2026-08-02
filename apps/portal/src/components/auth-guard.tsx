'use client'

import { useEffect, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/context/auth-context'
import { sessionGroups } from '@/lib/cognito-groups'
import { NoAccess } from '@/components/no-access'

/**
 * Gate a subtree behind the portal session, and — when asked — behind a
 * Cognito group.
 *
 * ## A session is not an authorisation (#1104)
 *
 * This guard used to yield on `session !== null` alone, and it wraps the
 * entire /admin subtree. Every authenticated user therefore rendered the whole
 * infrastructure console: the microservices list with the deployment topology
 * of every sibling app, the plugin store, endpoints, workflows, and on
 * /admin/users/ a fully rendered "Add a user" form with an admin/editor/viewer
 * selector and an enabled submit button. The Core API refused each call with
 * `Administrator access required`, so nothing leaked — that is the last line
 * of defence working, and it was the only line there was.
 *
 * `requireGroup` is the missing first line. It is not authorisation and must
 * never be trusted as such: a browser can be made to render anything, and the
 * API remains the authority on every call. What it fixes is the product
 * advertising capability the caller does not have.
 */
export function AuthGuard({
  children,
  requireGroup,
}: {
  children: ReactNode
  /**
   * A Cognito group the session must carry. Omit for a surface that genuinely
   * only needs "signed in" — but omit it deliberately, because that was the
   * implicit default and it was the bug.
   */
  requireGroup?: string
}) {
  const { session, loading } = useAuth()
  const router = useRouter()

  useEffect(() => {
    if (!loading && session === null) {
      // Carry where they were trying to go, so signing in returns them there
      // instead of dumping them on the portal's default landing.
      //
      // Read from `window.location` rather than `usePathname`/`useSearchParams`:
      // this component wraps the entire /admin subtree, and `useSearchParams`
      // opts its subtree out of static rendering and demands a Suspense
      // boundary — the very constraint that already forced the login page to be
      // split in two. This effect body only ever runs client-side.
      //
      // Pushed as an inline template literal, not via a variable, so the route
      // target stays visible to internal-links.test.ts's scanner.
      const returnTo = window.location.pathname + window.location.search
      router.push(`/login/?return_to=${encodeURIComponent(returnTo)}`)
    }
  }, [session, loading, router])

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-300 border-t-blue-600" />
      </div>
    )
  }

  if (session === null) return null

  // Refused, not redirected. They are signed in, so bouncing them to /login/
  // would either forward them straight back here or strand them on a page
  // whose whole job is to get them the session they already have.
  if (requireGroup !== undefined && !sessionGroups(session).includes(requireGroup)) {
    return (
      <NoAccess
        title="No access"
        message="Your account doesn't have access to this area. Contact your administrator if you think that's wrong."
      />
    )
  }

  return <>{children}</>
}
