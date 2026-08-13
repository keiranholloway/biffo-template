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
  console.log('')
}
