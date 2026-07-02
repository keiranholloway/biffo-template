import type { createApiClient } from '@/lib/api-client'

/**
 * TypeScript mirrors of the Core API's plugin schemas
 * (services/api/src/api/schemas/plugin.py, models/plugin_table.py,
 * models/plugin_route.py). Field-for-field match to the real response of
 * GET /api/v1/admin/plugins/available — not the shape invented in issue #23.
 */

export interface PluginColumnDefinition {
  name: string
  type: string
  primary_key: boolean
  nullable: boolean
  index: boolean
  default: string | null
  description: string
}

export interface PluginIndexDefinition {
  name: string
  columns: string[]
  unique: boolean
}

export interface PluginTableDefinition {
  name: string
  columns: PluginColumnDefinition[]
  indexes: PluginIndexDefinition[]
}

export type PluginRouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type PluginRouteOperation = 'list' | 'read' | 'create' | 'update' | 'delete'

export interface PluginRouteDefinition {
  method: PluginRouteMethod
  path: string
  table: string
  operation: PluginRouteOperation
  description: string
}

/**
 * A single installed plugin, as returned by GET /admin/plugins/available.
 *
 * Deliberately has no `enabled`/`status`/`last_updated` fields — the real
 * endpoint doesn't return them (there's no stored enable/disable state for
 * plugins anywhere in the API; discovery is a static filesystem scan at
 * db-init time). See the PR description for the full scope note.
 */
export interface InstalledPlugin {
  name: string
  version: string
  description: string
  tables: PluginTableDefinition[]
  routes: PluginRouteDefinition[]
}

/** Fetch all installed plugins from the real Core API endpoint. */
export function fetchInstalledPlugins(
  client: Pick<ReturnType<typeof createApiClient>, 'get'>,
): Promise<InstalledPlugin[]> {
  return client.get<InstalledPlugin[]>('/api/v1/admin/plugins/available')
}
