/**
 * Drift guard for the ADR-0009 service-principal allowlist glob (issue #266).
 *
 * `modules/cloud/aws/plugin-allowlist` builds the ARN glob for a plugin's IAM
 * role from the plugin's *name*. That only works because two other modules name
 * things the way it assumes:
 *
 *   modules/cloud/aws/compute     role name = "<project>-<env>-<function>-role"
 *   modules/plugins/_template     function  = "plugin-<name>"
 *
 * Nothing in Terraform enforces the relationship — the allowlist never
 * references either module, and that independence is the whole point (see the
 * module's main.tf). So a rename in either one would leave the glob pointing at
 * a role name that no longer exists, and `terraform validate` would still pass.
 * The failure is closed (calls rejected, not wrongly allowed) but silent and
 * per-instance.
 *
 * This guard closes that gap by reading the three module sources and
 * *symbolically* composing the role name the naming modules actually build,
 * then checking the allowlist's glob is exactly that. It is deliberately a
 * source-level check rather than a Terraform assertion: the divergence to catch
 * is between two configurations that never evaluate together, so there is no
 * plan in which a Terraform-level `precondition` could compare them.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const COMPUTE_MAIN_TF = 'modules/cloud/aws/compute/main.tf'
export const PLUGIN_TEMPLATE_MAIN_TF = 'modules/plugins/_template/main.tf'
export const ALLOWLIST_MAIN_TF = 'modules/cloud/aws/plugin-allowlist/main.tf'
export const ALLOWLIST_VARIABLES_TF = 'modules/cloud/aws/plugin-allowlist/variables.tf'

/** Placeholders the symbolic resolution collapses interpolations down to. */
const PROJECT = '<project>'
const ENV = '<env>'
const PLUGIN = '<plugin>'
const ACCOUNT = '<account>'

export interface Violation {
  file: string
  message: string
}

function read(repoRoot: string, relative: string): string {
  try {
    return readFileSync(join(repoRoot, relative), 'utf8')
  } catch {
    throw new Error(`plugin-allowlist drift guard: cannot read ${relative}`)
  }
}

/** Extracts `<name> = "<double-quoted literal>"`, returning the raw literal. */
function assignedString(source: string, name: string): string | undefined {
  const match = new RegExp(`^\\s*${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*$`, 'm').exec(source)
  return match?.[1]
}

/**
 * Collapses `${...}` interpolations using `bindings`, repeatedly, so nested
 * references (`local.function_name` -> `local.name_prefix` -> `var.*`) resolve.
 * Any reference with no binding is left intact and shows up in the diff.
 */
function resolve(expression: string, bindings: Record<string, string>): string {
  let current = expression
  for (let pass = 0; pass < 10; pass += 1) {
    const next = current.replace(/\$\{([^}]+)\}/g, (whole, ref: string) => {
      const bound = bindings[ref.trim()]
      return bound === undefined ? whole : bound
    })
    if (next === current) break
    current = next
  }
  return current
}

/** The IAM role name `modules/cloud/aws/compute` builds for a plugin function. */
export function composeExpectedRoleName(repoRoot: string): string {
  const compute = read(repoRoot, COMPUTE_MAIN_TF)
  const template = read(repoRoot, PLUGIN_TEMPLATE_MAIN_TF)

  const namePrefix = assignedString(compute, 'name_prefix')
  const functionName = assignedString(compute, 'function_name')
  const roleName = /resource\s+"aws_iam_role"\s+"lambda"\s*\{[^}]*?\bname\s*=\s*"([^"]*)"/s.exec(
    compute,
  )?.[1]
  if (!namePrefix || !functionName || !roleName) {
    throw new Error(
      `plugin-allowlist drift guard: could not read the naming convention out of ${COMPUTE_MAIN_TF}. ` +
        'If that module was restructured, update this guard along with it.',
    )
  }

  // The function_name modules/plugins/_template passes into the compute module.
  const pluginFunctionName = /module\s+"function"\s*\{[\s\S]*?\bfunction_name\s*=\s*"([^"]*)"/.exec(
    template,
  )?.[1]
  if (!pluginFunctionName) {
    throw new Error(
      `plugin-allowlist drift guard: could not read module "function"'s function_name out of ${PLUGIN_TEMPLATE_MAIN_TF}.`,
    )
  }

  const bindings: Record<string, string> = {
    'var.project_name': PROJECT,
    'var.environment': ENV,
    'var.plugin_name': PLUGIN,
    'var.function_name': resolve(pluginFunctionName, {
      'var.plugin_name': PLUGIN,
    }),
  }
  bindings['local.name_prefix'] = resolve(namePrefix, bindings)
  bindings['local.function_name'] = resolve(functionName, bindings)

  return resolve(roleName, bindings)
}

/** The glob `modules/cloud/aws/plugin-allowlist` builds, in the same placeholders. */
export function readAllowlistGlob(repoRoot: string): string {
  const allowlist = read(repoRoot, ALLOWLIST_MAIN_TF)
  const glob = /for\s+name\s+in\s+var\.enabled_plugins\s*:\s*\n\s*"([^"]*)"/.exec(allowlist)?.[1]
  if (!glob) {
    throw new Error(
      `plugin-allowlist drift guard: could not find the "for name in var.enabled_plugins" glob in ${ALLOWLIST_MAIN_TF}.`,
    )
  }
  return resolve(glob, {
    'data.aws_caller_identity.current.account_id': ACCOUNT,
    'var.project_name': PROJECT,
    'var.environment': ENV,
    name: PLUGIN,
  })
}

/**
 * Returns every way the allowlist module and the naming modules disagree.
 * Empty means they are consistent.
 */
export function checkAllowlistConvention(repoRoot: string): Violation[] {
  const violations: Violation[] = []

  const expectedRoleName = composeExpectedRoleName(repoRoot)
  const expectedGlob = `arn:aws:sts::${ACCOUNT}:assumed-role/${expectedRoleName}/*`
  const actualGlob = readAllowlistGlob(repoRoot)

  if (actualGlob !== expectedGlob) {
    violations.push({
      file: ALLOWLIST_MAIN_TF,
      message:
        `the allowlist glob no longer matches the role name the naming modules build.\n` +
        `  ${COMPUTE_MAIN_TF} + ${PLUGIN_TEMPLATE_MAIN_TF} produce: ${expectedGlob}\n` +
        `  ${ALLOWLIST_MAIN_TF} allowlists:                        ${actualGlob}\n` +
        'Plugins would be rejected by require_service_principal (ADR-0009). Fix the glob, not this guard.',
    })
  }

  // Fail-closed: no plugins enabled must mean no service caller accepted.
  const variables = read(repoRoot, ALLOWLIST_VARIABLES_TF)
  const enabledPluginsBlock = /variable\s+"enabled_plugins"\s*\{[\s\S]*?\n\}/.exec(variables)?.[0]
  if (!enabledPluginsBlock || !/\bdefault\s*=\s*\[\s*\]/.test(enabledPluginsBlock)) {
    violations.push({
      file: ALLOWLIST_VARIABLES_TF,
      message:
        'enabled_plugins must default to [] so an unconfigured instance allowlists nobody (ADR-0009 fail-closed).',
    })
  }

  return violations
}
