import chalk from 'chalk'
import { Command } from 'commander'
import { RegistryAdapter, type RegistryPluginEntry } from '../adapters/registry/index.js'
import { log } from '../lib/logger.js'

export const pluginInfoCommand = new Command('info')
  .description('Show registry details for a plugin: biffo plugin info <name>')
  .argument('<name>', 'Plugin name')
  .action(async (name: string) => {
    try {
      await runPluginInfo(name, { registry: new RegistryAdapter() })
    } catch (err) {
      log.error((err as Error).message)
      process.exit(1)
    }
  })

export interface PluginInfoDeps {
  registry: RegistryAdapter
}

/**
 * Prints every field the registry knows about a plugin.
 *
 * The registry (see adapters/registry/index.ts) stores one entry per
 * plugin — its current release, active or disabled — not a version
 * history, so this shows whatever is there regardless of `status`
 * (unlike `resolvePlugin`, which is used by install/upgrade and rejects
 * disabled plugins; `info` is read-only and should still be able to
 * explain *why* a plugin can't be installed).
 */
export async function runPluginInfo(name: string, deps: PluginInfoDeps): Promise<void> {
  const registry = await deps.registry.fetchRegistry()
  const matches = registry.plugins.filter((p) => p.name === name)

  if (matches.length === 0) {
    throw new Error(`Plugin '${name}' was not found in the registry.`)
  }

  for (const entry of matches) {
    printEntry(entry)
  }
}

function printEntry(entry: RegistryPluginEntry): void {
  console.log(chalk.bold(`\n  ${entry.name}@${entry.version}\n`))
  console.log(`  Status:                 ${entry.status}`)
  console.log(`  Minor version channel:  ${entry.minor_version}`)
  console.log(`  Repo:                   ${entry.repo}`)
  if (entry.description) console.log(`  Description:            ${entry.description}`)
  if (entry.author) console.log(`  Author:                 ${entry.author}`)
  if (entry.tags?.length) console.log(`  Tags:                   ${entry.tags.join(', ')}`)
  if (entry.required_core_version) {
    console.log(`  Required core version:  ${entry.required_core_version}`)
  }
  if (entry.infra_modules?.length) {
    console.log(`  Infra modules:          ${entry.infra_modules.join(', ')}`)
  }
  if (entry.api_routes?.length) {
    console.log(`  API routes:             ${entry.api_routes.join(', ')}`)
  }
  if (entry.ui_components?.length) {
    // Each entry is an object ({type, label, path, ...}), not a bare string
    // (#1555) — print the two fields that identify it at a glance.
    const summary = entry.ui_components.map((c) => `${c.label} (${c.type})`).join(', ')
    console.log(`  UI components:          ${summary}`)
  }
  printScopeSeamEntitlement(entry.name)
  console.log('')
}

/**
 * Where scope-seam entitlement comes from, printed here because this is where
 * a plugin author looks when `/internal/scopes` or `/internal/scope-check`
 * returns 403 (issue #1653).
 *
 * That 403 carries a deliberately generic detail and always will — the two
 * refusal reasons ("you do not hold this code" and "this instance did not
 * entitle your plugin") must stay indistinguishable, or the seam becomes a
 * probe for which codes an instance has entitled to whom. So the explanation
 * belongs on this side of the wire, not in the response.
 *
 * It states the mechanism and the remedy, and deliberately does NOT claim to
 * report the live map. The map is a Python argument evaluated at the
 * instance's domain-module import time; a CLI-side re-derivation (scraping
 * `register_scope_authorizer(` out of instance source) would be a second
 * authority that can disagree with the one that actually acts — the estate's
 * most-recurrent defect class (#1362, eleven recorded instances). Saying
 * plainly that this command cannot read it is more useful than a number that
 * might be wrong.
 */
function printScopeSeamEntitlement(name: string): void {
  console.log('')
  console.log(chalk.bold('  Scope-seam entitlement'))
  console.log('    Declared by the INSTANCE, never by this plugin (ADR-0029, #1653).')
  console.log('    A plugin manifest cannot grant it — biffo.plugin.json is not consulted.')
  console.log('    To let this plugin call GET /internal/scopes or POST /internal/scope-check,')
  console.log('    the instance operator adds it beside their own scope authorizer:')
  console.log('')
  console.log(chalk.dim('      register_scope_authorizer('))
  console.log(chalk.dim('          authorizer,'))
  console.log(
    chalk.dim(`          entitlements={"system:${name}": frozenset({"<permission_code>"})},`),
  )
  console.log(chalk.dim('      )'))
  console.log('')
  console.log(
    chalk.dim(
      "    <permission_code> is one of the INSTANCE's own codes, so ask the operator which\n" +
        "    one covers this plugin's surface. This command cannot report what an instance\n" +
        "    has actually entitled: the map is evaluated in the instance's API at import\n" +
        '    time, and re-deriving it here would be a second authority that can drift from\n' +
        '    the one enforcing the 403.',
    ),
  )
}
