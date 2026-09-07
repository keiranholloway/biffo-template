/**
 * Resolving a plugin manifest's `config:` declarations against the values an
 * instance supplies at `biffo plugin install` time (biffo-template#1517).
 *
 * A manifest's `config` block declares NEEDS — name/kind/required/description
 * — never values (`plugin-manifest.ts`'s `ConfigDeclarationSchema`). This
 * module is the install-time half of the mechanism: it takes whatever the
 * operator supplied (`--config <name>=<value>`, repeatable) and decides,
 * per declaration, whether that need is met — refusing a `secret` value that
 * isn't an SSM parameter reference, and reporting every unmet `required: true`
 * declaration so `plugin-install.ts` can fail the whole install loudly rather
 * than mounting a plugin that will fail — or silently no-op — the first time
 * it is actually used.
 *
 * **Naming.** Every resolved value is destined for an env var named
 * `BIFFO_PLUGIN_<PLUGIN>_<NAME>` (a setting's literal value) or
 * `BIFFO_PLUGIN_<PLUGIN>_<NAME>_PARAMETER` (a secret's SSM parameter path) —
 * this extends the existing `<NAME>_PARAMETER` convention already used by
 * `services/_plugins/agent-runtime`'s `OPENROUTER_API_KEY_PARAMETER` and
 * `orchestrator`'s `WHATSAPP_ACCESS_TOKEN_PARAMETER` with a per-plugin prefix,
 * over the already-shipped env-passing channel (`var.plugin_host_environment`,
 * biffo-template#1534/#1535/#1550/#1560/#1561). `pluginConfigEnvNames` here
 * MUST stay byte-for-byte identical to the SDK's own
 * `biffo_plugin_sdk.config.plugin_config_env_names` — the two are
 * independently maintained (TypeScript vs. Python, no shared import is
 * possible across that boundary), so each side pins the exact computed
 * string in its own tests rather than trusting the two to agree by
 * inspection alone.
 *
 * **What this module does NOT do.** It does not write `infra/environments/`
 * — that tree is user-owned, and `biffo plugin install` already declines to
 * auto-write Terraform it does not own elsewhere in this same command (see
 * the `wiring.skippedEnvironments` warning in `plugin-install.ts`). Instead
 * it computes the exact env var name/value pairs the operator needs to add to
 * their instance's `plugin_host.auto.tfvars.json`'s `plugin_host_environment`
 * map, and prints them — the same "tell the human what's needed" posture
 * already established there, but mechanically derived from the manifest
 * instead of hand-invented per plugin.
 */
import type { PluginManifest } from './plugin-manifest.js'

export type ConfigDeclaration = PluginManifest['config'][number]

export interface PluginConfigEnvNames {
  literalEnv: string
  parameterEnv: string
}

/**
 * `(literal_env, parameter_env)` for one plugin's declared config name.
 * Scoped by plugin name so two plugins declaring the same `configName` (e.g.
 * both calling it `api_key`) never collide on the shared host's one
 * process-wide environment.
 */
export function pluginConfigEnvNames(pluginName: string, configName: string): PluginConfigEnvNames {
  const prefix = `BIFFO_PLUGIN_${pluginName.toUpperCase().replace(/-/g, '_')}_${configName.toUpperCase()}`
  return { literalEnv: prefix, parameterEnv: `${prefix}_PARAMETER` }
}

export interface ResolvedPluginConfigValue {
  name: string
  kind: 'secret' | 'setting'
  description: string
  /** A setting's literal value, or a secret's SSM parameter PATH — never a credential. */
  value: string
  /** The env var name the shared plugin host must be given this under. */
  envName: string
}

export interface MissingRequiredConfig {
  name: string
  kind: 'secret' | 'setting'
  description: string
}

export interface PluginConfigSupplyResult {
  resolved: ResolvedPluginConfigValue[]
  missingRequired: MissingRequiredConfig[]
}

/**
 * Resolves each of a manifest's declared `config` needs against operator-
 * supplied values, and reports which `required: true` needs remain unmet.
 *
 * Throws immediately — rather than adding to `missingRequired` — when a
 * `kind: "secret"` value doesn't look like an SSM parameter path: the whole
 * point of the `<NAME>_PARAMETER` convention is that the instance hands the
 * CLI a *reference*, never a credential to write to disk, so a value that
 * isn't a path is almost certainly an operator pasting the credential itself
 * by mistake and must not be silently accepted.
 */
export function resolvePluginConfigSupply(
  pluginName: string,
  declarations: readonly ConfigDeclaration[],
  supplied: Readonly<Record<string, string>>,
): PluginConfigSupplyResult {
  const resolved: ResolvedPluginConfigValue[] = []
  const missingRequired: MissingRequiredConfig[] = []

  for (const decl of declarations) {
    const raw = supplied[decl.name]
    const value = raw?.trim()
    if (!value) {
      if (decl.required) {
        missingRequired.push({ name: decl.name, kind: decl.kind, description: decl.description })
      }
      continue
    }

    if (decl.kind === 'secret' && !value.startsWith('/')) {
      throw new Error(
        `--config ${decl.name}=... must be an SSM parameter PATH starting with '/' for a ` +
          `'secret' declaration (e.g. /myproject/dev/${pluginName}/${decl.name}) — never the ` +
          `credential itself. Store the credential in SSM first, then pass its parameter name here.`,
      )
    }

    const { literalEnv, parameterEnv } = pluginConfigEnvNames(pluginName, decl.name)
    resolved.push({
      name: decl.name,
      kind: decl.kind,
      description: decl.description,
      value,
      envName: decl.kind === 'secret' ? parameterEnv : literalEnv,
    })
  }

  return { resolved, missingRequired }
}

/**
 * Parses repeatable `--config name=value` option values into a record.
 * Throws on a malformed entry (no `=`, or an empty name) rather than
 * silently dropping it — a typo'd `--config` flag must not read as "not
 * supplied" indistinguishably from actually omitting it.
 */
export function parseConfigOptionValues(entries: readonly string[]): Record<string, string> {
  const record: Record<string, string> = {}
  for (const entry of entries) {
    const eq = entry.indexOf('=')
    if (eq <= 0) {
      throw new Error(`--config value '${entry}' must be of the form name=value`)
    }
    record[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return record
}

/**
 * The error `plugin-install.ts` throws to refuse installation when one or
 * more `required: true` config declarations have no supplied value — this
 * issue's rule 4: fail loudly at install, never mount an unconfigured plugin.
 */
export function missingRequiredConfigMessage(
  pluginName: string,
  missing: readonly MissingRequiredConfig[],
): string {
  const lines = missing.map((m) => `  - ${m.name} (${m.kind}): ${m.description}`)
  return (
    `Plugin '${pluginName}' declares ${missing.length} required config value(s) with no ` +
    `supplied value:\n${lines.join('\n')}\n\n` +
    `Supply each with --config <name>=<value> (repeatable) and re-run install. For a ` +
    `'secret', pass the SSM parameter PATH holding the credential (create the parameter ` +
    `first, e.g. \`aws ssm put-parameter --type SecureString ...\`), never the credential itself.`
  )
}
