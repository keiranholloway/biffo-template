import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import inquirer from 'inquirer'
import { GitAdapter } from '../adapters/git/index.js'
import { log } from '../lib/logger.js'
import { validateManifest } from '../lib/plugin-manifest.js'

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
 * Ground-truth flow (see PR description for the full investigation):
 * there is no separate "route registration" or "migration" artifact to
 * individually delete. Core API routes and tables are derived purely by
 * scanning `services/*\/biffo.plugin.json` at db-init time
 * (`api.plugins.discover_plugin_manifests`, wired into
 * `main.py::_run_db_init`) — so removing `services/<name>/` itself is what
 * removes the plugin from future discovery. There is nothing under
 * `apps/portal/` to remove either: `biffo plugin install` (#20) never
 * copies anything into the portal, so "UI components" has nothing to clean
 * up on the CLI side.
 *
 * `--keep-data` is accepted for API symmetry with the issue's acceptance
 * criteria but is a real no-op either way: the Core API's migration
 * generator (`services/api/src/api/migrations/plugin_migrations.py`) only
 * ever emits additive CREATE TABLE migrations for plugins it currently
 * discovers. There is no "drop" migration triggered by a plugin manifest
 * disappearing from services/, and per ADR-0002 the CLI has no DB client
 * to drop anything itself even if it wanted to. So a plugin's tables
 * always survive an uninstall from the CLI's perspective, regardless of
 * this flag — seeing it explains that rather than performs it.
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
    log.warn(
      'If this module was wired into infra/environments/*/main.tf by hand, remove that block ' +
        'too — the CLI never edits main.tf (see plugin-install.ts).',
    )
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
      'Any tables this plugin created remain in the database — the CLI has no DB client ' +
        '(ADR-0002) and the Core API only ever generates additive migrations for plugins it ' +
        'discovers. Dropping tables, if desired, requires a manual Alembic migration written ' +
        'against the Core API.',
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
  console.log(`  Would commit:  chore(plugins): uninstall ${label}`)
  console.log(
    `  --keep-data:   ${keepData ? 'no-op — CLI never drops tables either way' : 'not set — no DB action taken either way; see notes'}\n`,
  )
}
