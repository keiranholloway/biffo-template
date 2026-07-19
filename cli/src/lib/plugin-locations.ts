/**
 * Where plugins live, and what that says about who owns them (issue #243).
 *
 * There are two plugin channels, distinguished purely by directory:
 *
 * - `services/_plugins/<name>/` — **first-party**. Shipped in the template,
 *   template-owned in `core-manifest.json`, carried into instances by
 *   `biffo core upgrade`. Versioned and CI-tested in lockstep with core.
 * - `services/<name>/` — **third-party / user**. Installed from the registry
 *   by `biffo plugin install`, or hand-authored. User-owned, so an upgrade
 *   never overwrites it.
 *
 * The split is an *ownership* boundary only. Discovery
 * (`services/api/src/api/plugins.py`), the deploy packaging loops, the
 * `modules/plugins/<name>/` Terraform module and the plugin's Lambda name are
 * all keyed on the plugin **name**, so a plugin behaves identically at runtime
 * whichever channel it came from.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Subdirectory of `services/` holding first-party (template-owned) plugins. */
export const FIRST_PARTY_PLUGINS_DIR = '_plugins'

export const PLUGIN_MANIFEST_FILE = 'biffo.plugin.json'

export type PluginChannel = 'first-party' | 'third-party'

export interface PluginLocation {
  /** Directory name, which is also the plugin's expected `name`. */
  dirName: string
  /** Repo-relative directory, e.g. `services/_plugins/orchestrator`. */
  relDir: string
  /** Absolute path to the plugin's `biffo.plugin.json`. */
  manifestPath: string
  channel: PluginChannel
}

/**
 * The repo-relative directory a plugin of `channel` named `name` belongs in.
 * Callers that *write* a plugin should go through this rather than joining
 * paths themselves, so the ownership boundary stays in one place.
 */
export function pluginDir(name: string, channel: PluginChannel): string {
  return channel === 'first-party'
    ? `services/${FIRST_PARTY_PLUGINS_DIR}/${name}`
    : `services/${name}`
}

function scanDir(absDir: string, relDir: string, channel: PluginChannel): PluginLocation[] {
  if (!existsSync(absDir)) return []
  const found: PluginLocation[] = []
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    // `_plugins` is a container for first-party plugins, not a plugin itself.
    if (channel === 'third-party' && entry.name === FIRST_PARTY_PLUGINS_DIR) continue
    const manifestPath = join(absDir, entry.name, PLUGIN_MANIFEST_FILE)
    if (!existsSync(manifestPath)) continue
    found.push({
      dirName: entry.name,
      relDir: `${relDir}/${entry.name}`,
      manifestPath,
      channel,
    })
  }
  return found
}

/**
 * Every plugin directory in a checkout, across both channels, sorted by
 * repo-relative path for deterministic output.
 */
export function findInstalledPlugins(cwd: string): PluginLocation[] {
  const servicesDir = join(cwd, 'services')
  return [
    ...scanDir(servicesDir, 'services', 'third-party'),
    ...scanDir(
      join(servicesDir, FIRST_PARTY_PLUGINS_DIR),
      `services/${FIRST_PARTY_PLUGINS_DIR}`,
      'first-party',
    ),
  ].sort((a, b) => a.relDir.localeCompare(b.relDir))
}

/**
 * Resolve an installed plugin by name across both channels, or `null`.
 * A name can only resolve once — a plugin name is globally unique (it keys the
 * Terraform module and the Lambda), so the same name in both channels is a
 * misconfiguration; first-party wins here and callers should surface it.
 */
export function findInstalledPlugin(cwd: string, name: string): PluginLocation | null {
  const matches = findInstalledPlugins(cwd).filter((p) => p.dirName === name)
  return matches.find((p) => p.channel === 'first-party') ?? matches[0] ?? null
}
