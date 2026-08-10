import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import inquirer from 'inquirer'
import { GitAdapter } from '../adapters/git/index.js'
import { PluginMigrationsAdapter } from '../adapters/plugin-migrations/index.js'
import { RegistryAdapter, type RegistryPluginEntry } from '../adapters/registry/index.js'
import { log } from '../lib/logger.js'
import { validateManifest } from '../lib/plugin-manifest.js'
import { copyPluginSource } from '../lib/plugin-source-copy.js'
import { applyWorkspaceSources } from '../lib/plugin-workspace-sources.js'
import {
  cloneAndValidatePlugin,
  parsePluginTarget,
  resolveLocalPlugin,
  type ResolvedPluginSource,
} from './plugin-install.js'

export const pluginUpgradeCommand = new Command('upgrade')
  .description(
    'Upgrade an installed plugin to a new minor version (biffo plugin upgrade <name>@<new-minor>) ' +
      'or refresh it in place from a local, unpublished checkout (biffo plugin upgrade --local <path>)',
  )
  .argument(
    '[target]',
    'Plugin name and new minor version, e.g. rbac@1.1 (omit when using --local)',
  )
  .option(
    '--local <path>',
    'Refresh the installed plugin from a local, unpublished checkout instead of the registry',
  )
  .option('--dry-run', 'Resolve the new version and print planned changes without applying them')
  .option('--force', 'Skip the confirmation prompt')
  .option('--cwd <path>', 'Project root to upgrade in (defaults to the current directory)')
  .action(
    async (
      target: string | undefined,
      options: { local?: string; dryRun?: boolean; force?: boolean; cwd?: string },
    ) => {
      const cwd = options.cwd ? resolve(options.cwd) : process.cwd()
      try {
        await runPluginUpgrade(
          target,
          {
            ...(options.local ? { local: resolve(options.local) } : {}),
            dryRun: options.dryRun ?? false,
            force: options.force ?? false,
            cwd,
          },
          {
            registry: new RegistryAdapter(),
            git: new GitAdapter(),
            migrations: new PluginMigrationsAdapter(),
          },
        )
      } catch (err) {
        log.error((err as Error).message)
        process.exit(1)
      }
    },
  )

export interface PluginUpgradeDeps {
  registry: RegistryAdapter
  git: GitAdapter
  migrations: PluginMigrationsAdapter
}

export interface PluginUpgradeOptions {
  /** Absolute path to a local plugin checkout; mutually exclusive with `target`. */
  local?: string
  dryRun: boolean
  force: boolean
  cwd: string
}

/**
 * Upgrades an installed plugin to a new minor version.
 *
 * Reuses install's clone-and-validate flow (`cloneAndValidatePlugin` in
 * plugin-install.ts) since resolving a registry entry and validating its
 * manifest is identical work — upgrade only differs in what happens next:
 * it replaces an existing services/<name>/ instead of requiring it be
 * absent.
 *
 * Known limitation — `required_core_version` compatibility: the plugin
 * manifest and registry entry both carry a `required_core_version` field
 * (an npm-style semver range), but there is nothing on the CLI side to
 * compare it against. `services/api/pyproject.toml` pins `version =
 * "0.0.0"` — a static placeholder, not a real release marker that
 * increments — and the Core API exposes no `/version` endpoint the CLI
 * could call to learn what's actually deployed (confirmed: no route named
 * "version" anywhere under services/api/src/api/). The Portal UI
 * (apps/portal/src/lib/plugin-registry.ts) treats the same field as
 * purely informational for the same reason. So this command prints
 * `required_core_version` for the human to judge and does not attempt a
 * compatibility check it cannot honestly perform.
 *
 * Known limitation — version history: the registry stores one entry per
 * plugin (its current release), not a full history (see
 * adapters/registry/index.ts). "Upgrading to a new minor" only works if
 * the registry's current entry happens to match the requested minor —
 * there's no way to resolve an older-than-current or arbitrary minor.
 *
 * `--local <path>` is a second, independent way to reach this same replace
 * flow: refresh an *already-installed* plugin from an unpublished local
 * checkout, rather than from a registry minor. It exists because the two
 * existing commands lock each other out for anyone iterating on a plugin's
 * own source — `plugin install --local` refuses once `services/<name>/`
 * exists, and `plugin upgrade <name>@<minor>` has nothing to resolve until
 * the plugin's publish workflow has run at least once. `upgrade` is where
 * this belongs rather than `install`: the whole point of `upgrade` is
 * "replace an installed plugin in place", which is exactly what a refresh
 * is, so it only needed a second way to *resolve* the replacement (local
 * disk vs. registry) — the shared bulk of this function (replace
 * services/<name>/, re-wire modules/plugins/<name>/, regenerate the
 * migration if needed, commit) needed no new logic. Layering it onto
 * `install --force` would instead have blurred install's contract ("must
 * not already exist") with upgrade's ("must already exist").
 */
export async function runPluginUpgrade(
  target: string | undefined,
  options: PluginUpgradeOptions,
  deps: PluginUpgradeDeps,
): Promise<void> {
  if (options.local && target) {
    throw new Error(
      `Pass either a registry target (<name>@<new-minor>) or --local <path>, not both. ` +
        `--local refreshes an installed plugin from an unpublished checkout on disk and has ` +
        `no registry entry to resolve.`,
    )
  }
  if (!options.local && !target) {
    throw new Error(
      `Nothing to upgrade. Pass a registry target (e.g. \`biffo plugin upgrade acme-crm@1.1\`) ` +
        `or a local checkout to refresh from (\`biffo plugin upgrade --local ../acme-crm\`).`,
    )
  }

  const servicesDir = join(options.cwd, 'services')
  if (!existsSync(servicesDir)) {
    throw new Error(
      `${servicesDir} does not exist — is ${options.cwd} the root of a Biffo project checkout?`,
    )
  }

  if (options.local) {
    return runLocalPluginRefresh(options.local, options, deps)
  }

  const { name, minor } = parsePluginTarget(target!)

  const targetDir = join(servicesDir, name)
  if (!existsSync(targetDir)) {
    throw new Error(
      `Plugin '${name}' is not installed at services/${name}/. ` +
        `Use 'biffo plugin install ${name}@${minor}' instead.`,
    )
  }

  const currentVersion = readInstalledVersion(targetDir)

  log.info(`Resolving ${name}@${minor} from the plugin registry...`)
  const entry = await deps.registry.resolvePlugin(name, minor)
  log.success(`Resolved ${entry.name}@${entry.version} — ${entry.repo}`)

  if (entry.required_core_version) {
    log.warn(
      `Plugin declares required_core_version '${entry.required_core_version}'. The CLI cannot ` +
        'verify this against your deployment — the Core API exposes no version endpoint and ' +
        "services/api/pyproject.toml's version is a static placeholder, not a real release " +
        'marker. Confirm compatibility yourself before deploying.',
    )
  }

  const modulesDir = join(options.cwd, 'modules', 'plugins', entry.name)

  if (options.dryRun) {
    printDryRun(entry, currentVersion)
    return
  }

  if (currentVersion === entry.version) {
    log.warn(`services/${name}/ is already at ${entry.version} — nothing to upgrade.`)
    return
  }

  if (!options.force) {
    const proceed = await confirmUpgrade(name, currentVersion, entry.version)
    if (!proceed) {
      log.warn('Upgrade cancelled')
      return
    }
  }

  const isRepo = await deps.git.isGitRepo(options.cwd)
  if (!isRepo) {
    throw new Error(
      `${options.cwd} is not a git repository — biffo plugin upgrade must be run from a Biffo project checkout.`,
    )
  }

  log.info(`Cloning ${entry.repo}...`)
  const { tmpDir, manifest } = await cloneAndValidatePlugin(entry, deps.git)

  try {
    log.success(
      `Manifest valid — ${manifest.tables.length} table(s), ${manifest.api_routes.length} route(s)`,
    )

    rmSync(targetDir, { recursive: true, force: true })
    mkdirSync(targetDir, { recursive: true })
    cpSync(tmpDir, targetDir, { recursive: true })
    log.success(`Upgraded plugin source at services/${entry.name}/`)
    applyWorkspaceSources(targetDir, options.cwd, `services/${entry.name}`)

    const stagePaths = [`services/${entry.name}`]

    // Full replace of any previously-copied Terraform module: re-copy if the
    // new version ships one, remove if it no longer does, rather than
    // leaving a stale mix of old and new files.
    if (existsSync(modulesDir)) {
      rmSync(modulesDir, { recursive: true, force: true })
    }
    const tfSourceDir = join(targetDir, 'terraform')
    if (existsSync(tfSourceDir)) {
      mkdirSync(modulesDir, { recursive: true })
      cpSync(tfSourceDir, modulesDir, { recursive: true })
      stagePaths.push(`modules/plugins/${entry.name}`)
      log.success(`Copied Terraform module to modules/plugins/${entry.name}/`)
    }

    if (manifest.tables.length > 0) {
      // A new minor version's manifest may declare new tables (or the same
      // ones) — generate_migration_for_plugin only ever produces additive
      // CREATE TABLE migrations, so this either appends a new, separately
      // chained migration for genuinely new tables, or is a no-op if the
      // table set is unchanged from what was already committed. It never
      // rewrites/replaces a previous migration.
      log.info(
        `Generating migration for services/${entry.name}/'s ${manifest.tables.length} table(s)...`,
      )
      const generatedPaths = await deps.migrations.generate(options.cwd, [entry.name])
      for (const absPath of generatedPaths) {
        stagePaths.push(relative(options.cwd, absPath))
      }
      if (generatedPaths.length > 0) {
        log.success(`Generated migration: ${relative(options.cwd, generatedPaths[0]!)}`)
      }
    }

    const label = currentVersion
      ? `${entry.name} ${currentVersion} -> ${entry.version}`
      : `${entry.name} to ${entry.version}`
    const commitMessage = `feat(plugins): upgrade ${label}`
    await deps.git.add(options.cwd, stagePaths)
    await deps.git.commit(options.cwd, commitMessage)
    log.success(`Committed: ${commitMessage}`)

    console.log(chalk.bold('\n  Plugin upgraded!\n'))
    console.log(`  ${entry.name}@${entry.version} is committed at services/${entry.name}/`)
    console.log('  Push and redeploy to apply its updated tables and routes:')
    console.log(chalk.dim(`    git push`))
    console.log(chalk.dim(`    biffo deploy <environment> --app-only\n`))
  } finally {
    deps.git.cleanup(tmpDir)
  }
}

/**
 * Refreshes an already-installed plugin from an unpublished local checkout —
 * the `--local` counterpart of the registry replace flow above. Shares its
 * shape deliberately: replace services/<name>/, re-wire
 * modules/plugins/<name>/, regenerate the migration if the table set
 * changed, commit. It differs from the registry path in four ways specific
 * to refreshing from disk rather than a fresh clone:
 *
 * 1. Resolution is `resolveLocalPlugin` (shared with `plugin install
 *    --local`), not a registry lookup — so there is no
 *    `required_core_version` to print and no "already at this version"
 *    short-circuit. A local checkout is very often refreshed with its
 *    manifest `version` unchanged (a route or code-only edit mid-iteration,
 *    per the manifest's own docstring on what's actually validated) — unlike
 *    a registry upgrade, that is the *expected* case here, not a no-op.
 * 2. The copy respects the source checkout's `.gitignore` (`copyPluginSource`,
 *    shared with `plugin install --local` — see cli/src/lib/plugin-source-copy.ts
 *    for why `git ls-files` over a denylist) because the source is a real
 *    working checkout — likely carrying its own `.git/`, `.venv/`,
 *    `node_modules/`, and potentially git worktrees of its own (#1477) —
 *    rather than a temp clone `GitAdapter.cloneToTemp` has already stripped
 *    `.git` from.
 * 3. It re-applies `ensureWorkspaceSources` after the copy. This is the
 *    install-time adaptation a naive overwrite silently deletes: `plugin
 *    install` appends `[tool.uv.sources]` so the vendored copy resolves
 *    `biffo-plugin-sdk` from the instance's workspace instead of PyPI, and a
 *    fresh copy of the plugin's own `pyproject.toml` never has that section
 *    — without it, the migration-generation step below is the first `uv run`
 *    to hit "`biffo-plugin-sdk` is included as a workspace member, but is
 *    missing an entry in `tool.uv.sources`" and refresh fails outright.
 *    `ensureWorkspaceSources` is idempotent and reads whatever
 *    `pyproject.toml` is on disk *after* the copy, so re-running it against
 *    the fresh copy re-adds exactly the section the copy just wiped — no
 *    separate "merge the old file's adaptation into the new one" logic is
 *    needed.
 * 4. It guards the case where `--local <path>` resolves to services/<name>/
 *    itself (`plugin install --local` calls this `inTreeSource`). Without
 *    the guard, `rmSync(targetDir)` deletes the plugin and then
 *    `cpSync(source.sourceDir, targetDir)` copies the now-empty directory
 *    onto itself — a silent, committed data-loss bug, not an error, because
 *    nothing in the copy or the subsequent `git add`/`git commit` notices
 *    the source no longer has anything in it.
 */
async function runLocalPluginRefresh(
  localPath: string,
  options: PluginUpgradeOptions,
  deps: PluginUpgradeDeps,
): Promise<void> {
  const source = resolveLocalPlugin(localPath)
  log.success(`Resolved ${source.name}@${source.version} from ${source.origin}`)

  const servicesDir = join(options.cwd, 'services')
  const targetDir = join(servicesDir, source.name)
  if (!existsSync(targetDir)) {
    throw new Error(
      `Plugin '${source.name}' is not installed at services/${source.name}/. ` +
        `Use 'biffo plugin install --local ${localPath}' instead.`,
    )
  }

  // See point 4 above — the local path IS the installed copy, so there is
  // nothing to copy from; only Terraform/migration re-sync applies.
  const inTreeSource = resolve(source.sourceDir) === resolve(targetDir)

  const currentVersion = readInstalledVersion(targetDir)
  const modulesDir = join(options.cwd, 'modules', 'plugins', source.name)

  if (options.dryRun) {
    printLocalDryRun(source, currentVersion, inTreeSource)
    return
  }

  if (!options.force) {
    const proceed = await confirmRefresh(source.name, source.origin)
    if (!proceed) {
      log.warn('Refresh cancelled')
      return
    }
  }

  const isRepo = await deps.git.isGitRepo(options.cwd)
  if (!isRepo) {
    throw new Error(
      `${options.cwd} is not a git repository — biffo plugin upgrade must be run from a Biffo project checkout.`,
    )
  }

  const { manifest } = source
  try {
    log.success(
      `Manifest valid — ${manifest.tables.length} table(s), ${manifest.api_routes.length} route(s)`,
    )

    if (inTreeSource) {
      log.info(
        `services/${source.name}/ is already the local checkout — nothing to copy; ` +
          're-syncing its Terraform module and checking for a migration.',
      )
    } else {
      rmSync(targetDir, { recursive: true, force: true })
      mkdirSync(targetDir, { recursive: true })
      await copyPluginSource(source.sourceDir, targetDir)
      log.success(`Refreshed plugin source at services/${source.name}/ from ${source.origin}`)
    }
    applyWorkspaceSources(targetDir, options.cwd, `services/${source.name}`)

    const stagePaths = [`services/${source.name}`]

    // Full replace of any previously-copied Terraform module, same as the
    // registry path: re-copy if the checkout ships one, remove if it no
    // longer does.
    if (existsSync(modulesDir)) {
      rmSync(modulesDir, { recursive: true, force: true })
    }
    const tfSourceDir = join(targetDir, 'terraform')
    if (existsSync(tfSourceDir)) {
      mkdirSync(modulesDir, { recursive: true })
      cpSync(tfSourceDir, modulesDir, { recursive: true })
      stagePaths.push(`modules/plugins/${source.name}`)
      log.success(`Refreshed Terraform module at modules/plugins/${source.name}/`)
    }

    if (manifest.tables.length > 0) {
      // Same idempotency guarantee the registry path relies on:
      // generate_migration_for_plugin derives its revision id from the
      // manifest name plus table *names* (services/api/src/api/migrations/
      // plugin_migrations.py::_compute_plugin_revision) and skips generating
      // when a migration for that revision already exists. So a route-only or
      // column-only edit — the table set unchanged — calls this and gets back
      // an empty list; only an actual table-set change produces a new file.
      log.info(
        `Checking for a migration for services/${source.name}/'s ${manifest.tables.length} table(s)...`,
      )
      const generatedPaths = await deps.migrations.generate(options.cwd, [source.name])
      for (const absPath of generatedPaths) {
        stagePaths.push(relative(options.cwd, absPath))
      }
      if (generatedPaths.length > 0) {
        log.success(`Generated migration: ${relative(options.cwd, generatedPaths[0]!)}`)
      } else {
        log.info(`${source.name}'s table set is unchanged — no migration needed.`)
      }
    } else {
      log.info(`${source.name} declares no tables — nothing to migrate.`)
    }

    await deps.git.add(options.cwd, stagePaths)

    // A --local refresh legitimately has nothing to commit — an in-place
    // refresh (inTreeSource, above), or an out-of-tree checkout
    // byte-identical to what's already installed, which is the *expected*
    // case mid-iteration per point 1 in this function's docstring (the
    // manifest version is often left unchanged). `git commit` exits non-zero
    // for "nothing to commit", which would otherwise surface as a raw git
    // failure for what is not an error — the registry path is protected from
    // this by its `currentVersion === entry.version` short-circuit, which
    // this path deliberately does not have.
    if (!(await deps.git.hasUncommittedChanges(options.cwd))) {
      log.warn(`services/${source.name}/ already matches ${source.origin} — nothing to commit.`)
      return
    }

    const commitMessage = `chore(plugins): refresh ${source.name} from local checkout`
    await deps.git.commit(options.cwd, commitMessage)
    log.success(`Committed: ${commitMessage}`)

    console.log(chalk.bold('\n  Plugin refreshed!\n'))
    console.log(`  services/${source.name}/ now matches ${source.origin}`)
    console.log('  Push and redeploy to apply any updated tables and routes:')
    console.log(chalk.dim(`    git push`))
    console.log(chalk.dim(`    biffo deploy <environment> --app-only\n`))
  } finally {
    source.cleanup()
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

async function confirmUpgrade(
  name: string,
  currentVersion: string | undefined,
  newVersion: string,
): Promise<boolean> {
  const message = currentVersion
    ? `Upgrade ${chalk.bold(name)} from ${currentVersion} to ${chalk.bold(newVersion)}?`
    : `Upgrade ${chalk.bold(name)} to ${chalk.bold(newVersion)}?`
  const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
    { type: 'confirm', name: 'confirmed', message, default: false },
  ])
  return confirmed
}

async function confirmRefresh(name: string, origin: string): Promise<boolean> {
  const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
    {
      type: 'confirm',
      name: 'confirmed',
      message: `Refresh ${chalk.bold(name)} from ${origin}, replacing services/${name}/?`,
      default: false,
    },
  ])
  return confirmed
}

function printDryRun(entry: RegistryPluginEntry, currentVersion: string | undefined): void {
  console.log(chalk.bold('\n  Dry run — no changes will be made\n'))
  console.log(`  Plugin:        ${entry.name}`)
  console.log(`  Current:       ${currentVersion ?? '(unknown — manifest unreadable)'}`)
  console.log(`  Would upgrade to: ${entry.version}`)
  console.log(`  Source repo:   ${entry.repo}`)
  console.log(`  Would replace: services/${entry.name}/`)
  if (entry.infra_modules && entry.infra_modules.length > 0) {
    console.log(
      `  Would replace Terraform module at: modules/plugins/${entry.name}/ (if the repo has one)`,
    )
  }
  console.log(`  Would commit:  feat(plugins): upgrade ${entry.name} to ${entry.version}\n`)
}

function printLocalDryRun(
  source: ResolvedPluginSource,
  currentVersion: string | undefined,
  inTreeSource: boolean,
): void {
  console.log(chalk.bold('\n  Dry run — no changes will be made\n'))
  console.log(`  Plugin:        ${source.name}`)
  console.log(`  Installed:     ${currentVersion ?? '(unknown — manifest unreadable)'}`)
  console.log(`  Local source:  ${source.origin} (manifest version ${source.version})`)
  console.log(
    inTreeSource
      ? `  Already in tree at services/${source.name}/ — nothing to copy, only Terraform/migration re-sync`
      : `  Would replace: services/${source.name}/`,
  )
  console.log(
    `  Would replace Terraform module at: modules/plugins/${source.name}/ (if the checkout has one)`,
  )
  if (source.manifest.tables.length > 0) {
    console.log(
      `  Would check for a migration for ${source.manifest.tables.length} table(s) ` +
        '(only generated if the table set changed)',
    )
  }
  console.log(`  Would commit:  chore(plugins): refresh ${source.name} from local checkout\n`)
}
