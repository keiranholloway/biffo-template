'use client'

import { AuthGate } from '@/lib/auth-gate'

// The SAME page, made private by a single wrapper. Opting into auth is one
// deliberate line — <AuthGate> — not the default. A signed-out visitor is
// bounced to the core portal's login (ADR-0007) and returned here afterwards;
// a signed-in visitor sees the content below.
//
// The render-prop form hands you the session, whose ID token you pass to THIS
// sibling's own backend via createApiClient (never the core API directly,
// ADR-0002). This example doesn't call the backend, but shows where the token
// comes from.
export default function ExampleMembersPage() {
  return (
    <AuthGate>
      {(session) => (
        <main className="center-screen">
          <div>
            <h1>Members only</h1>
            <p>You&apos;re signed in — this rendered because a valid session exists.</p>
            <p>
              Your ID token (for calls to this sibling&apos;s backend) is{' '}
              {session.getIdToken().getJwtToken().slice(0, 8)}…
            </p>
          </div>
        </main>
      )}
    </AuthGate>
  )
}
