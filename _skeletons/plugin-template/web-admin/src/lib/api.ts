// STARTER admin API client — wires this plugin's own endpoints on top of the
// DISTRIBUTED shared request core in ./api-core.ts, then gets replaced with
// this plugin's real resources. See api-core.ts's header for why the core is
// shared and this file is not: every existing plugin's api.ts mixed the same
// fetch/auth/error core with a wholly different endpoint surface (idea-scout:
// build-types/agents/models; ideation: chat-agents; marketing: campaigns), so
// only the core distributes — this file is this plugin's own and is never
// synced (biffo-template#1492).
//
// The base MUST be under `/api/v1/plugins/<this-plugin-slug>` — not
// `/api/v1/admin/*`. The CDN forwards `/api/v1/plugins/*` to the plugin host;
// everything else falls through to the portal origin, which answers with its
// own HTML shell and a 403 that reads as "no data" rather than "wrong route"
// (biffo-template#1492, ideation#69 in miniature).
import { createRequest } from './api-core'
import { getFreshIdToken } from './auth'

export { ApiError } from './api-core'

const BASE = '/api/v1/plugins/example-plugin'

/**
 * Example shape for a plugin-owned API client. Replace `Widget`/`list`/`create`
 * with this plugin's real resources — see idea-scout's or ideation's api.ts
 * for a worked example with multiple resource groups and bases.
 */
export interface Widget {
  id: string
  label: string
}

export function createApi(getIdToken = getFreshIdToken) {
  const request = createRequest(getIdToken, BASE)
  return {
    list: () => request<Widget[]>('GET', '/widgets'),
    create: (draft: Omit<Widget, 'id'>) => request<Widget>('POST', '/widgets', draft),
  }
}

export type Api = ReturnType<typeof createApi>
