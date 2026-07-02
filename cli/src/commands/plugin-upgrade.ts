import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import inquirer from 'inquirer'
import { GitAdapter } from '../adapters/git/index.js'
import { RegistryAdapter, type RegistryPluginEntry } from '../adapters/registry/index.js'
import { log } from '../lib/logger.js'
import { validateManifest } from '../lib/plugin-manifest.js'
import { cloneAndValidatePlugin, parsePluginTarget } from './plugin-install.js'

export const pluginUpgradeCommand = new Command('upgrade')
  .description(
    'Upgrade an installed plugin to a new minor version: biffo plugin upgrade <name>@<new-minor>',
  )
  .argument('<target>', 'Plugin name and new minor version, e.g. rbac@1.1')
  .option('--dry-run', 'Resolve the new version and print planned changes without applying them')
  .option('--force', 'Skip the confirmation prompt')
  .option('--cwd <path>', 'Project root to upgrade in (defaults to the current directory)')
  .action(async (target: string, options: { dryRun?: boolean; force?: boolean; cwd?: string }) => {
    const cwd = options.cwd ? resolve(options.cwd) : process.cwd()
    try {
      await runPluginUpgrade(
        target,
        { dryRun: options.dryRun ?? false, force: options.force ?? false, cwd },
        { registry: new RegistryAdapter(), git: new GitAdapter() },
      )
    } catch (err) {
      log.error((err as Error).message)
      process.exit(1)
    }
  })

export interface PluginUpgradeDeps {
  registry: RegistryAdapter
  git: GitAdapter
}

export interface PluginUpgradeOptions {
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
 */
export async function runPluginUpgrade(
  target: string,
  options: PluginUpgradeOptions,
  deps: PluginUpgradeDeps,
): Promise<void> {
  const { name, minor } = parsePluginTarget(target)

  const servicesDir = join(options.cwd, 'services')
  if (!existsSync(servicesDir)) {
    throw new Error(
      `${servicesDir} does not exist — is ${options.cwd} the root of a Biffo project checkout?`,
    )
  }

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

    const label = currentVersion
      ? `${entry.name} ${currentVersion} -> ${entry.version}`
      : `${entry.name} to ${entry.version}`
    const commitMessage = `feat(plugins): upgrade ${label}`
    await deps.git.add(options.cwd, stagePaths)
    await deps.git.commit(options.cwd, commitMessage)
    log.success(`Committed: ${commitMessage}`)

    console.log(chalk.bold('\n  Plugin upgraded!\n'))
    console.log(`  ${entry.name}@${entry.version} is committed at services/${entry.name}/`)
    console.log(
      '  Push and redeploy to apply its updated tables and routes (auto-discovered at db-init):',
    )
    console.log(chalk.dim(`    git push`))
    console.log(chalk.dim(`    biffo deploy <environment> --app-only\n`))
  } finally {
    deps.git.cleanup(tmpDir)
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
