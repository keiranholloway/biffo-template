// ---------------------------------------------------------------------------
// RUNTIME CORE IDENTITY (#403 / #400)
//
// The core project publishes its Cognito coordinates at
// `/.well-known/biffo-identity.json`, served same-origin from the portal
// bucket (see modules/cloud/aws/cdn/main.tf and .github/workflows/deploy-infra.yml).
// This module resolves that document at RUNTIME so a sibling never has to bake
// the core's User Pool / App Client id into its bundle.
//
// WHY runtime, not build-time:
//   Baking `NEXT_PUBLIC_CORE_COGNITO_*` into the static export copies a
//   snapshot of the core's pool id into every sibling. When the core replaces
//   its pool (or client), every sibling still points at the dead one until it
//   is rebuilt and redeployed — that stranding is exactly the bug class #400
//   and #403 exist to delete. Reading the published document each page load
//   removes the copy entirely: the source of truth lives with the core.
//
// WHY a RELATIVE, same-origin fetch is valid:
//   A sibling and the core portal live on the SAME ORIGIN (baseurl.com/ vs
//   baseurl.com/<name>/). That is the same property that makes shared-session
//   SSO work (see the SHARED-SESSION INVARIANT in auth.ts). So a relative
//   `fetch('/.well-known/biffo-identity.json')` reaches the core's document
//   with no CORS, no configured base URL, and no knowledge of the deployment's
//   domain.
//
// WHY memoised:
//   The document is immutable for a page's lifetime, and auth is read on many
//   code paths. Memoising the in-flight/resolved Promise at module scope makes
//   this exactly ONE network request per page load, shared by every caller,
//   rather than one per session read.
//
// The env fallback below is TRANSITIONAL (Stage 3 of #403 removes it). It lets
// an instance whose core has not yet started publishing the document keep
// working off its baked env vars, so instances can upgrade at their own pace.
// A baked value that shadows a live document is precisely the stale-copy bug
// we are removing, so falling back because the document was UNREACHABLE is a
// degraded path and warns loudly.
// ---------------------------------------------------------------------------

export interface CoreIdentity {
  userPoolId: string
  clientId: string
  region?: string
  apiUrl?: string
  portalUrl?: string
}

// The relative, same-origin path the core publishes its identity document at.
const IDENTITY_DOCUMENT_PATH = '/.well-known/biffo-identity.json'

// Memoised for the page's lifetime: the first call kicks off the fetch and
// every subsequent call shares the same Promise, so the document is requested
// at most once. Storing the Promise (not the resolved value) means concurrent
// callers before the fetch settles also coalesce onto the one request.
let cached: Promise<CoreIdentity | null> | null = null

// Read the transitional env fallback. Returns a valid CoreIdentity only when
// BOTH ids are present; otherwise null (an unconfigured build has neither a
// document nor env, and that is not an error to shout about).
function identityFromEnv(): CoreIdentity | null {
  const userPoolId = process.env['NEXT_PUBLIC_CORE_COGNITO_USER_POOL_ID'] ?? ''
  const clientId = process.env['NEXT_PUBLIC_CORE_COGNITO_CLIENT_ID'] ?? ''
  if (!userPoolId || !clientId) return null
  return { userPoolId, clientId }
}

// A parsed document counts only when it carries both ids non-empty; a document
// missing either is treated as unusable and triggers the fallback.
function identityFromDocument(data: unknown): CoreIdentity | null {
  if (typeof data !== 'object' || data === null) return null
  const doc = data as Record<string, unknown>
  const userPoolId = typeof doc['userPoolId'] === 'string' ? doc['userPoolId'] : ''
  const clientId = typeof doc['clientId'] === 'string' ? doc['clientId'] : ''
  if (!userPoolId || !clientId) return null

  const identity: CoreIdentity = { userPoolId, clientId }
  if (typeof doc['region'] === 'string') identity.region = doc['region']
  if (typeof doc['apiUrl'] === 'string') identity.apiUrl = doc['apiUrl']
  if (typeof doc['portalUrl'] === 'string') identity.portalUrl = doc['portalUrl']
  return identity
}

async function fetchCoreIdentity(): Promise<CoreIdentity | null> {
  try {
    // `no-store`: never let a stale document linger in the fetch cache — the
    // whole point of runtime resolution is to always see the core's current
    // coordinates.
    const res = await fetch(IDENTITY_DOCUMENT_PATH, { cache: 'no-store' })
    if (res.ok) {
      const identity = identityFromDocument(await res.json())
      if (identity) return identity
    }
    // Reached here => the document was served but unusable (non-ok status or
    // missing ids). Fall through to the degraded env fallback below.
  } catch {
    // Network error, or `fetch` not available (e.g. `next build` prerendering
    // `/` in Node with no fetch). Fall through to the env fallback.
  }

  // DEGRADED path: the document was unreachable/unusable, so we lean on the
  // baked env vars. If those exist, warn once — a stale baked value silently
  // shadowing a live document is the #403/#400 bug. If they DON'T exist, this
  // is simply an unconfigured build (no document, no env) — not degradation,
  // so stay quiet.
  const fallback = identityFromEnv()
  if (fallback) {
    console.warn(
      '[biffo] DEGRADED: could not resolve the core identity document at ' +
        `${IDENTITY_DOCUMENT_PATH}; falling back to baked ` +
        'NEXT_PUBLIC_CORE_COGNITO_* env vars. This is transitional (#403) and ' +
        'risks pointing at a stale/dead Cognito pool — ensure the core is ' +
        'publishing the runtime identity document.',
    )
  }
  return fallback
}

/**
 * Resolve the core's Cognito identity at runtime, preferring the published
 * `/.well-known/biffo-identity.json` document and falling back to baked
 * `NEXT_PUBLIC_CORE_COGNITO_*` env vars when the document is unreachable.
 *
 * Memoised: at most one fetch per page load, shared by every caller. Returns
 * null when neither the document nor the env vars supply both ids.
 */
export function resolveCoreIdentity(): Promise<CoreIdentity | null> {
  cached ??= fetchCoreIdentity()
  return cached
}

/**
 * Test-only: clear the memoised resolution so the next `resolveCoreIdentity()`
 * fetches afresh. Production code never calls this — the memo is meant to live
 * for the whole page. Tests that re-import the module via `vi.resetModules()`
 * get a fresh module-scope `cached` for free; this hook is for tests that want
 * to reset within a single module instance.
 */
export function __resetCoreIdentityForTests(): void {
  cached = null
}
