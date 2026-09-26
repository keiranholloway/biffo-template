import { readFileSync } from 'node:fs'
import type { PluginManifest } from '../plugin-manifest.js'
import { resolvePluginConfigSupply } from '../plugin-config-resolution.js'

/**
 * Plugin config for the local composition (biffo-template#1525, on #1517).
 *
 * The values come from a local JSON file — `{ "<config name>": "<value>" }` — but
 * they are turned into env vars by the SAME function `biffo plugin install` uses
 * (`resolvePluginConfigSupply`), so the names, the secret/setting split and the
 * required-ness rule cannot drift from a real install. The one local step is
 * what install gets from the operator: a `secret` at install is an SSM PARAMETER
 * PATH, never the value. Locally the file holds the value, so it is parked in the
 * local SSM stand-in at a synthetic path and THAT path is what gets supplied — the
 * plugin's own code then resolves it through the real `resolve_secret` (env var →
 * `ssm.get_parameter`), the same path a deployed host runs.
 */
export interface DevConfig {
  /** Env vars for the plugin host (the process `get_plugin_config` runs in). */
  env: Record<string, string>
  /** SSM parameters the local sink must serve, path → value. */
  parameters: Map<string, string>
  /** One line per resolved value — names only, never a secret's value. */
  summary: string[]
}

export function readDevConfigFile(path: string): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`dev config ${path} is not readable JSON: ${(err as Error).message}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`dev config ${path} must be a JSON object of { "<config name>": "<value>" }`)
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new Error(`dev config ${path}: "${key}" must be a string`)
    }
    out[key] = value
  }
  return out
}

export function resolveDevConfig(
  manifest: PluginManifest,
  values: Readonly<Record<string, string>>,
  sourceLabel: string,
): DevConfig {
  const declared = new Map(manifest.config.map((d) => [d.name, d]))
  const unknown = Object.keys(values).filter((k) => !declared.has(k))
  if (unknown.length > 0) {
    throw new Error(
      `${sourceLabel} supplies value(s) the manifest does not declare: ${unknown.join(', ')} ` +
        `(declared: ${[...declared.keys()].join(', ') || 'none'}) — a typo here would leave the ` +
        `real entry unconfigured`,
    )
  }

  const parameters = new Map<string, string>()
  const supplied: Record<string, string> = {}
  for (const [name, raw] of Object.entries(values)) {
    const decl = declared.get(name)
    if (decl?.kind === 'secret' && raw.trim()) {
      const path = `/biffo-dev/${manifest.name}/${name}`
      parameters.set(path, raw.trim())
      supplied[name] = path
    } else {
      supplied[name] = raw
    }
  }

  const { resolved, missingRequired } = resolvePluginConfigSupply(
    manifest.name,
    manifest.config,
    supplied,
  )
  if (missingRequired.length > 0) {
    const lines = missingRequired.map((m) => `  - ${m.name} (${m.kind}): ${m.description}`)
    throw new Error(
      `Plugin '${manifest.name}' declares ${missingRequired.length} required config value(s) ` +
        `missing from ${sourceLabel}:\n${lines.join('\n')}`,
    )
  }
  const env: Record<string, string> = {}
  const summary: string[] = []
  for (const r of resolved) {
    // A secret's env var holds the synthetic SSM path (what install would hold), not the value.
    env[r.envName] = r.value
    summary.push(`${r.kind} ${r.name} -> ${r.envName}`)
  }
  return { env, parameters, summary }
}
