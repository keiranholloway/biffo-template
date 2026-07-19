import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import { log } from '../lib/logger.js'
import { findInstalledPlugins } from '../lib/plugin-locations.js'
import { validateManifest } from '../lib/plugin-manifest.js'

export const pluginListCommand = new Command('list')
  .description('List plugins installed in this project checkout')
  .option('--cwd <path>', 'Project root to scan (defaults to the current directory)')
  .action(async (options: { cwd?: string }) => {
    const cwd = options.cwd ? resolve(options.cwd) : process.cwd()
    try {
      await runPluginList({ cwd })
    } catch (err) {
      log.error((err as Error).message)
      process.exit(1)
    }
  })

export interface PluginListOptions {
  cwd: string
}

interface InstalledPlugin {
  name: string
  version: string
  location: string
}

/**
 * Lists plugins installed in the local checkout.
 *
 * Ground truth (see PR description): there is no installed-plugin registry
 * or manifest tracked anywhere on the CLI side — "installed" only ever
 * meant "a directory was cloned into services/<name>/ and committed"
 * (plugin-install.ts). So the only things this command can honestly report
 * from a local checkout are: which plugin directories exist (in either
 * channel — services/*\/ and services/_plugins/*\/, see lib/plugin-locations.ts),
 * and their declared `version` from that manifest. It deliberately does NOT show "status" or "last-updated" — those
 * fields exist on the *registry* entry shape (RegistryPluginEntry), not on
 * anything recorded locally when a plugin is installed, so showing them
 * here would mean silently making a network call the user didn't ask for
 * (and conflating "registry's current release" with "what's actually
 * checked out", which can legitimately differ once `biffo plugin upgrade`
 * exists). The closest thing to a live "status" is `GET
 * /admin/plugins/available` on a *running* Core API deployment — out of
 * reach from a local git checkout.
 */
export async function runPluginList(options: PluginListOptions): Promise<void> {
  const servicesDir = join(options.cwd, 'services')
  if (!existsSync(servicesDir)) {
    throw new Error(
      `${servicesDir} does not exist — is ${options.cwd} the root of a Biffo project checkout?`,
    )
  }

  const plugins: InstalledPlugin[] = []
  for (const location of findInstalledPlugins(options.cwd)) {
    try {
      const manifest = validateManifest(JSON.parse(readFileSync(location.manifestPath, 'utf8')))
      plugins.push({
        name: manifest.name,
        version: manifest.version,
        location: location.relDir,
      })
    } catch (err) {
      log.warn(
        `Skipping ${location.relDir}/biffo.plugin.json — invalid manifest: ${(err as Error).message}`,
      )
    }
  }

  if (plugins.length === 0) {
    console.log(chalk.dim('\n  No plugins installed in this checkout.\n'))
    return
  }

  const nameWidth = Math.max(...plugins.map((p) => p.name.length), 'NAME'.length)
  const versionWidth = Math.max(...plugins.map((p) => p.version.length), 'VERSION'.length)

  console.log(chalk.bold(`\n  Installed plugins (${plugins.length})\n`))
  console.log(`  ${'NAME'.padEnd(nameWidth)}  ${'VERSION'.padEnd(versionWidth)}  LOCATION`)
  for (const plugin of plugins) {
    console.log(
      `  ${plugin.name.padEnd(nameWidth)}  ${plugin.version.padEnd(versionWidth)}  ${plugin.location}`,
    )
  }
  console.log(
    chalk.dim(
      '\n  Note: no "status" / "last-updated" columns — the CLI tracks no installed-plugin ' +
        'registry locally. Once pushed and deployed, live status is available from the running ' +
        "Core API's GET /admin/plugins/available.\n",
    ),
  )
}
