import { cpSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import { GitAdapter } from '../adapters/git/index.js'
import { PluginMigrationsAdapter } from '../adapters/plugin-migrations/index.js'
import { RegistryAdapter, type RegistryPluginEntry } from '../adapters/registry/index.js'
import { log } from '../lib/logger.js'
import { pluginDir } from '../lib/plugin-locations.js'
import { validateManifest, type PluginManifest } from '../lib/plugin-manifest.js'
import { copyPluginSource } from '../lib/plugin-source-copy.js'
import { syncPluginTerraform } from '../lib/plugin-terraform-wiring.js'
import { applyWorkspaceSources } from '../lib/plugin-workspace-sources.js'

const TARGET_PATTERN = /^([a-z][a-z0-9-]*)@(\d+\.\d+)$/

export const pluginInstallCommand = new Command('install')
  .description(
    'Install a plugin from the Biffo plugin registry (biffo plugin install <name>@<minor>) ' +
      'or from a local directory (biffo plugin install --local <path>)',
  )
  .argument('[target]', 'Plugin name and minor version, e.g. rbac@1.0 (omit when using --local)')
  .option(
    '--local <path>',
    'Install from a local, unpublished plugin directory instead of the registry',
  )
  .option('--dry-run', 'Resolve the plugin and print planned changes without modifying the repo')
  .option('--cwd <path>', 'Project root to install into (defaults to the current directory)')
  .action(
    async (
      target: string | undefined,
      options: { local?: string; dryRun?: boolean; cwd?: string },
    ) => {
      const cwd = options.cwd ? resolve(options.cwd) : process.cwd()
      try {
        await runPluginInstall(
          target,
          {
            ...(options.local ? { local: resolve(options.local) } : {}),
            dryRun: options.dryRun ?? false,
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

export interface PluginInstallDeps {
  registry: RegistryAdapter
  git: GitAdapter
  migrations: PluginMigrationsAdapter
}

export interface PluginInstallOptions {
  /** Absolute path to a local plugin directory; mutually exclusive with `target`. */
  local?: string
  dryRun: boolean
  cwd: string
}

/**
 * A plugin resolved and validated, ready to be copied into the checkout —
 * whatever it was resolved *from*. The two sources (registry clone, local
 * directory) differ only in how this is produced; everything after it is
 * identical, which is the point: `--local` must not become a second, weaker
 * install path that skips validation or the migration.
 */
export interface ResolvedPluginSource {
  name: string
  version: string
  manifest: PluginManifest
  /** Directory holding the plugin's files, ready to copy from. */
  sourceDir: string
  /** Human-readable provenance, for logs and the commit message. */
  origin: string
  /** Release any temp resources. No-op for a local source. */
  cleanup: () => void
}

/**
 * Resolve a local, unpublished plugin directory into the same shape a registry
 * clone produces.
 *
 * There is no registry entry to cross-check the manifest against here, so the
 * manifest is the sole authority for the plugin's name and version — and it is
 * validated with exactly the same `validateManifest` the registry path uses. A
 * local install trades away the *registry* check (name matches the catalogue
 * entry), not the *manifest* check.
 */
export function resolveLocalPlugin(localPath: string): ResolvedPluginSource {
  if (!existsSync(localPath)) {
    throw new Error(`--local path does not exist: ${localPath}`)
  }
  if (!statSync(localPath).isDirectory()) {
    throw new Error(`--local path is not a directory: ${localPath}`)
  }

  const manifestPath = join(localPath, 'biffo.plugin.json')
  if (!existsSync(manifestPath)) {
    throw new Error(
      `${localPath} does not contain a biffo.plugin.json manifest at its root — ` +
        `is it a plugin directory? (Scaffold one with \`biffo plugin create <name>\`.)`,
    )
  }

  const manifest = validateManifest(parseManifestFile(manifestPath))
  return {
    name: manifest.name,
    version: manifest.version,
    manifest,
    sourceDir: localPath,
    origin: localPath,
    cleanup: () => {},
  }
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
 * `build_plugin_router()`). So "installing" a plugin from the CLI's
 * perspective is: resolve it in the registry, clone its source into
 * `services/<name>/`, copy its Terraform module (if any) into
 * `modules/plugins/<name>/`, generate a real Alembic migration for its
 * declared tables (`deps.migrations.generate`, a `uv run python` call into
 * `services/api/scripts/generate_plugin_migrations.py` — see that
 * adapter's docstring for why this is a subprocess rather than a
 * TypeScript port), and commit all of it together — the next deploy's
 * db-init applies the already-committed migration (it no longer generates
 * anything itself; see `main.py::_run_db_init`). Deliberately does not
 * `git push` (no existing biffo command does that on the user's behalf
 * either; see deploy.ts/init.ts, which push infrastructure change
 * *requests* to GitHub Actions but never call `git push` themselves).
 */
export async function runPluginInstall(
  target: string | undefined,
  options: PluginInstallOptions,
  deps: PluginInstallDeps,
): Promise<void> {
  if (options.local && target) {
    throw new Error(
      `Pass either a registry target (<name>@<minor>) or --local <path>, not both. ` +
        `--local installs an unpublished plugin from disk and has no registry entry to resolve.`,
    )
  }
  if (!options.local && !target) {
    throw new Error(
      `Nothing to install. Pass a registry target (e.g. \`biffo plugin install acme-crm@1.0\`) ` +
        `or a local plugin directory (\`biffo plugin install --local services/acme-crm\`).`,
    )
  }

  const servicesDir = join(options.cwd, 'services')
  if (!existsSync(servicesDir)) {
    throw new Error(
      `${servicesDir} does not exist — is ${options.cwd} the root of a Biffo project checkout?`,
    )
  }

  // --- Resolve the source, without touching the target checkout -------------
  // Both branches must produce a *validated* manifest before anything is
  // written, so a local install is never a weaker install.
  let source: ResolvedPluginSource
  let entry: RegistryPluginEntry | null = null

  if (options.local) {
    source = resolveLocalPlugin(options.local)
    log.success(`Resolved ${source.name}@${source.version} from ${source.origin}`)
  } else {
    const { name, minor } = parsePluginTarget(target!)
    log.info(`Resolving ${name}@${minor} from the plugin registry...`)
    entry = await deps.registry.resolvePlugin(name, minor)
    log.success(`Resolved ${entry.name}@${entry.version} — ${entry.repo}`)
  }

  // A plugin installed by the CLI always lands in the *user-owned*
  // services/<name>/ channel — never in the template-owned
  // services/_plugins/ carve-out (#243). Installing into _plugins/ would hand
  // the user's plugin to `biffo core upgrade`, which three-way-merges every
  // template-owned path against a template that has never heard of it.
  // First-party plugins get there by being authored in biffo-template, not by
  // being installed.
  const pluginName = entry ? entry.name : source!.name
  const relTargetDir = pluginDir(pluginName, 'third-party')
  const targetDir = join(options.cwd, relTargetDir)
  const modulesDir = join(options.cwd, 'modules', 'plugins', pluginName)

  // `--local` pointed at a directory that is already in this checkout (the
  // common case after `biffo plugin create`, and the only sane reading of
  // "install the plugin I already have in-tree"). There is nothing to copy —
  // the source *is* the installed location — so the copy step is skipped and
  // install means "wire up its terraform and migration". This is also what
  // makes an in-tree install re-runnable: it does not trip the
  // already-installed guard against itself.
  const inTreeSource = options.local !== undefined && resolve(options.local) === resolve(targetDir)

  if (existsSync(targetDir) && !inTreeSource) {
    throw new Error(
      `Plugin '${pluginName}' is already installed at ${relTargetDir}/. ` +
        `Remove it first, or wait for a future 'biffo plugin upgrade' command.`,
    )
  }

  if (options.dryRun) {
    printDryRun(entry, source!, relTargetDir, inTreeSource)
    return
  }

  const isRepo = await deps.git.isGitRepo(options.cwd)
  if (!isRepo) {
    throw new Error(
      `${options.cwd} is not a git repository — biffo plugin install must be run from a Biffo project checkout.`,
    )
  }

  if (entry) {
    log.info(`Cloning ${entry.repo}...`)
    const cloned = await cloneAndValidatePlugin(entry, deps.git)
    source = {
      name: entry.name,
      version: entry.version,
      manifest: cloned.manifest,
      sourceDir: cloned.tmpDir,
      origin: entry.repo,
      cleanup: () => deps.git.cleanup(cloned.tmpDir),
    }
  }

  const { manifest } = source!

  try {
    log.success(
      `Manifest valid — ${manifest.tables.length} table(s), ${manifest.api_routes.length} route(s)`,
    )

    // Only now — after the manifest has validated — do we touch the target repo.
    if (inTreeSource) {
      log.info(`${relTargetDir}/ is already in this checkout — installing in place.`)
    } else {
      mkdirSync(targetDir, { recursive: true })
      await copyPluginSource(source!.sourceDir, targetDir)
      log.success(`Installed plugin source at ${relTargetDir}/`)
    }

    // Wire the vendored plugin's deps to the instance's uv workspace. If the
    // instance provides one of them as a member (e.g. biffo-plugin-sdk), uv
    // refuses to resolve the plugin — and the migration step below is the first
    // `uv run` to hit it — unless its pyproject sources that dep from the
    // workspace. The standalone repo resolves it from PyPI; only the vendored
    // copy needs this. (#biffo-plugin-install user-facing series.)
    applyWorkspaceSources(targetDir, options.cwd, relTargetDir)

    const stagePaths = [relTargetDir]

    const tfSourceDir = join(targetDir, 'terraform')
    if (existsSync(tfSourceDir)) {
      mkdirSync(modulesDir, { recursive: true })
      cpSync(tfSourceDir, modulesDir, { recursive: true })
      stagePaths.push(`modules/plugins/${pluginName}`)
      log.success(`Copied Terraform module to modules/plugins/${pluginName}/`)

      // Wire it into every environment root config (#201). Regenerated in full
      // from modules/plugins/, so re-running install can't duplicate a module
      // block or an enabled_plugins entry.
      const wiring = syncPluginTerraform(options.cwd)
      stagePaths.push(...wiring.changedPaths)
      if (wiring.environments.length > 0) {
        log.success(
          `Wired module "plugin_${pluginName}" and enabled_plugins into ` +
            `${wiring.environments.length} environment(s): ${wiring.environments.join(', ')}`,
        )
        log.info(
          'The Core API allowlist (ADR-0009) follows automatically — ' +
            'module.plugin_allowlist in main.tf derives it from enabled_plugins.',
        )
      } else {
        log.warn(
          'No wirable infra/environments/*/ root config found, so the Terraform module was ' +
            'copied but not wired into any environment.',
        )
      }
      if (wiring.skippedEnvironments.length > 0) {
        // infra/ is user-owned, so an instance can upgrade the CLI without its
        // environments gaining the enabled_plugins variable the generated block
        // needs. Say so loudly rather than emit Terraform that won't validate.
        log.warn(
          `Skipped ${wiring.skippedEnvironments.join(', ')} — no \`enabled_plugins\` variable ` +
            'declared there. infra/ is user-owned, so `biffo core upgrade` cannot add it: copy ' +
            'the variable (and the module "plugin_allowlist" block) from the template’s ' +
            'infra/environments/dev/ and re-run this install to wire those environments.',
        )
      }
    } else if (manifest.event_subscriptions.length > 0) {
      // Don't let this pass silently: the plugin declares events it will never
      // receive, because nothing creates its Lambda or EventBridge rule (#194).
      log.warn(
        `Plugin "${pluginName}" declares ${manifest.event_subscriptions.length} event ` +
          'subscription(s) but ships no terraform/ directory, so no Lambda or EventBridge ' +
          'rule was created — those events will never reach it. Add a terraform/ module ' +
          '(start from modules/plugins/_template/) and reinstall.',
      )
    }

    if (manifest.tables.length > 0) {
      // If this throws (e.g. `uv` missing), the plugin directory is left
      // copied-but-uncommitted on disk — no rollback happens anywhere else
      // in this function either. Recovery is a two-step manual process:
      // fix `uv`, then `biffo plugin sync-migrations <name>` (re-running
      // `install` will fail with "already installed" now that targetDir
      // exists) followed by `git add`/`git commit` yourself.
      log.info(`Generating migration for ${relTargetDir}/'s ${manifest.tables.length} table(s)...`)
      const generatedPaths = await deps.migrations.generate(options.cwd, [pluginName])
      for (const absPath of generatedPaths) {
        stagePaths.push(relative(options.cwd, absPath))
      }
      if (generatedPaths.length > 0) {
        log.success(`Generated migration: ${relative(options.cwd, generatedPaths[0]!)}`)
      }
    } else {
      log.info(`${pluginName} declares no tables — nothing to migrate.`)
    }

    const commitMessage = `feat(plugins): install ${pluginName}@${source!.version}`
    await deps.git.add(options.cwd, stagePaths)
    await deps.git.commit(options.cwd, commitMessage)
    log.success(`Committed: ${commitMessage}`)

    console.log(chalk.bold('\n  Plugin installed!\n'))
    console.log(`  ${pluginName}@${source!.version} is committed at ${relTargetDir}/`)
    console.log('  Push and redeploy to apply its migration and register its routes:')
    console.log(chalk.dim(`    git push`))
    console.log(chalk.dim(`    biffo deploy <environment> --app-only\n`))
  } finally {
    source!.cleanup()
  }
}

function parseManifestFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`Could not parse ${path} as JSON: ${(err as Error).message}`)
  }
}

function printDryRun(
  entry: RegistryPluginEntry | null,
  source: ResolvedPluginSource | undefined,
  relTargetDir: string,
  inTreeSource: boolean,
): void {
  const name = entry ? entry.name : source!.name
  const version = entry ? entry.version : source!.version

  console.log(chalk.bold('\n  Dry run — no changes will be made\n'))
  console.log(`  Plugin:        ${name}@${version}`)
  if (entry) {
    console.log(`  Source repo:   ${entry.repo}`)
    console.log(`  Would clone into:   ${relTargetDir}/`)
  } else {
    console.log(`  Local source:  ${source!.origin}`)
    console.log(
      inTreeSource
        ? `  Already in tree at ${relTargetDir}/ — would install in place (no copy)`
        : `  Would copy into:    ${relTargetDir}/`,
    )
  }
  if (!entry || (entry.infra_modules && entry.infra_modules.length > 0)) {
    console.log(
      `  Would copy Terraform module into: modules/plugins/${name}/ (if the plugin has one)`,
    )
    console.log(
      `  Would wire module "plugin_${name}" + enabled_plugins into ` +
        `infra/environments/*/plugins.generated.tf and plugins.auto.tfvars.json`,
    )
  }
  if (source && source.manifest.tables.length > 0) {
    console.log(
      `  Would generate a migration for ${source.manifest.tables.length} table(s) into services/api/migrations/versions/`,
    )
  }
  console.log(`  Would commit:  feat(plugins): install ${name}@${version}\n`)
}
