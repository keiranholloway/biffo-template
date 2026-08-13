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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, sep } from 'node:path'

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
    // ADR-0021: a user-facing plugin has no Lambda of its own — its module
    // provisions a frontend S3 origin and REQUIRES the parent distribution's
    // ARN, with no default. Without this the generated block cannot plan at
    // all ("No value for required variable"), which is what made #685 break
    // `terraform plan` for a whole environment. Filtered by declaration below,
    // so a Lambda-backed legacy module that does not declare it is unaffected.
    ['cdn_distribution_arn', 'module.cdn.distribution_arn'],
    // biffo-template#1456: an installed plugin has no channel for
    // instance-specific configuration at all, and the first thing that needs
    // one is the deployment's own public origin — a plugin minting a
    // user-visible URL (e.g. a tracked link) cannot derive that from
    // BIFFO_CORE_API_URL, which is the execute-api gateway host, not the
    // branded domain.
    //
    // Routed through the module's existing `environment_variables` map
    // (declared in modules/plugins/_template/variables.tf, merged over
    // BIFFO_CORE_API_URL/BIFFO_PLUGIN_NAME in that module's main.tf) rather
    // than a new bespoke module variable — that hook already exists, already
    // reaches the Lambda, and plugins.core.tf already uses the identical
    // shape for orchestrator's email_branding_env. Adding a dedicated
    // `public_base_url` variable would be a second channel doing the same
    // job.
    //
    // `local.portal_url` is defined once in the *user-owned* main.tf
    // (custom_domain when set, else the CloudFront distribution domain) and
    // is reachable here because Terraform loads every *.tf file in a
    // directory as one module — no argument is being added to a module block
    // declared in another file (the #1538 trap), only a local referenced
    // across files in the same directory, which Terraform has always allowed.
    // It is safe to assume present in every environment this generator writes
    // into: `listEnvironments` already requires `enabled_plugins` to be
    // declared, and `portal_url` was extracted as a local two days before
    // `enabled_plugins` existed at all (8dd54065, predating 64677295) — so
    // any environment old enough to lack it predates the plugin system
    // entirely and is already excluded by that check.
    ['environment_variables', '{ BIFFO_PUBLIC_BASE_URL = local.portal_url }'],
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

/** Where a plugin's Terraform actually lives, relative to a root config under
 * `infra/environments/<env>/`. */
export const FIRST_PARTY_TERRAFORM = (name: string) =>
  `../../../services/_plugins/${name}/terraform`
export const THIRD_PARTY_TERRAFORM = (name: string) => `../../../modules/plugins/${name}`

/**
 * Does this instance carry the plugin as **first-party** source?
 *
 * First-party plugins live in the template-owned `services/_plugins/<name>/`
 * (issue #243) and their Terraform rides `biffo core upgrade` like any other
 * template-owned file.
 */
export function isFirstPartyPlugin(cwd: string, name: string): boolean {
  return existsSync(join(cwd, 'services', '_plugins', name, 'terraform', 'main.tf'))
}

/**
 * The `source` a generated module block should use for *name*.
 *
 * ## Why first-party plugins are referenced in place (issue #406)
 *
 * `biffo plugin install` copies a plugin's `terraform/` into
 * `modules/plugins/<name>/`, and that copy is what Terraform reads. For a
 * **third-party** plugin the copy is the delivery mechanism: its source is
 * cloned from a registry repo and is not otherwise in the tree (ADR-0003).
 *
 * A **first-party** plugin's Terraform is already in the tree, already
 * template-owned, and already synced by `biffo core upgrade`. Copying it as
 * well gave that channel a synced source *and* a stale deployed copy of the
 * same file — so an upgrade updated `services/_plugins/<name>/terraform/` while
 * Terraform kept applying a copy frozen at install time. Nothing failed: the
 * upgrade reported the change, CI passed, `terraform plan` was clean, the
 * deploy succeeded, and the feature simply was not running.
 *
 * Measured in `tabsii-platform` right after a clean 0.50.2 → 0.53.0 upgrade:
 * `agent-runtime` 53 lines adrift, `orchestrator` 15.
 *
 * So first-party plugins point at their real source and there is nothing to go
 * stale. Every other module in `infra/environments/*` is referenced in place;
 * this removes the deviation rather than patching around it.
 */
export function pluginModuleSource(cwd: string, name: string): string {
  return isFirstPartyPlugin(cwd, name) ? FIRST_PARTY_TERRAFORM(name) : THIRD_PARTY_TERRAFORM(name)
}

/**
 * Every plugin that should get a module block in the generated file: the
 * **third-party** copies under `modules/plugins/`, and only those.
 *
 * First-party plugins (`services/_plugins/<name>/`) are deliberately excluded.
 * They are provisioned by `infra/environments/<env>/plugins.core.tf` (ADR-0014,
 * template-owned), which *superseded* #406's approach of wiring them through this
 * generated file ("closing #406", per core-manifest.json). Emitting a block for
 * one here would produce a second `module "plugin_<name>"` for a plugin
 * plugins.core.tf already declares — a duplicate-module error that fails
 * `terraform validate` on every current instance (reproduced installing a
 * third-party plugin onto biffo-platform, which collided on
 * `module "plugin_orchestrator"`).
 *
 * A first-party plugin that still has a *stale* copy under `modules/plugins/` is
 * excluded here too (so it is never wired), and surfaced separately by
 * `staleFirstPartyCopies` for deletion.
 */
export function listWireablePlugins(cwd: string): string[] {
  return listPluginModules(cwd)
    .filter((name) => !isFirstPartyPlugin(cwd, name))
    .sort()
}

/** First-party plugin names — directories under `services/_plugins/` that ship
 * their own `terraform/main.tf`. */
export function firstPartyPluginNames(cwd: string): string[] {
  const dir = join(cwd, 'services', '_plugins')
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && isFirstPartyPlugin(cwd, e.name))
    .map((e) => e.name)
    .sort()
}

/**
 * First-party plugins that still have a copy under `modules/plugins/`.
 *
 * The copy is now dead weight — it is never read and never synced — and while
 * it exists it is the thing someone will mistake for the source of truth. It is
 * template-owned by the `modules/` prefix, so an upgrade will not update it and
 * the ownership guard (#370) discourages editing it: frozen and unmaintainable
 * at once. Surfaced so it can be deleted deliberately.
 */
export function staleFirstPartyCopies(cwd: string): string[] {
  const copied = new Set(listPluginModules(cwd))
  return firstPartyPluginNames(cwd).filter((name) => copied.has(name))
}

/** A single place under `infra/` that still points at a plugin's Terraform
 * module — repo-relative so a refusal can name exactly what it found. */
export interface PluginModuleReference {
  /** Repo-relative path, POSIX-separated regardless of platform. */
  file: string
  /** 1-based line number within `file`. */
  line: number
  /** The matching line, trimmed. */
  text: string
}

function walkTfFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const p = join(dir, entry)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(p)
        continue
      }
      if (entry.endsWith('.tf')) out.push(p)
    }
  }
  walk(root)
  return out.sort()
}

/** Escapes a string for literal use inside a `RegExp`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Every place under `infra/**\/*.tf` that still points at
 * `modules/plugins/<name>/` — the check biffo-template#1563 is for: a refresh
 * that deletes the module without asking whether anything still references it.
 *
 * Two things count as a reference, both found with a per-line regex rather
 * than an HCL parse — same tradeoff `declaredVariables`/`declaredOutputs`
 * already make in this file: no HCL parser dependency, a false negative
 * degrades to "did not detect a reference that exists" (the caller must still
 * treat "found nothing" as "nothing detected", not "provably safe"), and a
 * false positive only ever over-refuses a delete, which is the safe direction
 * for a destructive action:
 *
 * 1. **`source = "…/modules/plugins/<name>"`** — a module block's source, the
 *    line that fails `terraform validate` with a dangling path once the
 *    directory is gone. This is what `plugins.generated.tf` emits for every
 *    wired plugin (`renderModuleBlock` above), and it is also what a
 *    hand-authored `main.tf` would use if a user wired the module in by hand.
 * 2. **`module.plugin_<name>` used as an expression** — an output or another
 *    resource reading the module's attributes (e.g. a hand-authored `main.tf`
 *    pulling a plugin's frontend bucket into the CDN). The generated file's
 *    own re-exported outputs match this too, which is fine: they are real
 *    uses of the module and a reason not to delete it out from under them.
 *
 * Deliberately **not** detected, stated here so a clean result is never read
 * as a proof of safety: a reference reached only through a `local` or
 * variable that itself derives from one of the two forms above (only the
 * literal identifiers are scanned), and anything outside `infra/` — a
 * plugin's own module has no legitimate referrer in `services/` or `apps/`,
 * so that is out of scope rather than a gap.
 */
export function findPluginModuleReferences(cwd: string, name: string): PluginModuleReference[] {
  const infraDir = join(cwd, 'infra')
  // The path a `source = "…"` value must resolve to, as trailing path
  // segments — deliberately not a raw string suffix, so `modules/plugins/idea`
  // does not false-positive against a sibling module `modules/plugins/idea-scout`.
  const sourceSegments = ['modules', 'plugins', name]
  const sourceLinePattern = /^\s*source\s*=\s*"([^"]+)"/
  const moduleRefPattern = new RegExp(`module\\.plugin_${escapeRegExp(name)}(?![A-Za-z0-9_-])`)
  const refs: PluginModuleReference[] = []

  for (const absPath of walkTfFiles(infraDir)) {
    let contents: string
    try {
      contents = readFileSync(absPath, 'utf8')
    } catch {
      continue
    }
    const relPath = relative(cwd, absPath).split(sep).join('/')
    contents.split('\n').forEach((rawLine, idx) => {
      const sourceValue = sourceLinePattern.exec(rawLine)?.[1]
      const sourceValueSegments = sourceValue?.split('/').filter((s) => s.length > 0 && s !== '.')
      const isSourceRef =
        sourceValueSegments !== undefined &&
        sourceValueSegments.slice(-sourceSegments.length).join('/') === sourceSegments.join('/')
      const isExprRef = moduleRefPattern.test(rawLine)
      if (isSourceRef || isExprRef) {
        refs.push({ file: relPath, line: idx + 1, text: rawLine.trim() })
      }
    })
  }
  return refs
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

/**
 * Output names a module declares, read the same way as {@link declaredVariables}.
 *
 * The generator used to hardcode a single `function_arn` output on every
 * plugin. Under ADR-0021 a user-facing plugin has no Lambda and therefore no
 * such output, so the generated block failed with `Unsupported attribute` — a
 * correct, current-architecture module could not be instantiated at all (#685).
 *
 * Deriving them means the CLI carries no per-plugin knowledge: whatever the
 * module declares is what gets re-exported.
 */
export function declaredOutputs(moduleDir: string): Set<string> {
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
    for (const match of contents.matchAll(/^\s*output\s+"([^"]+)"/gm)) {
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

function renderModuleBlock(
  pluginName: string,
  declared: Set<string>,
  handler: string,
  source: string,
  outputs: Set<string>,
): string {
  const args = standardArguments(pluginName, handler).filter(([key]) => declared.has(key))
  const quoted = JSON.stringify(pluginName)

  // Re-export whatever the module declares, rather than assuming `function_arn`.
  // A hardcoded output is why a correct ADR-0021 module could not be
  // instantiated: it has no Lambda, so referencing one is `Unsupported
  // attribute` and the whole environment fails to plan (#685).
  const exported = [...outputs]
    .sort()
    .map((name) =>
      [
        `output "plugin_${pluginName}_${name}" {`,
        `  description = "${name} of the ${pluginName} plugin, or null when it is not in enabled_plugins."`,
        `  value       = try(module.plugin_${pluginName}[${quoted}].${name}, null)`,
        '}',
      ].join('\n'),
    )

  const lines = [
    `module "plugin_${pluginName}" {`,
    `  source   = "${source}"`,
    `  for_each = contains(var.enabled_plugins, ${quoted}) ? { ${quoted} = true } : {}`,
    '',
    renderArguments(args, '  '),
    '}',
    ...(exported.length > 0 ? ['', exported.join('\n\n')] : []),
  ]
  return lines.join('\n')
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
  plugins: Array<{
    name: string
    declaredVariables: Set<string>
    /** Outputs the module declares; each is re-exported. Absent means none. */
    declaredOutputs?: Set<string>
    handler?: string
    /** Defaults to the copied `modules/plugins/<name>` path, which is correct
     * for a third-party plugin; a first-party one passes its real source. */
    source?: string
  }>,
): string {
  const blocks = plugins.map((p) =>
    renderModuleBlock(
      p.name,
      p.declaredVariables,
      p.handler ?? DEFAULT_PLUGIN_HANDLER,
      p.source ?? THIRD_PARTY_TERRAFORM(p.name),
      p.declaredOutputs ?? new Set<string>(),
    ),
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
  // Third-party plugin copies under modules/plugins/ only. First-party plugins
  // are provisioned by plugins.core.tf (ADR-0014), not this generated file — see
  // listWireablePlugins for why wiring them here duplicates module "plugin_<name>".
  const plugins = listWireablePlugins(cwd)
  const environments = listEnvironments(cwd)
  const skippedEnvironments = listUnwirableEnvironments(cwd)
  const changedPaths: string[] = []

  const rendered = plugins.map((name) => {
    const moduleDir = join(cwd, 'modules', 'plugins', name)
    return {
      name,
      declaredVariables: declaredVariables(moduleDir),
      declaredOutputs: declaredOutputs(moduleDir),
      source: pluginModuleSource(cwd, name),
    }
  })

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
