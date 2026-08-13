import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import inquirer from 'inquirer'
import { GitAdapter } from '../adapters/git/index.js'
import { log } from '../lib/logger.js'
import { FIRST_PARTY_PLUGINS_DIR, pluginDir } from '../lib/plugin-locations.js'
import { validateManifest } from '../lib/plugin-manifest.js'
import { pluginSeedImportDir } from '../lib/plugin-seed-vendor.js'
import { syncPluginTerraform } from '../lib/plugin-terraform-wiring.js'

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/

export const pluginUninstallCommand = new Command('uninstall')
  .description('Remove an installed plugin: biffo plugin uninstall <name>')
  .argument('<name>', 'Plugin name')
  .option('--dry-run', 'Print planned changes without modifying the repo')
  .option('--force', 'Skip the confirmation prompt')
  .option(
    '--keep-data',
    'No-op today (see notes) — the CLI never drops plugin data regardless of this flag',
  )
  .option('--cwd <path>', 'Project root to uninstall from (defaults to the current directory)')
  .action(
    async (
      name: string,
      options: { dryRun?: boolean; force?: boolean; keepData?: boolean; cwd?: string },
    ) => {
      const cwd = options.cwd ? resolve(options.cwd) : process.cwd()
      try {
        await runPluginUninstall(
          name,
          {
            dryRun: options.dryRun ?? false,
            force: options.force ?? false,
            keepData: options.keepData ?? false,
            cwd,
          },
          { git: new GitAdapter() },
        )
      } catch (err) {
        log.error((err as Error).message)
        process.exit(1)
      }
    },
  )

export interface PluginUninstallDeps {
  git: GitAdapter
}

export interface PluginUninstallOptions {
  dryRun: boolean
  force: boolean
  keepData: boolean
  cwd: string
}

/**
 * Removes an installed plugin from the current Biffo project checkout.
 *
 * Ground-truth flow (see PR description for the full investigation): Core
 * API routes are derived by scanning `services/*\/biffo.plugin.json` at
 * startup (`api.plugins.discover_plugin_manifests`, wired into
 * `build_plugin_router()`) — so removing `services/<name>/` itself is what
 * removes the plugin's routes from future discovery. There is nothing under
 * `apps/portal/` to remove either: `biffo plugin install` (#20) never
 * copies anything into the portal, so "UI components" has nothing to clean
 * up on the CLI side.
 *
 * Migrations are deliberately NOT touched by uninstall. Since `biffo plugin
 * install`/`upgrade`/`sync-migrations` generate a real, git-committed
 * migration file under `services/api/migrations/versions/` (not an
 * ephemeral one — see `PluginMigrationsAdapter`'s docstring), that file is a
 * permanent historical record: deleting it could break `alembic
 * upgrade`/`downgrade` for any environment that has already applied it, not
 * just future ones. This also means a subsequent re-install of the same
 * plugin stays idempotent for free — the migration file is still there, so
 * `sync_plugin_migrations` finds it and generates nothing new.
 *
 * `--keep-data` is accepted for API symmetry with the issue's acceptance
 * criteria but is a real no-op either way: there is no "drop" migration
 * triggered by a plugin manifest disappearing from services/, and per
 * ADR-0002 the CLI has no DB client to drop anything itself even if it
 * wanted to. So a plugin's tables always survive an uninstall from the
 * CLI's perspective, regardless of this flag — seeing it explains that
 * rather than performs it.
 *
 * A vendored baseline-row seed (`db/imports/_plugin-<name>/`,
 * `plugin-seed-vendor.ts`, biffo-template#1554) is left in place for the
 * same reason migrations are: it is the twin of "tables always survive an
 * uninstall" — dropping the rows a seed created is a genuinely destructive,
 * ambiguous operation (a reinstalled plugin, or another tenant onboarded
 * later, may depend on that same reference data), and ADR-0005 already
 * declined to build a `biffo data uninstall` for exactly this reason. Since
 * the seed's `.sql` files are checksum-tracked once applied
 * (`ddl_import_history`), leaving them vendored is also what keeps a later
 * reinstall idempotent for free, the same way an un-deleted migration file
 * does — the DDL import step re-applies nothing, because it already has.
 */
export async function runPluginUninstall(
  name: string,
  options: PluginUninstallOptions,
  deps: PluginUninstallDeps,
): Promise<void> {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`Invalid plugin name '${name}'. Expected a lowercase kebab-case slug.`)
  }

  const servicesDir = join(options.cwd, 'services')
  if (!existsSync(servicesDir)) {
    throw new Error(
      `${servicesDir} does not exist — is ${options.cwd} the root of a Biffo project checkout?`,
    )
  }

  const targetDir = join(servicesDir, name)
  if (!existsSync(targetDir)) {
    // A first-party plugin lives in the template-owned services/_plugins/
    // carve-out (#243). Deleting it here would only be undone by the next
    // `biffo core upgrade`, which re-carries every template-owned path — so
    // point the user at the supported off-switch instead of half-removing it.
    const firstParty = join(servicesDir, FIRST_PARTY_PLUGINS_DIR, name)
    if (existsSync(firstParty)) {
      throw new Error(
        `Plugin '${name}' is a first-party plugin at ${pluginDir(name, 'first-party')}/, which is ` +
          `template-owned — \`biffo core upgrade\` would restore it on the next upgrade. ` +
          `Disable it instead by removing '${name}' from \`enabled_plugins\` in ` +
          `infra/environments/<env>/main.tf and re-applying.`,
      )
    }
    throw new Error(`Plugin '${name}' is not installed at services/${name}/.`)
  }

  const version = readInstalledVersion(targetDir)
  const modulesDir = join(options.cwd, 'modules', 'plugins', name)
  const stagePaths = [`services/${name}`]
  if (existsSync(modulesDir)) {
    stagePaths.push(`modules/plugins/${name}`)
  }

  if (options.dryRun) {
    printDryRun(name, version, stagePaths, options.keepData)
    return
  }

  if (!options.force) {
    const proceed = await confirmUninstall(name, version)
    if (!proceed) {
      log.warn('Uninstall cancelled')
      return
    }
  }

  const isRepo = await deps.git.isGitRepo(options.cwd)
  if (!isRepo) {
    throw new Error(
      `${options.cwd} is not a git repository — biffo plugin uninstall must be run from a Biffo project checkout.`,
    )
  }

  rmSync(targetDir, { recursive: true, force: true })
  log.success(`Removed services/${name}/`)

  if (existsSync(modulesDir)) {
    rmSync(modulesDir, { recursive: true, force: true })
    log.success(`Removed modules/plugins/${name}/`)

    // Regenerate the environment wiring now that the module directory is gone
    // (#201). Leaving the block behind would break `terraform validate` with a
    // dangling module source, so this is a correctness step, not a tidy-up.
    const wiring = syncPluginTerraform(options.cwd)
    stagePaths.push(...wiring.changedPaths)
    if (wiring.changedPaths.length > 0) {
      log.success(
        `Unwired module "plugin_${name}" and its enabled_plugins entry from ` +
          `${wiring.environments.length} environment(s): ${wiring.environments.join(', ')}`,
      )
    }
  }

  const label = version ? `${name}@${version}` : name
  const commitMessage = `chore(plugins): uninstall ${label}`
  await deps.git.add(options.cwd, stagePaths)
  await deps.git.commit(options.cwd, commitMessage)
  log.success(`Committed: ${commitMessage}`)

  console.log(chalk.bold('\n  Plugin uninstalled!\n'))
  console.log(`  services/${name}/ has been removed and committed.`)
  console.log(
    '  Push and redeploy so the Core API stops discovering its routes at the next db-init:',
  )
  console.log(chalk.dim(`    git push`))
  console.log(chalk.dim(`    biffo deploy <environment> --app-only\n`))

  if (options.keepData) {
    console.log(
      chalk.dim(
        '  --keep-data: no action was needed — the CLI never drops plugin tables. See notes.\n',
      ),
    )
  } else {
    log.warn(
      'Any tables this plugin created remain in the database, and its migration file at ' +
        'services/api/migrations/versions/ is NOT removed (it is a permanent historical ' +
        'record — see notes). Dropping tables, if desired, requires a manual Alembic ' +
        'migration written against the Core API.',
    )
  }

  if (existsSync(join(options.cwd, pluginSeedImportDir(name)))) {
    log.warn(
      `${pluginSeedImportDir(name)}/ (this plugin's vendored baseline-row seed, ` +
        'biffo-template#1554) was NOT removed either, for the same reason — see notes. ' +
        'Delete it by hand if you are certain the rows it applied should go too, but note ' +
        'nothing drops rows already applied to the database; that still needs a manual ' +
        'migration.',
    )
  }
}

function readInstalledVersion(targetDir: string): string | undefined {
  const manifestPath = join(targetDir, 'biffo.plugin.json')
  if (!existsSync(manifestPath)) return undefined
  try {
    return validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8'))).version
  } catch {
    return undefined
  }
}

async function confirmUninstall(name: string, version: string | undefined): Promise<boolean> {
  const label = version ? `${name}@${version}` : name
  const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
    {
      type: 'confirm',
      name: 'confirmed',
      message: `Remove ${chalk.bold(label)} from services/${name}/? This cannot be undone from the CLI.`,
      default: false,
    },
  ])
  return confirmed
}

function printDryRun(
  name: string,
  version: string | undefined,
  stagePaths: string[],
  keepData: boolean,
): void {
  const label = version ? `${name}@${version}` : name
  console.log(chalk.bold('\n  Dry run — no changes will be made\n'))
  console.log(`  Plugin:        ${label}`)
  console.log(`  Would remove:  ${stagePaths.join(', ')}`)
  console.log(
    `  Would unwire:  module "plugin_${name}" + its enabled_plugins entry from ` +
      `infra/environments/*/plugins.generated.tf`,
  )
  console.log(`  Would commit:  chore(plugins): uninstall ${label}`)
  console.log(
    `  --keep-data:   ${keepData ? 'no-op — CLI never drops tables either way' : 'not set — no DB action taken either way; see notes'}\n`,
  )
}
