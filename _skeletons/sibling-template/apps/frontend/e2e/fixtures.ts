// Shared between playwright.config.ts (which builds and serves the static
// export) and the specs.
//
// Every value here is read by BOTH sides, which is the point: the Cognito ids
// the harness advertises in `/.well-known/biffo-identity.json` must be the same
// ones `session.ts` seeds a localStorage session with, or the app resolves a
// pool it has no session for and silently redirects to the portal. That exact
// mismatch broke tabsii-geo's CI for four hours (#1208).

export const E2E_PORT = Number(process.env['E2E_PORT'] ?? 4330)

// The path CloudFront routes to this sibling, e.g. `/crm`. Read from the same
// env var `next.config.ts` uses, so the harness cannot disagree with the build.
export const BASE_PATH = process.env['NEXT_PUBLIC_BASE_PATH'] ?? ''

// Not real credentials, and never used against a real pool — they only have to
// be internally consistent. Shaped like the real thing so anything that parses
// a pool id does not choke.
export const COGNITO_USER_POOL_ID = 'us-east-1_E2ETESTPOOL'
export const COGNITO_CLIENT_ID = 'e2etestclientid0123456789'

// Injected into `next build` by the Playwright webServer.
//
// Deliberately NO `NEXT_PUBLIC_CORE_COGNITO_*`: a sibling resolves its pool at
// RUNTIME from the identity document (#403), exactly as the deployed app does.
// Baking a build-time fallback here would make the harness pass in a way the
// real app cannot, which is the failure this scaffold exists to prevent.
export const BUILD_ENV: Record<string, string> = {
  NEXT_PUBLIC_BASE_PATH: BASE_PATH,
  NEXT_PUBLIC_E2E: '1',
  NEXT_PUBLIC_API_URL: '',
  // LOAD-BEARING, and not obviously so. `src/app/page.tsx` only redirects a
  // signed-out visitor `if (state.kind === 'signed_out' && CORE_PORTAL_URL)`.
  // Leave this unset and the app has nowhere to send them, so it never
  // redirects, so `smoke.spec.ts` passes whatever the auth wiring does —
  // including with the identity document removed entirely.
  //
  // That is not hypothetical: the first draft of this scaffold omitted it, and
  // the smoke test passed against a harness deliberately broken the same way
  // tabsii-geo's was (#1208). A test that cannot fail is worse than no test,
  // because it reports coverage. Verified after adding it: breaking the
  // identity document makes the spec fail on the redirect.
  NEXT_PUBLIC_CORE_PORTAL_URL: 'https://portal.example.test',
}
