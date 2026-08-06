// Calls THIS sibling's own backend only (never the core's database directly —
// ADR-0002/ADR-0007). If this sibling needs core-owned data, its own backend
// is responsible for calling the core API server-side (see
// services/api/src/api/core_client.py) — the frontend never talks to the
// core API directly.
const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? ''

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * The message a person should see for a failed request — not the wire format.
 *
 * A Biffo backend's errors are JSON like `{"detail": "..."}`. Throwing the
 * whole body as the message renders `{"detail":"Internal Server Error"}` at
 * the user (tabsii-lms#13, biffo-template#1107) — the API is behaving, the
 * presentation is not.
 *
 * This is the browser-side twin of `_extract_detail` in this repo's
 * `services/api/src/api/core_client.py`, which solves the identical problem
 * server-side, and it keeps that function's reasoning deliberately:
 *
 * - **Parsed, never assumed.** A non-JSON body (a proxy timeout page, a
 *   CloudFront error), or JSON with no `detail`, falls back to the raw text
 *   unchanged — so this can never hide information the caller had before.
 * - **A non-string `detail` also falls back.** FastAPI's own 422 makes
 *   `detail` a list of field errors; picking something out of it would just
 *   move the problem rather than fix it.
 *
 * The one addition over the Python version: an empty body yields the HTTP
 * status text, because a browser rendering `''` shows the user nothing at all.
 */
export function extractErrorMessage(body: string, statusText: string): string {
  const detail = parsedDetail(body)
  if (detail !== null) return detail || statusText
  return body || statusText
}

/**
 * The `detail` a Biffo backend put in its error body, or null if there isn't
 * one to read.
 *
 * Split out of `extractErrorMessage` so the 401 path can ask the same question
 * without re-implementing the answer — writing this parse a second time in the
 * same file is precisely the mistake `_extract_detail` records (#1107/#1108),
 * and a second copy would drift on the next FastAPI change.
 *
 * Returns null for "the backend did not speak", and a string — possibly `''` —
 * for "it did". Callers need that distinction: an empty `detail` still means the
 * body was the product's own shape, and collapsing the two would make an empty
 * string indistinguishable from a CloudFront HTML page.
 */
function parsedDetail(body: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof parsed === 'object' && parsed !== null && 'detail' in parsed) {
    const { detail } = parsed
    // A non-string `detail` also falls back. FastAPI's own 422 makes it a list
    // of field errors; picking something out of it would move the problem
    // rather than fix it.
    if (typeof detail === 'string') return detail
  }
  return null
}

/** A response body as text, or `''` if it could not be read. */
async function bodyOf(res: Response): Promise<string> {
  return res.text().catch(() => '')
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    throw new ApiError(res.status, extractErrorMessage(await bodyOf(res), res.statusText))
  }
  return res.json() as Promise<T>
}

/**
 * What a person is told when their session could not be renewed.
 *
 * "Unauthorized" is not an instruction, and it was not even the app's word: a
 * 401 from the API Gateway JWT authorizer never reaches this app, so its body is
 * `{"message":"Unauthorized"}` — a wire format with no `detail` for
 * `extractErrorMessage` to unwrap (tabsii-lms#3). Reloading is named explicitly
 * because it is what actually works: the mount path renews from the refresh
 * token in localStorage, and if that token is dead too the reload lands on the
 * portal's login, which is where the user needs to be either way.
 */
const SESSION_EXPIRED_MESSAGE =
  'Your session has expired. Reload the page to sign in again, then retry that action.'

/**
 * The message for a 401 that survived a renewal attempt.
 *
 * This deliberately keeps `extractErrorMessage`'s first principle — never hide
 * information the caller already had — rather than stamping the expiry sentence
 * over every 401. A body carrying a `detail` is the product's own voice and may
 * say something the expiry sentence would erase ("Token issued for another
 * tenant"); a body without one is upstream plumbing the user cannot act on, and
 * that is the only case worth replacing.
 *
 * It takes no `statusText`, unlike `extractErrorMessage`: the fallback here is a
 * full sentence rather than a bare status, so there is nothing left for "401" or
 * "Unauthorized" to add.
 */
function unauthorizedMessage(body: string): string {
  const detail = parsedDetail(body)
  return detail !== null && detail !== '' ? detail : SESSION_EXPIRED_MESSAGE
}

/**
 * One renewal in flight at a time, across every client this module hands out.
 *
 * The Cognito session lives in localStorage, shared by the whole page, so a
 * refresh is a property of the app rather than of one client instance — and a
 * page load routinely fans out several calls at once, each of which would
 * otherwise expire together and fire its own refresh. Cognito would then serve
 * concurrent renewals for one session, and the losers could persist a token
 * older than the winner's.
 *
 * Module scope rather than per-client is what makes that true even though
 * `createApiClient` is called in several components independently.
 */
let inFlightRenewal: Promise<string | null> | null = null
let renewalCount = 0

function renewSessionOnce(refreshIdToken: () => Promise<string | null>): Promise<string | null> {
  if (inFlightRenewal) return inFlightRenewal

  // Compared in the `finally` so a settling renewal can only clear itself,
  // never a newer one. (Identity on the promise would say the same thing, but
  // it cannot reference itself before it is assigned.)
  const id = ++renewalCount
  inFlightRenewal = (async () => {
    try {
      return await refreshIdToken()
    } catch {
      // A refresh that throws is indistinguishable, to the user, from one that
      // returns no session: either way they need to sign in again. Rejecting
      // here instead would surface a Cognito internal at them.
      return null
    } finally {
      if (renewalCount === id) inFlightRenewal = null
    }
  })()

  return inFlightRenewal
}

/**
 * Renew through the portal session this sibling already reads (`./auth`).
 *
 * Imported dynamically, for two reasons. It keeps `api-client.ts` free of a
 * load-time dependency on `auth.ts` — which is NOT distributed with this file
 * (it carries a declared per-repo divergence, biffo-template#1117), so a static
 * import would couple a synced file's module graph to one that may legitimately
 * differ. And it keeps the Cognito SDK out of the bundle of any module that only
 * ever calls the API and never hits a 401.
 *
 * `getCurrentSession()` is the renewal: `CognitoUser.getSession()` exchanges the
 * stored refresh token for a fresh id token when the current one has expired.
 * That is exactly what a page reload was already doing by accident, and nothing
 * did on a live call.
 */
async function refreshViaPortalSession(): Promise<string | null> {
  const { getCurrentSession } = await import('./auth')
  const session = await getCurrentSession()
  return session?.getIdToken().getJwtToken() ?? null
}

/**
 * The freshest token this module has renewed a specific stale one into.
 *
 * Every caller passes `getIdToken` as `() => token` closing over React state
 * that a renewal happening outside React never updates (see `send` below).
 * Without this, the SAME stale value keeps coming back from `getIdToken()` for
 * the rest of the page's life, so every request after the first expiry pays a
 * full 401 + renew + retry cycle even though the previous renewal already
 * produced a token that would have worked.
 *
 * Keyed by the stale token it replaced — not just "the freshest token" — and
 * consulted in `send` only when the caller's own `getIdToken()` result still
 * equals that key. That is what makes it safe to share at module scope:
 *
 * - **Safe across sign-out, or a different user signing in.** Either changes
 *   what `getIdToken()` returns, and a Cognito id token is unique per session,
 *   so the new value cannot equal a previous session's `staleToken`. The
 *   cache simply stops matching — nothing has to remember to clear it.
 *   Rejected: a bare "freshest known token" cache with no key would keep
 *   answering with the previous session's token until something explicitly
 *   cleared it on sign-out, which is a security defect (a stale credential
 *   handed to the wrong session) far worse than the latency this fixes.
 * - **Safe for concurrent requests and multiple `createApiClient` instances.**
 *   They all read the same React state through their own `getIdToken`
 *   closures, so they all see the same stale value and all benefit from the
 *   one cache entry — there is nothing per-instance to keep in step, the same
 *   reasoning as `inFlightRenewal` above.
 *
 * Rejected alternative: an optional `onTokenRenewed` callback for callers to
 * update their own state themselves. Cleaner ownership in principle, but it
 * only helps callers that wire it up — every sibling's call sites today do
 * not — so the default path would stay slow. This fixes the default path
 * with no caller changes required.
 */
let renewedTokenCache: { staleToken: string; freshToken: string } | null = null

/**
 * Test-only: clear the module-scope renewal cache so one test's renewal
 * cannot leak into the next. Production code never calls this — the cache is
 * meant to live for the whole page.
 */
export function __resetRenewedTokenCacheForTests(): void {
  renewedTokenCache = null
}

/**
 * What `createApiClient` returns. Named so components can accept a client as a
 * prop without re-deriving the shape (`ReturnType<typeof createApiClient>`
 * spelled out at every call site drifts the moment the client gains a method).
 *
 * Backported from `tabsii-crm`, which added it and then could not receive this
 * file: `filesIfPresent` distributes the skeleton's copy verbatim, so a sync
 * would have deleted an export three of its components import and broken the
 * build. Caught by the sync rehearsal on 2026-08-06 rather than in fourteen
 * repos afterwards.
 *
 * The rule that applies (AGENTS.md, and biffo-template#1198's hard-won version):
 * a file an instance is merely AHEAD on is backported, never overwritten.
 */
export type ApiClient = ReturnType<typeof createApiClient>

export function createApiClient(
  getIdToken: () => string | null,
  refreshIdToken: () => Promise<string | null> = refreshViaPortalSession,
) {
  function authHeaders(token: string | null): HeadersInit {
    return {
      'Content-Type': 'application/json',
      ...(token != null ? { Authorization: `Bearer ${token}` } : {}),
    }
  }

  /**
   * Send the request; on a 401, renew the session once and send it again.
   *
   * The retry is a second statement rather than a recursive call, which is what
   * makes "once" structural: there is no path back to the top, so a genuinely
   * revoked session cannot spin however many 401s it produces.
   *
   * The first attempt prefers `renewedTokenCache` over `getIdToken()` when the
   * caller's own state is still the exact value a previous renewal in this
   * module already replaced — see the doc on `renewedTokenCache` above for why
   * that is safe. That is what stops a page from paying the full cycle on
   * every request for the rest of its life once React state has gone stale.
   *
   * The retry itself carries the token the renewal returned rather than
   * re-reading `getIdToken()`. Every caller passes `() => token` closing over
   * React state, which a renewal outside React has not updated — so re-reading
   * it would re-send the credential the gateway just rejected and burn the one
   * retry.
   */
  async function send<T>(path: string, init: RequestInit): Promise<T> {
    const callerToken = getIdToken()
    const sentToken =
      callerToken !== null && renewedTokenCache?.staleToken === callerToken
        ? renewedTokenCache.freshToken
        : callerToken
    const res = await fetch(`${API_URL}${path}`, { ...init, headers: authHeaders(sentToken) })
    if (res.status !== 401) return handleResponse<T>(res)

    const renewed = await renewSessionOnce(refreshIdToken)
    // An unchanged token means the renewal had nothing newer to give, so the
    // retry would re-send what was just rejected. Skip it rather than spend it.
    if (renewed == null || renewed === sentToken) {
      throw new ApiError(401, unauthorizedMessage(await bodyOf(res)))
    }

    // Cache against the caller's OWN stale value, not `sentToken` (which may
    // already have been substituted from a previous cache hit) — that is the
    // value `getIdToken()` keeps returning for the rest of the page's life, so
    // it is the correct key for the next call to match against.
    if (callerToken !== null) {
      renewedTokenCache = { staleToken: callerToken, freshToken: renewed }
    }

    const retried = await fetch(`${API_URL}${path}`, { ...init, headers: authHeaders(renewed) })
    if (retried.status === 401) {
      throw new ApiError(401, unauthorizedMessage(await bodyOf(retried)))
    }
    return handleResponse<T>(retried)
  }

  return {
    get: <T>(path: string): Promise<T> => send<T>(path, {}),

    post: <T>(path: string, body: unknown): Promise<T> =>
      send<T>(path, { method: 'POST', body: JSON.stringify(body) }),

    put: <T>(path: string, body: unknown): Promise<T> =>
      send<T>(path, { method: 'PUT', body: JSON.stringify(body) }),

    // Folded in from tabsii-crm, which had added it locally. It costs a sibling
    // that never calls it nothing, and leaving it out would mean this file
    // could never be distributed without destroying crm's copy.
    patch: <T>(path: string, body: unknown): Promise<T> =>
      send<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),

    delete: <T>(path: string): Promise<T> => send<T>(path, { method: 'DELETE' }),
  }
}
