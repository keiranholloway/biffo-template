import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  type CognitoUserSession,
} from 'amazon-cognito-identity-js'
import { pruneForeignCognitoCredentials } from './cognito-hygiene'
import { resolveCoreIdentity } from './identity'

// The pool is built LAZILY and ASYNCHRONOUSLY, from the identity resolved at
// runtime (see identity.ts, #403) — never at module scope from process.env.
//
// Two reasons it must be lazy: (1) the identity now comes from an async fetch,
// which a module-level constant cannot be; (2) `next build` prerenders pages in
// Node, importing this module — and the CognitoUserPool constructor throws when
// UserPoolId/ClientId are empty, so building eagerly made the app un-buildable
// without real Cognito values in scope. A build is not a sign-in.
//
// Memoised: one pool per page load. Returns null when no identity is available
// (document unreachable AND no baked fallback) — the same "no config" state the
// module used to crash on, now surfaced as "signed out" rather than a throw.
let poolPromise: Promise<CognitoUserPool | null> | null = null

function getUserPool(): Promise<CognitoUserPool | null> {
  poolPromise ??= resolveCoreIdentity()
    .then((id) => {
      if (!id.userPoolId || !id.clientId) return null
      // Once per page load, and only with a resolved client id: drop credentials
      // left behind by pools this deployment no longer uses (#834). Ordered
      // before the pool is constructed so nothing can read a stale key in
      // between, though nothing does today — see cognito-hygiene.ts.
      pruneForeignCognitoCredentials(id.clientId)
      return new CognitoUserPool({ UserPoolId: id.userPoolId, ClientId: id.clientId })
    })
    // A rejection must not poison the rest of the page's life (biffo-plugin-marketing#55):
    // clear the memo so the next call retries instead of replaying the same failure.
    .catch((err: unknown) => {
      poolPromise = null
      throw err
    })
  return poolPromise
}

/** Test seam: drop the memoised pool so a test can re-resolve. */
export function resetUserPoolForTests(): void {
  poolPromise = null
}

export type SignInResult =
  | { kind: 'success'; session: CognitoUserSession }
  | { kind: 'new_password_required'; user: CognitoUser; userAttributes: Record<string, string> }

const NO_IDENTITY = new Error(
  'Cognito identity is unavailable — the core identity document could not be resolved and no baked fallback is configured.',
)

export async function signIn(username: string, password: string): Promise<SignInResult> {
  const userPool = await getUserPool()
  if (!userPool) throw NO_IDENTITY
  return new Promise((resolve, reject) => {
    const user = new CognitoUser({ Username: username, Pool: userPool })
    const authDetails = new AuthenticationDetails({ Username: username, Password: password })

    user.authenticateUser(authDetails, {
      onSuccess: (session) => {
        resolve({ kind: 'success', session })
      },
      onFailure: reject,
      newPasswordRequired: (userAttributes: Record<string, string>) => {
        // Cognito includes read-only attributes that must not be sent back
        const { email_verified, email, ...writableAttributes } = userAttributes
        void email_verified
        void email
        resolve({ kind: 'new_password_required', user, userAttributes: writableAttributes })
      },
    })
  })
}

export function completeNewPassword(
  user: CognitoUser,
  newPassword: string,
  userAttributes: Record<string, string>,
): Promise<CognitoUserSession> {
  return new Promise((resolve, reject) => {
    user.completeNewPasswordChallenge(newPassword, userAttributes, {
      onSuccess: resolve,
      onFailure: reject,
    })
  })
}

export async function requestPasswordReset(username: string): Promise<void> {
  const userPool = await getUserPool()
  if (!userPool) throw NO_IDENTITY
  return new Promise((resolve, reject) => {
    const user = new CognitoUser({ Username: username, Pool: userPool })
    user.forgotPassword({
      onSuccess: () => {
        resolve()
      },
      onFailure: reject,
    })
  })
}

export async function confirmPasswordReset(
  username: string,
  code: string,
  newPassword: string,
): Promise<void> {
  const userPool = await getUserPool()
  if (!userPool) throw NO_IDENTITY
  return new Promise((resolve, reject) => {
    const user = new CognitoUser({ Username: username, Pool: userPool })
    user.confirmPassword(code, newPassword, {
      onSuccess: () => {
        resolve()
      },
      onFailure: reject,
    })
  })
}

export async function signOut(): Promise<void> {
  const userPool = await getUserPool()
  userPool?.getCurrentUser()?.signOut()
}

export async function getCurrentSession(): Promise<CognitoUserSession | null> {
  const userPool = await getUserPool()
  return new Promise((resolve) => {
    // No pool means no resolvable identity, which is indistinguishable from
    // "not signed in" as far as callers are concerned.
    const user = userPool?.getCurrentUser()
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
