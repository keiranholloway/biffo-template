/**
 * Fetches and resolves entries from the Biffo plugin registry.
 *
 * Ground truth check (issue #20): ADR-0003 §1 describes a "central JSON
 * registry hosted in a dedicated GitHub repository
 * (keiranholloway/biffo-plugins-registry)". Unlike the SDK's "separate
 * biffo-plugin-sdk repo" framing (which turned out to be aspirational — the
 * SDK actually lives at packages/python-sdk/ in this monorepo, see #66),
 * this repo genuinely exists: `gh repo view keiranholloway/biffo-plugins-registry`
 * confirms it, and its `plugins.json` / `registry-schema.json` match the
 * shape below. It currently ships an empty `plugins: []` — no plugin has
 * been published yet — so `resolvePlugin()` will legitimately fail to find
 * anything until the registry gains real entries.
 *
 * `_skeletons/registry/` in this template repo is a *different* thing
 * despite the confusingly identical filenames: its `registry-schema.json`
 * validates a plugin's own `biffo.plugin.json` manifest (see
 * `../../lib/plugin-manifest.ts`), not the registry index this adapter
 * fetches. Don't conflate the two — see PR description for more detail.
 */
import { z } from 'zod'

// A `ui_components` entry, matching registry-schema.json's shape — an array
// of objects, not the `string[]` this field used to be typed as (#1555).
const UiComponentEntrySchema = z.object({
  type: z.enum(['nav-link', 'page', 'dashboard-widget', 'modal', 'dialog']),
  label: z.string(),
  path: z.string(),
  icon: z.string().optional(),
  requires_auth: z.boolean().optional(),
})

// Mirrors registry-schema.json's `plugins[]` entry shape in the real
// keiranholloway/biffo-plugins-registry repo (fetched 2026-07-02).
const RegistryPluginEntrySchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  minor_version: z.string().regex(/^\d+\.\d+$/),
  repo: z.string().url(),
  description: z.string().optional(),
  author: z.string().optional(),
  tags: z.array(z.string()).optional(),
  required_core_version: z.string().optional(),
  infra_modules: z.array(z.string()).optional(),
  api_routes: z.array(z.string()).optional(),
  ui_components: z.array(UiComponentEntrySchema).optional(),
  status: z.enum(['active', 'disabled']),
})

const PluginRegistrySchema = z.object({
  schema_version: z.string(),
  last_updated: z.string(),
  plugins: z.array(RegistryPluginEntrySchema),
})

export type RegistryPluginEntry = z.infer<typeof RegistryPluginEntrySchema>
export type PluginRegistry = z.infer<typeof PluginRegistrySchema>

export const DEFAULT_REGISTRY_URL =
  'https://raw.githubusercontent.com/keiranholloway/biffo-plugins-registry/main/plugins.json'

export class RegistryAdapter {
  private registryUrl: string

  constructor(registryUrl?: string) {
    this.registryUrl = registryUrl ?? process.env['BIFFO_REGISTRY_URL'] ?? DEFAULT_REGISTRY_URL
  }

  /** Fetches and validates plugins.json from the registry. */
  async fetchRegistry(): Promise<PluginRegistry> {
    let response: Response
    try {
      response = await fetch(this.registryUrl)
    } catch (err) {
      throw new Error(
        `Could not reach the plugin registry at ${this.registryUrl}: ${(err as Error).message}`,
      )
    }

    if (!response.ok) {
      throw new Error(
        `Plugin registry returned ${response.status} ${response.statusText} (${this.registryUrl})`,
      )
    }

    let raw: unknown
    try {
      raw = await response.json()
    } catch (err) {
      throw new Error(
        `Plugin registry at ${this.registryUrl} did not return valid JSON: ${(err as Error).message}`,
      )
    }

    const result = PluginRegistrySchema.safeParse(raw)
    if (!result.success) {
      const messages = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
      throw new Error(
        `Plugin registry at ${this.registryUrl} has an invalid shape: ${messages.join('; ')}`,
      )
    }

    return result.data
  }

  /**
   * Resolves `name@minorVersion` (e.g. "rbac", "1.0") against the registry.
   *
   * The registry stores one entry per plugin — its current release — not a
   * full version history, so "resolving the latest patch for a minor"
   * degenerates to an exact match against that single entry's
   * `minor_version`. True multi-version history isn't representable in the
   * registry schema today; see PR description for this known limitation.
   */
  async resolvePlugin(name: string, minorVersion: string): Promise<RegistryPluginEntry> {
    const registry = await this.fetchRegistry()
    const candidates = registry.plugins.filter((p) => p.name === name)

    if (candidates.length === 0) {
      throw new Error(`Plugin '${name}' was not found in the registry (${this.registryUrl}).`)
    }

    const match = candidates.find((p) => p.minor_version === minorVersion)
    if (!match) {
      const available = candidates.map((p) => `${p.name}@${p.minor_version} (${p.status})`)
      throw new Error(
        `No version matching '${name}@${minorVersion}' found in the registry. ` +
          `Available: ${available.join(', ')}`,
      )
    }

    if (match.status !== 'active') {
      throw new Error(
        `Plugin '${name}@${minorVersion}' is disabled in the registry and cannot be installed.`,
      )
    }

    return match
  }
}
