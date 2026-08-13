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
  has_admin_ingress: boolean
  /**
   * The Cognito group `admin_ingress.required_group` names, or `null` when
   * `has_admin_ingress` is false. `plugin-nav-contract.ts` uses this to hide
   * a nav entry the caller cannot reach (issue #1555) — it is a UI
   * courtesy, never a substitute for the shared plugin host's own gate.
   */
  admin_required_group: string | null
  /**
   * The manifest's first `ui_components` `nav-link` entry's `label`, or
   * `null` if it declares none / it's malformed. Its `path` is never sent
   * here — see `plugin-nav-contract.ts`'s `derivePluginAdminHref` for why.
   */
  admin_nav_label: string | null
}

/** Fetch all installed plugins from the real Core API endpoint. */
export function fetchInstalledPlugins(
  client: Pick<ReturnType<typeof createApiClient>, 'get'>,
): Promise<InstalledPlugin[]> {
  return client.get<InstalledPlugin[]>('/api/v1/admin/plugins/available')
}

/**
 * Fetches the Biffo plugin registry so the marketplace dashboard can list
 * available plugins.
 *
 * The registry is a public, static `plugins.json` file hosted in the
 * `keiranholloway/biffo-plugins-registry` GitHub repo — a real, separate
 * repo (confirmed via `gh api repos/keiranholloway/biffo-plugins-registry`),
 * not a Core API endpoint. It's fetched client-side (rather than at portal
 * build time) because the registry can change independent of portal
 * deploys, and this app is a Next.js static export (`output: 'export'` in
 * next.config.ts) with no server runtime to proxy the request through.
 *
 * The entry shape below mirrors the registry's own `registry-schema.json`
 * (fetched 2026-07-02), which is distinct from — and not to be confused
 * with — `_skeletons/registry/registry-schema.json` in this template repo,
 * which actually validates a plugin's own `biffo.plugin.json` manifest. The
 * same registry shape is also asserted by `cli/src/adapters/registry/index.ts`.
 */

export const REGISTRY_URL =
  'https://raw.githubusercontent.com/keiranholloway/biffo-plugins-registry/main/plugins.json'

/**
 * One `ui_components` entry, matching `_skeletons/registry/registry-schema.json`
 * (and the identical `_skeletons/plugin-template/registry-schema.json`) —
 * an array of objects, not the `string[]` this field used to be typed as
 * (issue #1555). `type` is deliberately left as `string` rather than the
 * schema's five-member enum: this interface describes the registry's own
 * `plugins.json` entries, a hand-maintained external file this client only
 * lightly validates (see `isRegistryShape` below), so over-narrowing the
 * type would make a real but unanticipated value a compile-time lie rather
 * than a runtime one.
 */
export interface UiComponentEntry {
  type: string
  label: string
  path: string
  icon?: string
  requires_auth?: boolean
}

export interface RegistryPlugin {
  name: string
  version: string
  minor_version: string
  repo: string
  description?: string
  author?: string
  tags?: string[]
  required_core_version?: string
  infra_modules?: string[]
  api_routes?: string[]
  ui_components?: UiComponentEntry[]
  status: 'active' | 'disabled'
}

export interface PluginRegistry {
  schema_version: string
  last_updated: string
  plugins: RegistryPlugin[]
}

export class PluginRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginRegistryError'
  }
}

function isRegistryShape(value: unknown): value is PluginRegistry {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { plugins?: unknown }).plugins)
  )
}

/** Fetches and lightly validates plugins.json from the registry. */
export async function fetchPluginRegistry(): Promise<PluginRegistry> {
  let response: Response
  try {
    response = await fetch(REGISTRY_URL)
  } catch (err) {
    throw new PluginRegistryError(
      `Could not reach the plugin registry: ${err instanceof Error ? err.message : 'unknown error'}`,
    )
  }

  if (!response.ok) {
    throw new PluginRegistryError(
      `Plugin registry request failed (${String(response.status)} ${response.statusText})`,
    )
  }

  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new PluginRegistryError('Plugin registry did not return valid JSON.')
  }

  if (!isRegistryShape(data)) {
    throw new PluginRegistryError('Plugin registry response has an unexpected shape.')
  }

  return data
}

/** Fetches the registry and returns only plugins visible in the marketplace. */
export async function fetchActivePlugins(): Promise<RegistryPlugin[]> {
  const registry = await fetchPluginRegistry()
  return registry.plugins.filter((plugin) => plugin.status !== 'disabled')
}
