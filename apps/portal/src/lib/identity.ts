// Resolve the core's Cognito identity at RUNTIME, from the document the core
// publishes at /.well-known/biffo-identity.json (#403), instead of baking a
// mutable pool/client id into the bundle at build time.
//
// Why this exists: a build-time copy of a mutable identity is the bug. When the
// core replaces its Cognito pool (which Cognito forces on any change to an
// immutable attribute — username_attributes, alias_attributes, schema), every
// bundle that baked the old id keeps pointing at a pool that no longer exists,
// silently, until someone exercises SSO. Resolving at runtime from one
// published source removes the whole class (#400).
//
// The portal is always rebuilt and redeployed WITH the core, so its baked
// NEXT_PUBLIC_COGNITO_* values are never stale — we keep them as a FALLBACK for
// when the document is momentarily unreachable (a CDN blip must not lock every
// admin out). That is pure belt-and-braces here; a sibling, by contrast, is NOT
// rebuilt on a pool change, so its baked value CAN go stale — which is why
// siblings drop the fallback entirely (Stage 3). When this fallback is used
// because the document was unreachable, we warn: a degraded path should have a
// symptom rather than being silent.
//
// Resolution is memoised for the page's lifetime, so it is ONE request per page
// load, not one per auth call. The fetch lives inside the lazy resolver and is
// never run at module scope: `next build` prerenders pages in Node, where a
// relative fetch has no base URL, and a build has no business needing identity.

export interface CoreIdentity {
  userPoolId: string
  clientId: string
  region?: string | undefined
  apiUrl?: string | undefined
  portalUrl?: string | undefined
}

const IDENTITY_URL = '/.well-known/biffo-identity.json'

let cached: Promise<CoreIdentity> | null = null

/** The core identity, resolved once per page load. Prefers the published
 * document; falls back to the portal's baked NEXT_PUBLIC_COGNITO_* values. */
export function resolveCoreIdentity(): Promise<CoreIdentity> {
  cached ??= doResolve()
  return cached
}

/** Test seam: drop the memoised result so a test can re-resolve. */
export function resetCoreIdentityCache(): void {
  cached = null
}

function bakedFallback(): CoreIdentity {
  return {
    userPoolId: process.env['NEXT_PUBLIC_COGNITO_USER_POOL_ID'] ?? '',
    clientId: process.env['NEXT_PUBLIC_COGNITO_CLIENT_ID'] ?? '',
    region: process.env['NEXT_PUBLIC_COGNITO_REGION'] || undefined,
  }
}

async function doResolve(): Promise<CoreIdentity> {
  try {
    const res = await fetch(IDENTITY_URL, { cache: 'no-store' })
    if (res.ok) {
      const doc = (await res.json()) as Partial<CoreIdentity>
      if (doc.userPoolId && doc.clientId) {
        return {
          userPoolId: doc.userPoolId,
          clientId: doc.clientId,
          region: doc.region,
          apiUrl: doc.apiUrl,
          portalUrl: doc.portalUrl,
        }
      }
    }
    // Reachable but unusable (non-ok, or missing ids) — fall through to fallback.
  } catch {
    // Network error — fall through to fallback.
  }

  const fallback = bakedFallback()
  if (fallback.userPoolId && fallback.clientId) {
    console.warn(
      `[auth] ${IDENTITY_URL} unreachable — using the baked NEXT_PUBLIC_COGNITO_* fallback. ` +
        `This is degraded: the value is only as fresh as the last portal build.`,
    )
  }
  return fallback
}
