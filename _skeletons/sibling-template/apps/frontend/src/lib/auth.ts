import {
  CognitoUserPool,
  type CognitoUserSession,
  type ICognitoUserPoolData,
} from 'amazon-cognito-identity-js'

// ---------------------------------------------------------------------------
// SHARED-SESSION INVARIANT — read this before changing anything below.
//
// A sibling NEVER signs anyone in. The core portal owns authentication
// (ADR-0007): a sibling that finds no valid session redirects to the portal's
// login with `?return_to=/<name>/`. This module therefore only *reads* the
// session the portal already established.
//
// That works because this points at the SAME Cognito User Pool / App Client ID
// as the core portal. The sibling and the portal live on the same origin
// (baseurl.com/ vs baseurl.com/<name>/) and share one Cognito App Client, so
// amazon-cognito-identity-js's own localStorage keys — keyed only by Client
// ID, not by path — transparently carry the portal's session over here with
// zero extra code.
//
// Do NOT point this at a different pool/client: that would silently break
// single-sign-on between the portal and this sibling.
//
// Do NOT add signIn/signOut/completeNewPassword here either. A second login
// path in a sibling bypasses the portal and breaks the SSO model ADR-0007
// depends on. If this sibling ever genuinely needs sign-out, add it
// deliberately — and decide first whether it must sign the user out of the
// portal too.
// ---------------------------------------------------------------------------
// Module-private on purpose: the pool is an implementation detail of
// getCurrentSession(), not part of this sibling's auth surface.
//
// Constructed LAZILY, on first session read — never at module scope. The
// CognitoUserPool constructor throws ("Both UserPoolId and ClientId are
// required") when either value is missing, and `next build` prerenders `/` in
// Node, which imports this module. Constructing eagerly therefore made the
// whole app un-buildable without the real Cognito env vars in scope — a build
// is not a sign-in, and it has no business needing pool credentials. Deferring
// keeps `pnpm run build` (and any import of this module) working with no env
// configured, while an actual session read in a misconfigured deployment
// surfaces as "signed out" rather than a hard crash.
let userPool: CognitoUserPool | null = null

function getUserPool(): CognitoUserPool | null {
  if (userPool) return userPool

  const poolData: ICognitoUserPoolData = {
    UserPoolId: process.env['NEXT_PUBLIC_CORE_COGNITO_USER_POOL_ID'] ?? '',
    ClientId: process.env['NEXT_PUBLIC_CORE_COGNITO_CLIENT_ID'] ?? '',
  }
  if (!poolData.UserPoolId || !poolData.ClientId) return null

  userPool = new CognitoUserPool(poolData)
  return userPool
}

/**
 * Read the shared portal session, or null if there isn't a valid one.
 *
 * Callers pass the returned session's ID token to this sibling's own backend
 * (see `createApiClient`, which takes a `getIdToken` callback). A null result
 * means "redirect the user to the portal's login".
 */
export function getCurrentSession(): Promise<CognitoUserSession | null> {
  return new Promise((resolve) => {
    // No pool means no core Cognito config, which is indistinguishable from
    // "not signed in" as far as callers are concerned.
    const pool = getUserPool()
    if (!pool) {
      resolve(null)
      return
    }
    const user = pool.getCurrentUser()
    if (!user) {
      resolve(null)
      return
    }
    user.getSession((err: Error | null, session: CognitoUserSession | null) => {
      if (err ?? !session?.isValid()) {
        resolve(null)
      } else {
        resolve(session)
      }
    })
  })
}
