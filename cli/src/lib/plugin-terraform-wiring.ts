/**
 * Wires installed plugin Terraform modules into the root configs under
 * `infra/environments/*` (issue #201, extending #25).
 *
 * ## Why a generated file rather than editing `main.tf`
 *
 * `infra/` is **user-owned** (see `core-manifest.json`) and every `main.tf`
 * under it is hand-authored, comment-heavy, and re-ordered freely by whoever
 * owns the instance. Appending text to it, or parsing and re-emitting it as
 * HCL, means the CLI silently owns bytes a human is also editing — and the
 * first merge conflict or reformatting pass corrupts a file that stands
 * between the user and their infrastructure.
 *
 * So the CLI never touches `main.tf`. Terraform loads **every** `*.tf` file in
 * a root module directory, so the module blocks live in their own
 * CLI-owned file, `plugins.generated.tf`, which is regenerated wholesale from
 * the contents of `modules/plugins/`. This mirrors the precedent already set
 * by `biffo sibling create`, which registers siblings through a generated
 * `siblings.auto.tfvars.json` rather than editing the CDN config by hand.
 *
 * ## Idempotency
 *
 * The generated file is a **pure function of the directory listing** of
 * `modules/plugins/` — it is never appended to, only rewritten in full. Running
 * `biffo plugin install` twice therefore produces byte-identical output, and a
 * duplicate `module "plugin_<name>"` block or a duplicated `enabled_plugins`
 * entry is not merely avoided, it is unrepresentable. `biffo plugin uninstall`
 * calls the same function after removing the module directory, so the block
 * disappears with it (leaving it behind would break `terraform validate` with a
 * dangling `source` path).
 *
 * ## The `enabled_plugins` entry
 *
 * Emitted as `plugins.auto.tfvars.json`. Terraform auto-loads `*.auto.tfvars*`
 * from the working directory, so an installed plugin is enabled with no further
 * action — while `-var` / `-var-file` / `TF_VAR_enabled_plugins`, which all
 * outrank auto-tfvars, remain available to disable one without uninstalling it.
 *
 * ## What is deliberately NOT generated: the Core API allowlist
 *
 * ADR-0009's `BIFFO_SERVICE_PRINCIPAL_ARN_ALLOWLIST` is set in `main.tf` on
 * `module "core_api"`, and it is derived there from `var.enabled_plugins`
 * through a *static* role-name glob. Because the glob is fully predictable from
 * the plugin's name (`<project>-<env>-plugin-<name>-role`, per
 * `modules/cloud/aws/compute/main.tf`), the allowlist needs nothing from this
 * generator: adding the name to `enabled_plugins` is what allowlists it. That
 * is why the allowlist ends up automated *without* this file generating it.
 *
 * The rejected alternative is wiring it from a plugin module's `role_arn`
 * output. Measured honestly, that does not deadlock today — Terraform's graph
 * is resource-level, not module-level, and the `_template` plugin's role
 * happens not to depend on `api_gateway` (only its separate
 * `aws_iam_role_policy.core_api` does), so a `terraform plan` with `role_arn`
 * wired in currently builds. But it is cycle-free only by accident of the
 * current module's internals: any plugin that attached its Core API policy to
 * the role resource itself would close the loop
 * `core_api -> plugin -> api_gateway -> core_api`, and the failure would land
 * on whoever installed that plugin rather than on whoever wrote this code. The
 * static glob has no such dependency at all, for any plugin, which is the
 * property worth having. See `modules/plugins/_template/outputs.tf`.
 *
 * The caller side of the grant — `execute-api:Invoke` on the Core API's
 * internal routes — *is* wired here, via `core_api_execution_arn`, which is
 * cycle-free in the same unconditional sense (`plugin -> api_gateway`, never
 * the reverse).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Never a real plugin — the copy-me skeleton shipped by the template. */
const TEMPLATE_MODULE_DIR = '_template'

/** Lambda entrypoint assumed for a plugin, per ADR-0003 section 2's repo layout. */
export const DEFAULT_PLUGIN_HANDLER = 'src.lambda.main.handler'

export const GENERATED_TF_FILE = 'plugins.generated.tf'
export const GENERATED_TFVARS_FILE = 'plugins.auto.tfvars.json'

/**
 * The standard variable contract from `modules/plugins/_template/variables.tf`,
 * as `name -> HCL expression` in the order they should be emitted.
 *
 * Every argument is emitted only if the plugin's own module actually declares
 * the matching `variable` block — a plugin's `terraform/` directory is copied
 * in verbatim and may predate a variable the template has since added (e.g.
 * `core_api_execution_arn`, added by PR #260). Passing an undeclared variable
 * is a hard `terraform validate` error, so an older plugin module must degrade
 * to "wired in without that feature", not to "the whole environment fails".
 */
function standardArguments(pluginName: string, handler: string): Array<[string, string]> {
  return [
    ['project_name', 'var.project_name'],
    ['environment', 'local.environment'],
    ['plugin_name', JSON.stringify(pluginName)],
    ['handler', JSON.stringify(handler)],
    ['event_bus_name', 'module.events.event_bus_name'],
    ['core_api_url', 'module.api_gateway.api_endpoint'],
    ['core_api_execution_arn', 'module.api_gateway.execution_arn'],
    ['tags', 'local.tags'],
  ]
}

export interface PluginTerraformSyncResult {
  /** Plugin names wired in, sorted. */
  plugins: string[]
  /** Environment directory names under `infra/environments/`, sorted. */
  environments: string[]
  /**
   * Root configs skipped because they declare no `enabled_plugins` variable —
   * an instance whose user-owned `infra/` predates it. Surfaced so the user can
   * copy the variable in rather than wonder why nothing happened.
   */
  skippedEnvironments: string[]
  /** Repo-relative paths written or removed, for `git add`. */
  changedPaths: string[]
}

/**
 * Plugin module directories under `modules/plugins/`, sorted and excluding the
 * `_template` skeleton and any dot-directory.
 */
export function listPluginModules(cwd: string): string[] {
  const dir = join(cwd, 'modules', 'plugins')
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && e.name !== TEMPLATE_MODULE_DIR && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort()
}

/**
 * Root-module environment directories under `infra/environments/` that this
 * generator can safely write into, sorted.
 *
 * Two conditions, both load-bearing:
 *
 * 1. The directory contains a `main.tf` — otherwise it is not a root config and
 *    a `plugins.generated.tf` beside it would be noise.
 * 2. The root config declares an `enabled_plugins` variable, which the
 *    generated `for_each` gate references.
 *
 * The second is a fail-safe for the ownership boundary. `cli/` is
 * template-owned and reaches instances via `biffo core upgrade`, but `infra/`
 * is **user-owned** and does not (`core-manifest.json`) — so an instance can
 * upgrade to a CLI that has this generator while its own environments still
 * predate the `enabled_plugins` variable. Emitting a block that references an
 * undeclared variable would break `terraform validate` for that whole
 * environment, turning a plugin install into an infrastructure outage. Skipping
 * it instead degrades to "not wired here", which the caller reports.
 */
export function listEnvironments(cwd: string): string[] {
  const dir = join(cwd, 'infra', 'environments')
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => {
      if (!e.isDirectory() || !existsSync(join(dir, e.name, 'main.tf'))) return false
      return declaredVariables(join(dir, e.name)).has('enabled_plugins')
    })
    .map((e) => e.name)
    .sort()
}

/**
 * Environment directories that look like root configs but cannot be wired,
 * because they declare no `enabled_plugins` variable. Reported to the user so
 * a skipped environment is visible rather than silent.
 */
export function listUnwirableEnvironments(cwd: string): string[] {
  const dir = join(cwd, 'infra', 'environments')
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter(
      (e) =>
        e.isDirectory() &&
        existsSync(join(dir, e.name, 'main.tf')) &&
        !declaredVariables(join(dir, e.name)).has('enabled_plugins'),
    )
    .map((e) => e.name)
    .sort()
}

/**
 * Variable names a plugin's Terraform module declares, by scanning its `*.tf`
 * files for `variable "<name>"`.
 *
 * A regex rather than an HCL parse: the question is only "does this identifier
 * appear as a variable block label", the CLI has no HCL parser dependency, and
 * a false negative degrades safely (the argument is simply not passed) while a
 * false positive would have to survive `terraform validate` in CI anyway.
 */
export function declaredVariables(moduleDir: string): Set<string> {
  const names = new Set<string>()
  let entries
  try {
    entries = readdirSync(moduleDir, { withFileTypes: true })
  } catch {
    return names
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.tf')) continue
    let contents: string
    try {
      contents = readFileSync(join(moduleDir, entry.name), 'utf8')
    } catch {
      continue
    }
    for (const match of contents.matchAll(/^\s*variable\s+"([^"]+)"/gm)) {
      names.add(match[1]!)
    }
  }
  return names
}

/** Renders `key = value` lines with `=` aligned, as `terraform fmt` requires. */
function renderArguments(args: Array<[string, string]>, indent: string): string {
  const width = Math.max(...args.map(([key]) => key.length))
  return args.map(([key, value]) => `${indent}${key.padEnd(width)} = ${value}`).join('\n')
}

function renderModuleBlock(pluginName: string, declared: Set<string>, handler: string): string {
  const args = standardArguments(pluginName, handler).filter(([key]) => declared.has(key))
  const quoted = JSON.stringify(pluginName)
  return [
    `module "plugin_${pluginName}" {`,
    `  source   = "../../../modules/plugins/${pluginName}"`,
    `  for_each = contains(var.enabled_plugins, ${quoted}) ? { ${quoted} = true } : {}`,
    '',
    renderArguments(args, '  '),
    '}',
    '',
    `output "plugin_${pluginName}_function_arn" {`,
    `  description = "Lambda ARN of the ${pluginName} plugin, or null when it is not in enabled_plugins."`,
    `  value       = try(module.plugin_${pluginName}[${quoted}].function_arn, null)`,
    '}',
  ].join('\n')
}

const GENERATED_HEADER = `# ---------------------------------------------------------------------------
# GENERATED FILE — DO NOT EDIT BY HAND.
#
# Written by \`biffo plugin install\` / \`biffo plugin uninstall\` (issue #201),
# regenerated in full from the contents of modules/plugins/. Any manual edit is
# lost on the next plugin install or uninstall.
#
# Terraform loads every *.tf file in this directory, so these blocks are as
# live as anything in main.tf — they simply live in a CLI-owned file so the
# CLI never has to rewrite your hand-authored main.tf.
#
# Terraform requires a module's \`source\` to be a static string literal, so it
# cannot loop over var.enabled_plugins; hence one explicit block per plugin,
# each gated on membership in enabled_plugins (supplied by the generated
# ${GENERATED_TFVARS_FILE} alongside this file).
#
# Not generated here: the Core API's BIFFO_SERVICE_PRINCIPAL_ARN_ALLOWLIST
# (ADR-0009). It lives in main.tf and is derived from var.enabled_plugins as a
# static role-name glob — deriving it from a plugin module's role_arn output
# would create the cycle core_api -> api_gateway -> plugin -> core_api.
# ---------------------------------------------------------------------------
`

/** The full text of `plugins.generated.tf` for a given set of plugins. */
export function renderGeneratedTerraform(
  plugins: Array<{ name: string; declaredVariables: Set<string>; handler?: string }>,
): string {
  const blocks = plugins.map((p) =>
    renderModuleBlock(p.name, p.declaredVariables, p.handler ?? DEFAULT_PLUGIN_HANDLER),
  )
  return `${GENERATED_HEADER}\n${blocks.join('\n\n')}\n`
}

/** The full text of `plugins.auto.tfvars.json` for a given set of plugin names. */
export function renderGeneratedTfvars(pluginNames: string[]): string {
  return `${JSON.stringify({ enabled_plugins: pluginNames }, null, 2)}\n`
}

/**
 * Regenerate the plugin wiring in every environment root config.
 *
 * Safe to call unconditionally: with no plugin modules installed, both
 * generated files are removed rather than left behind empty, so an instance
 * that never installs a plugin carries no CLI-owned Terraform at all.
 */
export function syncPluginTerraform(cwd: string): PluginTerraformSyncResult {
  const plugins = listPluginModules(cwd)
  const environments = listEnvironments(cwd)
  const skippedEnvironments = listUnwirableEnvironments(cwd)
  const changedPaths: string[] = []

  const rendered = plugins.map((name) => ({
    name,
    declaredVariables: declaredVariables(join(cwd, 'modules', 'plugins', name)),
  }))

  for (const env of environments) {
    const envDir = join(cwd, 'infra', 'environments', env)
    const tfPath = join(envDir, GENERATED_TF_FILE)
    const tfvarsPath = join(envDir, GENERATED_TFVARS_FILE)
    const relBase = `infra/environments/${env}`

    if (plugins.length === 0) {
      for (const [abs, rel] of [
        [tfPath, `${relBase}/${GENERATED_TF_FILE}`],
        [tfvarsPath, `${relBase}/${GENERATED_TFVARS_FILE}`],
      ] as const) {
        if (existsSync(abs)) {
          rmSync(abs)
          changedPaths.push(rel)
        }
      }
      continue
    }

    mkdirSync(envDir, { recursive: true })
    writeFileSync(tfPath, renderGeneratedTerraform(rendered))
    writeFileSync(tfvarsPath, renderGeneratedTfvars(plugins))
    changedPaths.push(`${relBase}/${GENERATED_TF_FILE}`, `${relBase}/${GENERATED_TFVARS_FILE}`)
  }

  return { plugins, environments, skippedEnvironments, changedPaths }
}
