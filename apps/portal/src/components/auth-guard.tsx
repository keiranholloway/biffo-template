'use client'

import { useEffect, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/context/auth-context'

export function AuthGuard({ children }: { children: ReactNode }) {
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

  return <>{children}</>
}
