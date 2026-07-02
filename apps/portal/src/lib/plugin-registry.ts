/**
 * Fetches plugin metadata from the Biffo plugin registry for display in the
 * portal (marketplace / installed / detail pages).
 *
 * This mirrors the shape `RegistryAdapter` in `cli/src/adapters/registry/`
 * validates against the real `keiranholloway/biffo-plugins-registry` repo's
 * `plugins.json` — see that file's header comment for the ground-truth
 * investigation. Note there is no `changelog` field: ADR-0003 §7 describes
 * the (unbuilt) plugin detail page as showing "changelog, screenshots,
 * required permissions", but none of those exist in the actual registry
 * entry or plugin manifest schema (`_skeletons/registry/registry-schema.json`,
 * which is a different schema entirely — see the registry adapter's header
 * comment) — so this client intentionally does not surface them.
 *
 * The registry currently ships an empty `plugins: []` in production, so
 * "plugin not found" is the common case until plugins are published.
 */

export interface RegistryPluginEntry {
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
  ui_components?: string[]
  status: 'active' | 'disabled'
}

export interface PluginRegistry {
  schema_version: string
  last_updated: string
  plugins: RegistryPluginEntry[]
}

export const DEFAULT_REGISTRY_URL =
  'https://raw.githubusercontent.com/keiranholloway/biffo-plugins-registry/main/plugins.json'

/** Overridable at build time via `NEXT_PUBLIC_REGISTRY_URL`; same knob as the CLI's `BIFFO_REGISTRY_URL`. */
export const REGISTRY_URL = process.env['NEXT_PUBLIC_REGISTRY_URL'] ?? DEFAULT_REGISTRY_URL

export class RegistryFetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RegistryFetchError'
  }
}

function isRegistryPluginEntry(value: unknown): value is RegistryPluginEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry['name'] === 'string' &&
    typeof entry['version'] === 'string' &&
    typeof entry['minor_version'] === 'string' &&
    typeof entry['repo'] === 'string' &&
    (entry['status'] === 'active' || entry['status'] === 'disabled')
  )
}

function isPluginRegistry(value: unknown): value is PluginRegistry {
  if (typeof value !== 'object' || value === null) return false
  const registry = value as Record<string, unknown>
  return Array.isArray(registry['plugins']) && registry['plugins'].every(isRegistryPluginEntry)
}

/** Fetches and validates plugins.json from the registry. */
export async function fetchPluginRegistry(
  registryUrl: string = REGISTRY_URL,
): Promise<PluginRegistry> {
  let response: Response
  try {
    response = await fetch(registryUrl)
  } catch (err) {
    throw new RegistryFetchError(
      `Could not reach the plugin registry: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (!response.ok) {
    throw new RegistryFetchError(
      `Plugin registry returned ${String(response.status)} ${response.statusText}`,
    )
  }

  let raw: unknown
  try {
    raw = await response.json()
  } catch {
    throw new RegistryFetchError('Plugin registry did not return valid JSON')
  }

  if (!isPluginRegistry(raw)) {
    throw new RegistryFetchError('Plugin registry response has an unexpected shape')
  }

  return raw
}

/**
 * Looks up a single plugin by its registry `name` (the portal's route
 * slug). Returns `null` — rather than throwing — when the plugin simply
 * isn't in the registry, since that's the expected common case today.
 */
export async function fetchPluginBySlug(
  slug: string,
  registryUrl: string = REGISTRY_URL,
): Promise<RegistryPluginEntry | null> {
  const registry = await fetchPluginRegistry(registryUrl)
  return registry.plugins.find((plugin) => plugin.name === slug) ?? null
}

/**
 * The exact CLI command to install this plugin — byte-accurate to
 * `pluginInstallCommand` in `cli/src/commands/plugin-install.ts`
 * (`biffo plugin install <name>@<minor>`).
 */
export function installCommandFor(
  entry: Pick<RegistryPluginEntry, 'name' | 'minor_version'>,
): string {
  return `biffo plugin install ${entry.name}@${entry.minor_version}`
}
