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
