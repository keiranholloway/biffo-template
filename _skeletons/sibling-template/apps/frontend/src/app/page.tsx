'use client'

import { useEffect, useState } from 'react'
import { getCurrentSession } from '@/lib/auth'
import { createApiClient, ApiError } from '@/lib/api-client'

const SIBLING_NAME = process.env['NEXT_PUBLIC_SIBLING_NAME'] ?? 'Sibling'
const SIBLING_PATH_PREFIX = process.env['NEXT_PUBLIC_SIBLING_PATH_PREFIX'] ?? ''
const CORE_PORTAL_URL = process.env['NEXT_PUBLIC_CORE_PORTAL_URL'] ?? ''

type State =
  | { kind: 'loading' }
  | { kind: 'signed_out' }
  | { kind: 'ready'; username: string }
  | { kind: 'error'; message: string }

// This page's only job is to prove the shared-Cognito-session SSO (ADR-0007)
// actually works end to end: no session on this origin → bounce to the core
// portal's login with return_to set to come straight back here; a session →
// call this sibling's OWN backend (never the core API directly, ADR-0002),
// which independently re-verifies the JWT and echoes back the username.
export default function HomePage() {
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false

    void getCurrentSession().then(async (session) => {
      if (cancelled) return
      if (session === null) {
        setState({ kind: 'signed_out' })
        return
      }

      const idToken = session.getIdToken().getJwtToken()
      const api = createApiClient(() => idToken)
      try {
        const me = await api.get<{ username: string }>('/api/v1/whoami')
        if (!cancelled) setState({ kind: 'ready', username: me.username })
      } catch (err) {
        if (!cancelled) {
          setState({
            kind: 'error',
            message: err instanceof ApiError ? err.message : 'Failed to reach the API',
          })
        }
      }
    })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (state.kind === 'signed_out' && CORE_PORTAL_URL) {
      const returnTo = encodeURIComponent(`${SIBLING_PATH_PREFIX}/`)
      window.location.href = `${CORE_PORTAL_URL}/login?return_to=${returnTo}`
    }
  }, [state])

  if (state.kind === 'loading' || state.kind === 'signed_out') {
    return (
      <main className="center-screen">
        <div className="spinner" />
      </main>
    )
  }

  if (state.kind === 'error') {
    return (
      <main className="center-screen">
        <p>Signed in, but could not reach the API: {state.message}</p>
      </main>
    )
  }

  return (
    <main className="center-screen">
      <h1>
        {SIBLING_NAME} - Hello {state.username}
      </h1>
    </main>
  )
}
