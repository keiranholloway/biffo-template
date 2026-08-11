import { useEffect, useState } from 'react'

import { getCurrentSession } from './lib/auth'

/**
 * Starter admin surface. It proves the SHARED-SESSION INVARIANT works — reads
 * the portal's Cognito session, shows a signed-in/signed-out state, nothing
 * more — and is meant to be replaced with this plugin's own admin UI.
 *
 * Wire real screens against `./lib/api`'s starter `request()` helper, which
 * already carries the `Authorization: Bearer` header and error handling this
 * plugin's calls will need; the endpoints themselves are this plugin's own.
 */
export default function App() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    void getCurrentSession().then((session) => {
      if (cancelled) return
      setSignedIn(session != null)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (signedIn === false) {
    return (
      <main className="page">
        <h1>example-plugin — Admin</h1>
        <p className="error">Not signed in. Open this from the Biffo portal.</p>
      </main>
    )
  }

  return (
    <main className="page">
      <h1>example-plugin — Admin</h1>
      {signedIn === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <p className="muted">
          Signed in via the shared portal session. Replace this screen with the plugin's own admin
          UI.
        </p>
      )}
    </main>
  )
}
