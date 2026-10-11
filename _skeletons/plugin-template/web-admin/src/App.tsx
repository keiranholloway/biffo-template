import { useEffect, useState } from 'react'
import { statusBadgeClass, statusLabel } from '@biffo/design-tokens/status.mjs'

import { getCurrentSession } from './lib/auth'

/**
 * Starter admin surface. It proves the SHARED-SESSION INVARIANT works — reads
 * the portal's Cognito session, shows a signed-in/signed-out state — and shows
 * the shared kit's controls (heading, primary button, status badge, delete with
 * an in-page confirm). Replace the sample row with this plugin's own admin UI.
 *
 * Style with the kit's `biffo-*` classes (see @biffo/design-tokens/kit.css),
 * never `window.confirm` and never local colour/font overrides.
 *
 * Wire real screens against `./lib/api`'s starter `request()` helper, which
 * already carries the `Authorization: Bearer` header and error handling this
 * plugin's calls will need; the endpoints themselves are this plugin's own.
 */
export default function App() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [deleted, setDeleted] = useState(false)

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
      <main className="biffo-kit layout">
        <h1 className="biffo-heading">example-plugin — Admin</h1>
        <p role="alert" className="biffo-badge biffo-badge--negative">
          Not signed in. Open this from the Biffo portal.
        </p>
      </main>
    )
  }

  return (
    <main className="biffo-kit layout">
      <h1 className="biffo-heading">example-plugin — Admin</h1>
      {signedIn === null ? (
        <p>Loading…</p>
      ) : (
        <>
          <p>
            Signed in via the shared portal session. Replace this screen with the plugin's own admin
            UI.
          </p>
          {deleted ? (
            <p>Sample item deleted.</p>
          ) : (
            <div className="row">
              <span>Sample item</span>
              <span className={statusBadgeClass('active')}>{statusLabel('active')}</span>
              <button type="button" className="biffo-btn-primary">
                Edit
              </button>
              {confirming ? (
                <span className="biffo-confirm">
                  <span className="biffo-confirm__prompt">
                    Delete this item? This action cannot be undone.
                  </span>
                  <button
                    type="button"
                    className="biffo-btn-delete biffo-confirm__yes"
                    onClick={() => setDeleted(true)}
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    className="biffo-confirm__no"
                    onClick={() => setConfirming(false)}
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="biffo-btn-delete"
                  onClick={() => setConfirming(true)}
                >
                  Delete
                </button>
              )}
            </div>
          )}
        </>
      )}
    </main>
  )
}
