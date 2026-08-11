// STARTER admin API client — demonstrates the request core every plugin's
// admin panel needs, then gets replaced with THIS plugin's own endpoints.
//
// Do not add this file to shared-files.json. Every existing plugin's api.ts
// mixes this same fetch/auth/error core with a wholly different endpoint
// surface (idea-scout: build-types/agents/models; ideation: chat-agents;
// marketing: campaigns) — a `sync` entry here would delete every plugin's own
// API on the next shared-sync run. See biffo-template#1492's PR description
// for the proposed split of the reusable core into its own package.
//
// The base MUST be under `/api/v1/plugins/<this-plugin-slug>` — not
// `/api/v1/admin/*`. The CDN forwards `/api/v1/plugins/*` to the plugin host;
// everything else falls through to the portal origin, which answers with its
// own HTML shell and a 403 that reads as "no data" rather than "wrong route"
// (biffo-template#1492, ideation#69 in miniature). Use `credentials: 'same-origin'`
// never `'include'` cross-origin, and ALWAYS send the fresh token from
// `getFreshIdToken()` (./auth.ts) rather than one captured at mount — a
// snapshotted token 401s for the life of the page once it expires.
const BASE = '/api/v1/plugins/example-plugin'

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
 * Shared request core: JSON in, JSON out, bearer auth, and a readable error on
 * failure. `token` is called per-request (never snapshot the JWT — see
 * `getFreshIdToken` in `./auth.ts`).
 */
export async function request<T>(
  token: () => string | null,
  method: string,
  path: string,
  body?: unknown,
  base: string = BASE,
): Promise<T> {
  const idToken = token()
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  if (!res.ok) {
    // Read the body for the reason: Core returns a JSON detail for a
    // permission failure, and "403" alone tells an admin nothing about which
    // rule bit.
    const detail = await res.text().catch(() => res.statusText)
    throw new ApiError(res.status, detail || res.statusText)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/**
 * Example shape for a plugin-owned API client. Replace `Widget`/`list`/`create`
 * with this plugin's real resources — see idea-scout's or ideation's api.ts
 * for a worked example with multiple resource groups and bases.
 */
export interface Widget {
  id: string
  label: string
}

export function createApi(token: () => string | null) {
  return {
    list: () => request<Widget[]>(token, 'GET', '/widgets'),
    create: (draft: Omit<Widget, 'id'>) => request<Widget>(token, 'POST', '/widgets', draft),
  }
}

export type Api = ReturnType<typeof createApi>
