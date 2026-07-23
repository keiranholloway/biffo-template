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
// A sibling is DOC-ONLY (#403 Stage 3): it carries NO CORE_COGNITO_* env vars —
// `biffo sibling create` no longer sets them and this module no longer reads
// them. When the document is unreachable, resolution returns null, and the
// caller (getCurrentSession) treats that as "no session" — the sibling redirects
// to the portal's login rather than trusting a stale baked value, because a
// stale value is exactly the bug (#400) this removes. A clean redirect beats a
// silent point at a dead pool.
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
    // Served but unusable (non-ok status or missing ids). Fall through to null.
  } catch {
    // Network error, or `fetch` not available (e.g. `next build` prerendering
    // in Node with no fetch — though resolution is lazy and never runs there).
    // Fall through to null.
  }

  // The document was unreachable or unusable. A sibling has NO baked fallback
  // (#403 Stage 3), so this resolves to null and the caller treats it as
  // "signed out" — a clean redirect to the portal login beats trusting a stale
  // local pool id, which is the exact bug (#400) this removes.
  console.warn(
    `[biffo] could not resolve the core identity document at ${IDENTITY_DOCUMENT_PATH}; ` +
      'treating the visitor as signed out. If this persists, confirm the core is publishing it.',
  )
  return null
}

/**
 * Resolve the core's Cognito identity at runtime from the published
 * `/.well-known/biffo-identity.json` document. A sibling has no env fallback
 * (#403 Stage 3).
 *
 * Memoised: at most one fetch per page load, shared by every caller. Returns
 * null when the document is unreachable or does not supply both ids.
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
