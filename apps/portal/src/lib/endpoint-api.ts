import type { createApiClient } from './api-client'

/**
 * A live API endpoint as returned by `GET /api/v1/admin/endpoints` — one row per
 * mounted route (from the app's OpenAPI schema). Generic-CRUD routes are
 * enriched with permission metadata (`permission_editable` is true only for
 * plugin ones); bespoke hand-written routes have `source: 'bespoke'`,
 * `table`/`operation` null, and `required_role` null (their guard is a
 * dependency, not surfaced in OpenAPI).
 */
export interface Endpoint {
  source: 'plugin' | 'core' | 'bespoke'
  plugin: string | null
  table: string | null
  operation: string | null
  method: string
  path: string
  summary: string | null
  tags: string[]
  required_role: string[] | null
  permission_editable: boolean
}

/** Fetch every live endpoint for this deployment. */
export function fetchEndpoints(
  client: Pick<ReturnType<typeof createApiClient>, 'get'>,
): Promise<Endpoint[]> {
  return client.get<Endpoint[]>('/api/v1/admin/endpoints')
}

// ── Endpoint "specifics" (the swagger-ish detail view) ──────────────────────

export interface SchemaField {
  name: string
  type: string
  required: boolean
  description: string | null
  notes: string | null
}

export interface ParamSpec {
  name: string
  location: string
  type: string
  required: boolean
  description: string | null
}

export interface BodySpec {
  content_type: string
  fields: SchemaField[]
  example: unknown
}

export interface ResponseSpec {
  status_code: string
  description: string | null
  content_type: string | null
  fields: SchemaField[]
  example: unknown
}

export interface EndpointDetail {
  method: string
  path: string
  summary: string | null
  description: string | null
  parameters: ParamSpec[]
  request_body: BodySpec | null
  responses: ResponseSpec[]
}

/** Fetch the request/response specifics for one route (from OpenAPI). */
export function fetchEndpointDetail(
  client: Pick<ReturnType<typeof createApiClient>, 'get'>,
  method: string,
  path: string,
): Promise<EndpointDetail> {
  const qs = `?method=${encodeURIComponent(method)}&path=${encodeURIComponent(path)}`
  return client.get<EndpointDetail>(`/api/v1/admin/endpoints/detail${qs}`)
}

/**
 * An admin request to change one plugin table/operation's API permission
 * (ADR-0008). `allowed: false` disables the endpoint; `required_role` is any-of
 * (empty = any authenticated caller).
 */
export interface EndpointPermissionRequest {
  plugin: string
  table: string
  operation: string
  allowed: boolean
  required_role: string[]
}

/** The outcome of an accepted change: a pull request was opened (not yet live). */
export interface EndpointPermissionResult {
  pr_url: string
  branch: string
}

/**
 * Request a change to one plugin table/operation's API permission.
 *
 * The Core API invokes the isolated PR-signer, which opens a pull request — the
 * change is **not** applied live. It goes live only when that PR is merged
 * through the normal pipeline (config-as-code, ADR-0004). Resolves with the PR
 * URL and branch.
 */
export function changeEndpointPermission(
  client: Pick<ReturnType<typeof createApiClient>, 'post'>,
  req: EndpointPermissionRequest,
): Promise<EndpointPermissionResult> {
  return client.post<EndpointPermissionResult>('/api/v1/admin/endpoints/permission', req)
}
