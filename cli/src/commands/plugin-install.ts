import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import { GitAdapter } from '../adapters/git/index.js'
import { RegistryAdapter, type RegistryPluginEntry } from '../adapters/registry/index.js'
import { log } from '../lib/logger.js'
import { validateManifest, type PluginManifest } from '../lib/plugin-manifest.js'

const TARGET_PATTERN = /^([a-z][a-z0-9-]*)@(\d+\.\d+)$/

export const pluginInstallCommand = new Command('install')
  .description(
    'Install a plugin from the Biffo plugin registry: biffo plugin install <name>@<minor>',
  )
  .argument('<target>', 'Plugin name and minor version, e.g. rbac@1.0')
  .option('--dry-run', 'Resolve the plugin and print planned changes without modifying the repo')
  .option('--cwd <path>', 'Project root to install into (defaults to the current directory)')
  .action(async (target: string, options: { dryRun?: boolean; cwd?: string }) => {
    const cwd = options.cwd ? resolve(options.cwd) : process.cwd()
    try {
      await runPluginInstall(
        target,
        { dryRun: options.dryRun ?? false, cwd },
        { registry: new RegistryAdapter(), git: new GitAdapter() },
      )
    } catch (err) {
      log.error((err as Error).message)
      process.exit(1)
    }
  })

export interface PluginInstallDeps {
  registry: RegistryAdapter
  git: GitAdapter
}

export interface PluginInstallOptions {
  dryRun: boolean
  cwd: string
}

/**
 * Parses `<name>@<minor>` targets, e.g. "rbac@1.0". Shared by install and
 * upgrade — both take the same target shape.
 */
export function parsePluginTarget(target: string): { name: string; minor: string } {
  const match = TARGET_PATTERN.exec(target)
  if (!match) {
    throw new Error(`Invalid target '${target}'. Expected format: <name>@<minor>, e.g. rbac@1.0`)
  }
  return { name: match[1]!, minor: match[2]! }
}

export interface ClonedPlugin {
  tmpDir: string
  manifest: PluginManifest
}

/**
 * Clones a resolved registry entry's repo into a temp dir and validates its
 * biffo.plugin.json manifest, WITHOUT touching the target project checkout.
 * Shared by install and upgrade, which differ only in what they do with the
 * validated result (place into a fresh services/<name>/ vs. replace an
 * existing one).
 *
 * On any failure the temp clone is cleaned up before the error propagates.
 * On success, cleanup is the caller's responsibility (it still needs the
 * clone on disk to copy from) — call `git.cleanup(tmpDir)` once done.
 */
export async function cloneAndValidatePlugin(
  entry: RegistryPluginEntry,
  git: GitAdapter,
): Promise<ClonedPlugin> {
  const tmpDir = await git.cloneToTemp(entry.repo, `biffo-plugin-${entry.name}`)
  try {
    const manifestPath = join(tmpDir, 'biffo.plugin.json')
    if (!existsSync(manifestPath)) {
      throw new Error(
        `Plugin repo ${entry.repo} does not contain a biffo.plugin.json manifest at its root.`,
      )
    }

    const manifest = validateManifest(parseManifestFile(manifestPath))
    if (manifest.name !== entry.name) {
      throw new Error(
        `Manifest name '${manifest.name}' in ${entry.repo} does not match the registry entry '${entry.name}'.`,
      )
    }

    return { tmpDir, manifest }
  } catch (err) {
    git.cleanup(tmpDir)
    throw err
  }
}

/**
 * Installs a plugin into the current Biffo project checkout.
 *
 * Ground-truth flow (see PR description for the full investigation):
 * there is no "auto-registration endpoint" to call — the Core API
 * discovers `services/*\/biffo.plugin.json` on its own at db-init time
 * (`api.plugins.discover_plugin_manifests`, wired into
 * `main.py::_run_db_init` via `sync_plugin_migrations` and into
 * `build_plugin_router()`). So "installing" a plugin from the CLI's
 * perspective is: resolve it in the registry, clone its source into
 * `services/<name>/`, copy its Terraform module (if any) into
 * `modules/plugins/<name>/`, and commit — the next deploy's db-init does
 * the rest. Deliberately does not `git push` (no existing biffo command
 * does that on the user's behalf either; see deploy.ts/init.ts, which
 * push infrastructure change *requests* to GitHub Actions but never call
 * `git push` themselves).
 */
export async function runPluginInstall(
  target: string,
  options: PluginInstallOptions,
  deps: PluginInstallDeps,
): Promise<void> {
  const { name, minor } = parsePluginTarget(target)

  log.info(`Resolving ${name}@${minor} from the plugin registry...`)
  const entry = await deps.registry.resolvePlugin(name, minor)
  log.success(`Resolved ${entry.name}@${entry.version} — ${entry.repo}`)

  const servicesDir = join(options.cwd, 'services')
  const targetDir = join(servicesDir, entry.name)
  const modulesDir = join(options.cwd, 'modules', 'plugins', entry.name)

  if (!existsSync(servicesDir)) {
    throw new Error(
      `${servicesDir} does not exist — is ${options.cwd} the root of a Biffo project checkout?`,
    )
  }

  if (existsSync(targetDir)) {
    throw new Error(
      `Plugin '${entry.name}' is already installed at services/${entry.name}/. ` +
        `Remove it first, or wait for a future 'biffo plugin upgrade' command.`,
    )
  }

  if (options.dryRun) {
    printDryRun(entry)
    return
  }

  const isRepo = await deps.git.isGitRepo(options.cwd)
  if (!isRepo) {
    throw new Error(
      `${options.cwd} is not a git repository — biffo plugin install must be run from a Biffo project checkout.`,
    )
  }

  log.info(`Cloning ${entry.repo}...`)
  const { tmpDir, manifest } = await cloneAndValidatePlugin(entry, deps.git)

  try {
    log.success(
      `Manifest valid — ${manifest.tables.length} table(s), ${manifest.api_routes.length} route(s)`,
    )

    // Only now — after the manifest has validated — do we touch the target repo.
    mkdirSync(targetDir, { recursive: true })
    cpSync(tmpDir, targetDir, { recursive: true })
    log.success(`Installed plugin source at services/${entry.name}/`)

    const stagePaths = [`services/${entry.name}`]

    const tfSourceDir = join(targetDir, 'terraform')
    if (existsSync(tfSourceDir)) {
      mkdirSync(modulesDir, { recursive: true })
      cpSync(tfSourceDir, modulesDir, { recursive: true })
      stagePaths.push(`modules/plugins/${entry.name}`)
      log.success(`Copied Terraform module to modules/plugins/${entry.name}/`)
      log.warn(
        'Terraform module copied but NOT wired into infra/environments/*/main.tf — ' +
          'conditional plugin module inclusion is tracked by issue #25. ' +
          'Add the module block manually once that lands.',
      )
    }

    const commitMessage = `feat(plugins): install ${entry.name}@${entry.version}`
    await deps.git.add(options.cwd, stagePaths)
    await deps.git.commit(options.cwd, commitMessage)
    log.success(`Committed: ${commitMessage}`)

    console.log(chalk.bold('\n  Plugin installed!\n'))
    console.log(`  ${entry.name}@${entry.version} is committed at services/${entry.name}/`)
    console.log(
      '  Push and redeploy to register its tables and routes (auto-discovered at db-init):',
    )
    console.log(chalk.dim(`    git push`))
    console.log(chalk.dim(`    biffo deploy <environment> --app-only\n`))
  } finally {
    deps.git.cleanup(tmpDir)
  }
}

function parseManifestFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`Could not parse ${path} as JSON: ${(err as Error).message}`)
  }
}

function printDryRun(entry: RegistryPluginEntry): void {
  console.log(chalk.bold('\n  Dry run — no changes will be made\n'))
  console.log(`  Plugin:        ${entry.name}@${entry.version}`)
  console.log(`  Source repo:   ${entry.repo}`)
  console.log(`  Would clone into:   services/${entry.name}/`)
  if (entry.infra_modules && entry.infra_modules.length > 0) {
    console.log(
      `  Would copy Terraform module into: modules/plugins/${entry.name}/ (if the repo has one)`,
    )
  }
  console.log(`  Would commit:  feat(plugins): install ${entry.name}@${entry.version}\n`)
}
