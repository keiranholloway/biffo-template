import { existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import { GitAdapter } from '../adapters/git/index.js'
import { PluginMigrationsAdapter } from '../adapters/plugin-migrations/index.js'
import { log } from '../lib/logger.js'

export const pluginSyncMigrationsCommand = new Command('sync-migrations')
  .description(
    'Generate real, committed migration file(s) for installed-but-not-yet-migrated ' +
      'plugin(s): biffo plugin sync-migrations [name]',
  )
  .argument('[name]', 'Restrict to this installed plugin (default: every plugin under services/)')
  .option('--dry-run', 'Generate nothing; just report what would be generated')
  .option('--no-commit', 'Generate and stage the file(s) but do not commit')
  .option('--cwd <path>', 'Project root (defaults to the current directory)')
  .action(
    async (
      name: string | undefined,
      options: { dryRun?: boolean; commit: boolean; cwd?: string },
    ) => {
      const cwd = options.cwd ? resolve(options.cwd) : process.cwd()
      try {
        await runPluginSyncMigrations(
          name,
          { dryRun: options.dryRun ?? false, commit: options.commit, cwd },
          { migrations: new PluginMigrationsAdapter(), git: new GitAdapter() },
        )
      } catch (err) {
        log.error((err as Error).message)
        process.exit(1)
      }
    },
  )

export interface PluginSyncMigrationsDeps {
  migrations: PluginMigrationsAdapter
  git: GitAdapter
}

export interface PluginSyncMigrationsOptions {
  dryRun: boolean
  commit: boolean
  cwd: string
}

/**
 * Generates migration file(s) for plugin(s) already present at
 * `services/<name>/` but missing a real, committed migration — either
 * because `services/<name>/` was added to the repo out-of-band (not via
 * `biffo plugin install`, e.g. cloned from a template that already
 * committed a reference plugin), or as a one-time backfill after adopting
 * this command (a plugin installed before it existed only ever had its
 * migration generated ephemerally at Lambda db-init time — see
 * `main.py::_run_db_init`'s and `plugin_migrations.sync_plugin_migrations`'s
 * docstrings for that incident).
 *
 * `biffo plugin install`/`upgrade` already call the same underlying
 * `PluginMigrationsAdapter.generate` automatically — this command exists as
 * an explicit, standalone recovery/backfill path, not as something a normal
 * install/upgrade flow needs to run separately.
 */
export async function runPluginSyncMigrations(
  name: string | undefined,
  options: PluginSyncMigrationsOptions,
  deps: PluginSyncMigrationsDeps,
): Promise<void> {
  const servicesDir = join(options.cwd, 'services')
  if (!existsSync(servicesDir)) {
    throw new Error(`${servicesDir} does not exist — is ${options.cwd} a Biffo project checkout?`)
  }
  if (name && !existsSync(join(servicesDir, name, 'biffo.plugin.json'))) {
    throw new Error(`Plugin '${name}' is not installed at services/${name}/.`)
  }

  if (options.dryRun) {
    console.log(chalk.bold('\n  Dry run — no changes will be made\n'))
    console.log(`  Target: ${name ?? 'all installed plugins under services/'}\n`)
    return
  }

  const generated = await deps.migrations.generate(options.cwd, name ? [name] : undefined)
  if (generated.length === 0) {
    log.warn(
      name
        ? `${name} already has a committed migration (or declares no tables) — nothing to do.`
        : 'Every installed plugin already has a committed migration (or declares no tables) — nothing to do.',
    )
    return
  }

  const relativePaths = generated.map((p) => relative(options.cwd, p))
  for (const p of relativePaths) {
    log.success(`Generated ${p}`)
  }

  if (options.commit) {
    const isRepo = await deps.git.isGitRepo(options.cwd)
    if (!isRepo) {
      throw new Error(`${options.cwd} is not a git repository — cannot commit.`)
    }
    await deps.git.add(options.cwd, relativePaths)
    const label = name ?? `${String(generated.length)} plugin(s)`
    const commitMessage = `chore(plugins): sync migration(s) for ${label}`
    await deps.git.commit(options.cwd, commitMessage)
    log.success(`Committed: ${commitMessage}`)
  } else {
    log.warn('--no-commit: generated file(s) are on disk but not staged/committed.')
  }
}
