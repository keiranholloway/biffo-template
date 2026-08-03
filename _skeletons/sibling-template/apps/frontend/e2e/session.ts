// Put the browser in a signed-in state without touching Cognito (crm#65 M1).
//
// `src/lib/auth.ts` reads its session through amazon-cognito-identity-js, whose
// storage keys are derived from the **Client ID only** — deliberately, so the
// portal's session carries over to this sibling on the same origin (ADR-0007;
// see the comment in auth.ts). `fixtures.ts`'s `COGNITO_CLIENT_ID` pins that
// Client ID to a fixed test value, so the key names are deterministic and can
// be written before first paint — and it is the SAME value
// `static-server.mjs` advertises in the `/.well-known/biffo-identity.json`
// document auth.ts now resolves the pool from at runtime (#403), so the pool
// this seeded session's keys are stored under is the one the app actually
// builds.
//
// Once the pool resolves, the library validates the cached session
// **locally**: `getCurrentUser()` reads `LastAuthUser`, `getSession()` reads
// the three token keys, and `CognitoUserSession.isValid()` compares
// `payload.exp` against now. Nothing is verified cryptographically, so an
// unsigned JWT with a future `exp` is sufficient.
//
// Deliberately NOT a second test-only route. The map harness
// (`src/app/e2e/map/page.tsx`) mounts a component in isolation, which is the
// gap #65 exists to close — these specs drive the real `/crm/` app shell.

import type { Page } from '@playwright/test'
import { COGNITO_CLIENT_ID } from './fixtures'

const USERNAME = 'user@e2e.test'

/** base64url, without padding — the JWT segment encoding. */
function b64url(value: string): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * A structurally valid, unsigned JWT.
 *
 * The signature segment is the literal `e2e` — it is never checked here, and
 * making it obviously fake is the point: nothing in this file should look like
 * a credential that might work somewhere real.
 */
function token(extraClaims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    sub: 'e2e-sub',
    email: USERNAME,
    'cognito:username': USERNAME,
    aud: COGNITO_CLIENT_ID,
    token_use: 'id',
    auth_time: now,
    iat: now,
    exp: now + 60 * 60,
    ...extraClaims,
  }
  return `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.e2e`
}

/**
 * Seed the Cognito session keys before any app code runs.
 *
 * `addInitScript` runs on every navigation in the context, ahead of the page's
 * own scripts — which matters because `page.tsx` calls `getCurrentSession()` in
 * its first effect, and that now resolves the pool asynchronously (a fetch to
 * `/.well-known/biffo-identity.json`, #403) before it ever reads localStorage.
 * Writing localStorage after `goto` would race that and land on the signed-out
 * screen intermittently.
 */
export async function signIn(page: Page): Promise<void> {
  const prefix = `CognitoIdentityServiceProvider.${COGNITO_CLIENT_ID}`
  const entries: Record<string, string> = {
    [`${prefix}.LastAuthUser`]: USERNAME,
    [`${prefix}.${USERNAME}.idToken`]: token({ token_use: 'id' }),
    [`${prefix}.${USERNAME}.accessToken`]: token({ token_use: 'access' }),
    // Present but unused: `getSession` only reaches for it when the cached
    // session has expired, which it has not.
    [`${prefix}.${USERNAME}.refreshToken`]: 'e2e-refresh',
    [`${prefix}.${USERNAME}.clockDrift`]: '0',
  }

  await page.addInitScript((items: Record<string, string>) => {
    for (const [k, v] of Object.entries(items)) window.localStorage.setItem(k, v)
  }, entries)
}

/** Every request the app has made to the fixture API, in order. */

/** Drop recorded requests and any units created by an earlier test. */
