import type { createApiClient } from './api-client'

/**
 * A live generic-CRUD endpoint as returned by the Core API's
 * `GET /api/v1/admin/endpoints` — one row per reachable route, with the role it
 * requires (ADR-0004).
 */
export interface Endpoint {
  source: 'plugin' | 'core'
  plugin: string | null
  table: string
  operation: string
  method: string
  path: string
  required_role: string[]
}

/** Fetch the live generic-CRUD endpoints for this deployment. */
export function fetchEndpoints(
  client: Pick<ReturnType<typeof createApiClient>, 'get'>,
): Promise<Endpoint[]> {
  return client.get<Endpoint[]>('/api/v1/admin/endpoints')
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
