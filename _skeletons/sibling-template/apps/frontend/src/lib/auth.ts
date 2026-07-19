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
const poolData: ICognitoUserPoolData = {
  UserPoolId: process.env['NEXT_PUBLIC_CORE_COGNITO_USER_POOL_ID'] ?? '',
  ClientId: process.env['NEXT_PUBLIC_CORE_COGNITO_CLIENT_ID'] ?? '',
}

// Module-private on purpose: the pool is an implementation detail of
// getCurrentSession(), not part of this sibling's auth surface.
const userPool = new CognitoUserPool(poolData)

/**
 * Read the shared portal session, or null if there isn't a valid one.
 *
 * Callers pass the returned session's ID token to this sibling's own backend
 * (see `createApiClient`, which takes a `getIdToken` callback). A null result
 * means "redirect the user to the portal's login".
 */
export function getCurrentSession(): Promise<CognitoUserSession | null> {
  return new Promise((resolve) => {
    const user = userPool.getCurrentUser()
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
