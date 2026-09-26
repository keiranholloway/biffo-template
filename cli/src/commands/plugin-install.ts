import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import { GitAdapter } from '../adapters/git/index.js'
import { PluginMigrationsAdapter } from '../adapters/plugin-migrations/index.js'
import { withRefreshedLock } from '../lib/plugin-commit.js'
import { RegistryAdapter, type RegistryPluginEntry } from '../adapters/registry/index.js'
import { log } from '../lib/logger.js'
import {
  missingRequiredConfigMessage,
  parseConfigOptionValues,
  resolvePluginConfigSupply,
  type ResolvedPluginConfigValue,
} from '../lib/plugin-config-resolution.js'
import {
  assertPluginRegistryReady,
  frontendUrlForSlug,
  PLUGIN_REGISTRY_RELATIVE_PATH,
  titleFromSlug,
  upsertPluginRegistryEntry,
} from '../lib/plugin-frontend-registry.js'
import { pluginDir } from '../lib/plugin-locations.js'
import { validateManifest, type PluginManifest } from '../lib/plugin-manifest.js'
import {
  inTreePluginProvenance,
  readProvenance,
  reconcileProvenance,
  resolveLocalProvenance,
  resolveRegistryProvenance,
  PLUGIN_PROVENANCE_FILENAME,
  writePluginProvenance,
} from '../lib/plugin-provenance.js'
import { pluginSeedImportDir, vendorPluginSeed } from '../lib/plugin-seed-vendor.js'
import { copyPluginSource } from '../lib/plugin-source-copy.js'
import {
  findRetiredFrontendShape,
  retiredFrontendShapeError,
  syncPluginTerraform,
} from '../lib/plugin-terraform-wiring.js'
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
  .option(
    '--frontend-cwd <path>',
    'Dashboard sibling checkout to write the user_frontend dashboard-registry entry into, ' +
      'when the core project and its dashboard are split siblings (biffo-template#2012) — e.g. ' +
      'biffo-platform / biffo-platform-app. Every other write (backend scaffolding, Terraform, ' +
      'the migration, the manifest) still resolves against --cwd only. Omit it for the common ' +
      'single-repo topology, where the registry entry is written into --cwd as before. Ignored ' +
      'for a plugin manifest with no user_frontend block, since there is nothing to register.',
  )
  .option(
    '--config <name=value>',
    'Supply an instance value for one manifest `config:` declaration (biffo-template#1517) — ' +
      "repeatable. For a 'secret' declaration, value must be an SSM parameter PATH, never the " +
      'credential itself.',
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .action(
    async (
      target: string | undefined,
      options: {
        local?: string
        dryRun?: boolean
        cwd?: string
        frontendCwd?: string
        config: string[]
      },
    ) => {
      const cwd = options.cwd ? resolve(options.cwd) : process.cwd()
      try {
        await runPluginInstall(
          target,
          {
            ...(options.local ? { local: resolve(options.local) } : {}),
            dryRun: options.dryRun ?? false,
            cwd,
            ...(options.frontendCwd ? { frontendCwd: resolve(options.frontendCwd) } : {}),
            config: parseConfigOptionValues(options.config),
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
  /**
   * Absolute path to a separate dashboard sibling checkout (biffo-template#2012,
   * decided Option A) — when set, the `user_frontend` dashboard-registry write
   * (`apps/frontend/src/lib/plugins.ts`) resolves against this path instead of
   * `cwd`, and is committed there as its own commit rather than riding in
   * `cwd`'s install commit (the two are separate git repos in a split
   * core+dashboard topology, so a shared commit is not possible). Every other
   * write in this function (backend scaffolding, Terraform, the migration, the
   * manifest, provenance) continues to resolve against `cwd` only, whether or
   * not this is set. Undefined for the common single-repo topology, where the
   * registry write happens against `cwd` exactly as it did before this option
   * existed — that path is unchanged byte-for-byte. Has no effect at all on a
   * manifest with no `user_frontend` block.
   */
  frontendCwd?: string
  /**
   * Instance-supplied values for the manifest's `config:` declarations
   * (biffo-template#1517), keyed by declaration name — from repeatable
   * `--config <name>=<value>`. Defaults to `{}` for callers (and existing
   * tests) that predate this option; a manifest with no `config` block
   * behaves identically either way.
   */
  config?: Readonly<Record<string, string>>
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

  // Where the user_frontend dashboard-registry write resolves against
  // (biffo-template#2012). Every other write in this function keeps using
  // options.cwd directly, never this — only the two registry-write call
  // sites below (the readiness guard and the actual upsert) use it, so a
  // plugin manifest that declares no user_frontend never even computes
  // whether the two paths differ in a way that matters.
  const registryCwd = options.frontendCwd ?? options.cwd

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
    printDryRun(
      entry,
      source!,
      relTargetDir,
      inTreeSource,
      options.config ?? {},
      options.frontendCwd,
    )
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

  // What this run has changed so far, kept only so a failure can say exactly what it left (#2106). Nothing here is undone on
  // failure — install has never rolled back — so the honest thing is to name it. Empty until the first write.
  const left = newInstallLeftovers(options.cwd, registryCwd)

  try {
    log.success(
      `Manifest valid — ${manifest.tables.length} table(s), ${manifest.api_routes.length} route(s)`,
    )

    // Fail-closed on the retired ADR-0018 §2 per-plugin frontend hosting shape
    // (biffo-template#1916, #558 milestone 3) — checked against the resolved
    // source before anything is copied, so a refusal leaves the checkout
    // untouched. `source.sourceDir` is correct whether this is a registry
    // clone, a local out-of-tree checkout, or an in-tree `--local` install
    // (where it already equals targetDir).
    const retiredShapeReasons = findRetiredFrontendShape(join(source!.sourceDir, 'terraform'))
    if (retiredShapeReasons.length > 0) {
      throw new Error(retiredFrontendShapeError(pluginName, retiredShapeReasons))
    }

    // Fail-closed on the manifest's declared `config:` needs (biffo-template#1517,
    // rule 4) — checked before anything is copied, same posture as the retired-
    // frontend-shape check above: a refusal here must leave the checkout
    // untouched. A `required: true` declaration with no supplied value fails
    // installation LOUDLY, rather than mounting a plugin that fails — or worse,
    // silently no-ops — the first time it is actually used.
    const configSupply = resolvePluginConfigSupply(
      pluginName,
      manifest.config,
      options.config ?? {},
    )
    if (configSupply.missingRequired.length > 0) {
      throw new Error(missingRequiredConfigMessage(pluginName, configSupply.missingRequired))
    }

    // Fail-closed on a `user_frontend` block with nowhere to register
    // (biffo-template#2041) — checked before anything is copied, same
    // posture as the two guards above: a refusal here must leave the
    // checkout untouched. A plugin declaring no `user_frontend` never
    // touches the dashboard registry at all, so this is skipped entirely for
    // an ordinary (data/event/CRUD) plugin.
    if (manifest.user_frontend) {
      // Split core+dashboard topology (biffo-template#2012): the registry
      // write is about to land in a checkout other than options.cwd, so
      // confirm it is a real git repo before anything is written anywhere —
      // same fail-closed-before-mutation posture as every guard above.
      // Skipped entirely when --frontend-cwd is omitted, since registryCwd
      // then equals options.cwd, already confirmed a repo above.
      if (options.frontendCwd) {
        const frontendIsRepo = await deps.git.isGitRepo(registryCwd)
        if (!frontendIsRepo) {
          throw new Error(
            `${registryCwd} (--frontend-cwd) is not a git repository — biffo plugin install ` +
              'must write the dashboard registry into a real checkout.',
          )
        }
      }
      assertPluginRegistryReady(registryCwd, pluginName)
    }

    // Only now — after the manifest has validated — do we touch the target repo.
    if (inTreeSource) {
      log.info(`${relTargetDir}/ is already in this checkout — installing in place.`)
    } else {
      // Recorded before the copy: a copy that dies half-way has still created the directory.
      left.core.written.push(relTargetDir)
      mkdirSync(targetDir, { recursive: true })
      await copyPluginSource(source!.sourceDir, targetDir)
      log.success(`Installed plugin source at ${relTargetDir}/`)
    }

    // Record where this copy came from (#1547) — a dedicated file, not
    // biffo.plugin.json, so recording provenance never mutates the plugin's
    // own manifest. See plugin-provenance.ts for why each branch resolves
    // its SHA the way it does, and why `reconcileProvenance` (not an
    // unconditional write) matters even here: a re-run of an in-tree
    // `--local` install must not touch an unchanged provenance file's
    // timestamp.
    const previousProvenance = readProvenance(targetDir)
    const nextProvenance = inTreeSource
      ? inTreePluginProvenance(relTargetDir)
      : entry
        ? resolveRegistryProvenance(entry.repo, await deps.git.resolveDefaultBranchSha(entry.repo))
        : await resolveLocalProvenance(source!.sourceDir, source!.origin)
    // An in-tree install did not copy the plugin — the directory is already the operator's, and only the file written here is new.
    if (inTreeSource) left.core.written.push(`${relTargetDir}/${PLUGIN_PROVENANCE_FILENAME}`)
    writePluginProvenance(targetDir, reconcileProvenance(previousProvenance, nextProvenance))

    // Wire the vendored plugin's deps to the instance's uv workspace. If the
    // instance provides one of them as a member (e.g. biffo-plugin-sdk), uv
    // refuses to resolve the plugin — and the migration step below is the first
    // `uv run` to hit it — unless its pyproject sources that dep from the
    // workspace. The standalone repo resolves it from PyPI; only the vendored
    // copy needs this. (#biffo-plugin-install user-facing series.)
    const sourced = applyWorkspaceSources(targetDir, options.cwd, relTargetDir)
    if (inTreeSource && sourced.length > 0) left.core.written.push(`${relTargetDir}/pyproject.toml`)

    let stagePaths = [relTargetDir]
    // Stage a path AND record it as written: everything but the plugin directory itself (staged as a whole, recorded above).
    const track = (...paths: string[]) => {
      stagePaths.push(...paths)
      left.core.written.push(...paths)
    }

    const tfSourceDir = join(targetDir, 'terraform')
    if (existsSync(tfSourceDir)) {
      mkdirSync(modulesDir, { recursive: true })
      cpSync(tfSourceDir, modulesDir, { recursive: true })
      track(`modules/plugins/${pluginName}`)
      log.success(`Copied Terraform module to modules/plugins/${pluginName}/`)

      // Wire it into every environment root config (#201). Regenerated in full
      // from modules/plugins/, so re-running install can't duplicate a module
      // block or an enabled_plugins entry.
      const wiring = syncPluginTerraform(options.cwd)
      track(...wiring.changedPaths)
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
      left.phase = 'migration'
      const generatedPaths = await deps.migrations.generate(options.cwd, [pluginName])
      left.phase = 'other'
      for (const absPath of generatedPaths) {
        track(relative(options.cwd, absPath))
      }
      if (generatedPaths.length > 0) {
        log.success(`Generated migration: ${relative(options.cwd, generatedPaths[0]!)}`)
      }
    } else {
      log.info(`${pluginName} declares no tables — nothing to migrate.`)
    }

    // Vendor the plugin's declared tenant-scoped baseline-row seed, if any
    // (biffo-template#1554) — a no-op when the manifest declares no `seed`.
    const seedResult = vendorPluginSeed(targetDir, manifest, options.cwd)
    if (seedResult.vendored) {
      track(seedResult.stagedPath!)
    }

    // Record where each declared config need's value comes from (biffo-template#1517)
    // — never the value of a secret itself, only the SSM parameter PATH that
    // holds it (or a setting's literal, which is never confidential). Written
    // even when `resolved` is empty, so a plugin's config gate can be told
    // apart from a plugin declaring no `config` at all.
    if (manifest.config.length > 0) {
      const configFilePath = join(targetDir, 'biffo.plugin-config.json')
      writeFileSync(
        configFilePath,
        JSON.stringify(
          {
            plugin: pluginName,
            resolved: configSupply.resolved.map(({ name, kind, envName, value }) => ({
              name,
              kind,
              env: envName,
              // For a secret this is the SSM parameter PATH, not the credential.
              value,
            })),
          },
          null,
          2,
        ) + '\n',
        'utf8',
      )
      track(relative(options.cwd, configFilePath))
      log.success(
        `Recorded ${configSupply.resolved.length}/${manifest.config.length} declared config ` +
          `value(s) at ${relative(options.cwd, configFilePath)}`,
      )
    }

    // The install added a member to the instance's uv workspace, so the committed uv.lock is stale whether or not the plugin has
    // tables (only a table-bearing plugin runs `uv` above, and only as a side effect). Re-lock explicitly, AFTER every file that
    // feeds the lock is written and BEFORE anything is committed, then stage the result (biffo-template#2106; #2108 tracks the
    // other commands that commit a stale lock).
    stagePaths = await withRefreshedLock(deps, options.cwd, stagePaths)

    // Register this plugin's user-facing surface in the installing sibling's
    // dashboard (biffo-template#2041) — create-or-update, keyed by name, so
    // re-running install (e.g. a version bump) replaces rather than
    // duplicates the entry. `assertPluginRegistryReady` above already
    // guaranteed the file and its managed region exist, so this cannot throw
    // here in the ordinary case; it can still throw on a genuinely malformed
    // hand-edit, which is why it stays inside this function's try/finally.
    if (manifest.user_frontend) {
      upsertPluginRegistryEntry(registryCwd, {
        slug: pluginName,
        title: titleFromSlug(pluginName),
        frontendUrl: frontendUrlForSlug(pluginName),
      })
      if (options.frontendCwd) {
        // Split core+dashboard topology (biffo-template#2012, Option A): the
        // registry entry just written lives in a *different* git repo from
        // options.cwd, so it cannot ride in the --cwd commit below — that
        // path does not exist in options.cwd's repo at all. Commit it here,
        // as its own commit, in its own checkout.
        const dashboardCommitMessage = `feat(plugins): register ${pluginName}@${source!.version} in dashboard`
        left.dashboard.written.push(PLUGIN_REGISTRY_RELATIVE_PATH)
        left.dashboard.stage = 'partial'
        await deps.git.add(registryCwd, [PLUGIN_REGISTRY_RELATIVE_PATH])
        left.dashboard.stage = 'staged'
        left.dashboard.staged = [PLUGIN_REGISTRY_RELATIVE_PATH]
        await deps.git.commit(registryCwd, dashboardCommitMessage)
        left.dashboard.stage = 'committed'
        left.dashboard.committed = dashboardCommitMessage
        log.success(
          `Registered ${pluginName} in ${registryCwd}/${PLUGIN_REGISTRY_RELATIVE_PATH} ` +
            `(committed there: "${dashboardCommitMessage}")`,
        )
      } else {
        track(PLUGIN_REGISTRY_RELATIVE_PATH)
        log.success(`Registered ${pluginName} in ${PLUGIN_REGISTRY_RELATIVE_PATH}`)
      }
    }

    const commitMessage = `feat(plugins): install ${pluginName}@${source!.version}`
    left.core.stage = 'partial'
    await deps.git.add(options.cwd, stagePaths)
    left.core.stage = 'staged'
    left.core.staged = stagePaths
    await deps.git.commit(options.cwd, commitMessage)
    log.success(`Committed: ${commitMessage}`)

    console.log(chalk.bold('\n  Plugin installed!\n'))
    console.log(`  ${pluginName}@${source!.version} is committed at ${relTargetDir}/`)
    if (manifest.user_frontend && options.frontendCwd) {
      console.log(
        `  Its dashboard registration is committed separately at ` +
          `${registryCwd}/${PLUGIN_REGISTRY_RELATIVE_PATH}.`,
      )
    }
    console.log('  Push and redeploy to apply its migration and register its routes:')
    console.log(chalk.dim(`    git push`))
    if (manifest.user_frontend && options.frontendCwd) {
      console.log(chalk.dim(`    (and, in ${registryCwd}) git push`))
    }
    console.log(chalk.dim(`    biffo deploy <environment> --app-only\n`))
    printConfigWiringInstructions(pluginName, configSupply.resolved)
  } catch (err) {
    throw withLeftovers(err, left, pluginName)
  } finally {
    source!.cleanup()
  }
}

type StageState = 'none' | 'partial' | 'staged' | 'committed'

interface RepoLeftovers {
  cwd: string
  /** Paths written into the working tree and not (yet) committed. */
  written: string[]
  /** The paths `git add` was asked to stage, once that call has returned. */
  staged: string[]
  stage: StageState
  /** The commit already made in this repo, if any — never undone by a later failure. */
  committed: string | null
}

interface InstallLeftovers {
  core: RepoLeftovers
  /** The dashboard checkout (`--frontend-cwd`), or the same repo as `core` when there is none. */
  dashboard: RepoLeftovers
  phase: 'migration' | 'other'
}

function newInstallLeftovers(cwd: string, registryCwd: string): InstallLeftovers {
  const repo = (dir: string): RepoLeftovers => ({
    cwd: dir,
    written: [],
    staged: [],
    stage: 'none',
    committed: null,
  })
  return { core: repo(cwd), dashboard: repo(registryCwd), phase: 'other' }
}

/**
 * Wraps a failure with an account of what the install had already changed, so the operator never has to diff to find out.
 * "A failed install says exactly what it left" is a done-when of biffo-template#2106, and it must hold on EVERY failure path — the
 * migration step, the lock refresh, `git add`, either commit — not just the one that was reproduced. A failure before the first
 * write (a guard) has nothing to report and is passed through untouched.
 */
function withLeftovers(err: unknown, left: InstallLeftovers, pluginName: string): unknown {
  const repos = left.dashboard.cwd === left.core.cwd ? [left.core] : [left.core, left.dashboard]
  const lines: string[] = []
  for (const repo of repos) {
    if (repo.stage === 'partial') {
      lines.push(
        `  - \`git add\` failed part-way in ${repo.cwd}: any of ${[...repo.written, ...repo.staged].join(', ')} may be partially staged`,
      )
    } else if (repo.stage === 'staged') {
      lines.push(`  - staged (git add), not committed, in ${repo.cwd}: ${repo.staged.join(', ')}`)
    } else if (repo.stage !== 'committed' && repo.written.length > 0) {
      lines.push(`  - written, not committed, in ${repo.cwd}: ${repo.written.join(', ')}`)
    }
    if (repo.committed !== null) {
      lines.push(`  - already committed in ${repo.cwd}: "${repo.committed}" (not undone)`)
    }
  }
  if (lines.length === 0) return err

  const committedElsewhere = repos.some((r) => r.committed !== null)
  const advice =
    left.phase === 'migration'
      ? `Fix the error above, then \`biffo plugin sync-migrations ${pluginName}\` and commit, or discard those paths with git.`
      : left.core.stage === 'staged'
        ? `Fix what the commit reported and run \`git commit\` in ${left.core.cwd}, or unstage and discard those paths with git.`
        : 'Fix the error above and commit those paths yourself, or discard them with git.'
  const undo = committedElsewhere
    ? ' A commit already made is not undone: `git reset --soft HEAD~1` in that checkout if you abandon the install.'
    : ''
  const message = err instanceof Error ? err.message : String(err)
  return new Error(
    `${message}\n\nbiffo plugin install stopped part-way and rolled nothing back. What it left:\n${lines.join('\n')}\n${advice}${undo}`,
    { cause: err },
  )
}

/**
 * Tells the operator exactly what to add to their instance's
 * `infra/environments/<env>/plugin_host.auto.tfvars.json`'s
 * `plugin_host_environment` map (biffo-template#1517) — this file is
 * user-owned, so the CLI does not write it directly (same posture as the
 * `wiring.skippedEnvironments` warning above for `enabled_plugins`). A
 * `secret` also needs the underlying SSM parameter's `ssm:GetParameter` (and,
 * if it's a SecureString on a customer-managed KMS key, a scoped
 * `kms:Decrypt`) granted to the shared plugin host's execution role.
 */
function printConfigWiringInstructions(
  pluginName: string,
  resolved: readonly ResolvedPluginConfigValue[],
): void {
  if (resolved.length === 0) return

  console.log(chalk.bold(`  ${pluginName} needs these env vars on the shared plugin host:\n`))
  const entries: Record<string, string> = {}
  for (const r of resolved) entries[r.envName] = r.value
  console.log(chalk.dim(`    ${JSON.stringify(entries, null, 2).split('\n').join('\n    ')}`))
  console.log(
    `\n  Add them to plugin_host_environment in infra/environments/<env>/` +
      `plugin_host.auto.tfvars.json.`,
  )
  if (resolved.some((r) => r.kind === 'secret')) {
    console.log(
      "  At least one is a secret reference — grant the shared plugin host's execution role " +
        "ssm:GetParameter (and kms:Decrypt if it's a SecureString on a customer-managed key) " +
        'scoped to that parameter.',
    )
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
  suppliedConfig: Readonly<Record<string, string>> = {},
  frontendCwd?: string,
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
  if (source && source.manifest.seed) {
    console.log(
      `  Would vendor seed DDL into: ${pluginSeedImportDir(name)}/ ` +
        `(baseline_tables: ${source.manifest.seed.baseline_tables.join(', ') || 'none declared'})`,
    )
  }
  if (source && source.manifest.user_frontend) {
    // biffo-template#2012: only known here when the manifest was already
    // resolved (--local / in-tree) — a registry target's manifest isn't
    // cloned until after the dry-run return, so this line simply doesn't
    // print for that case, same as the tables/seed previews above.
    console.log(
      frontendCwd
        ? `  Would register in dashboard at: ${frontendCwd}/${PLUGIN_REGISTRY_RELATIVE_PATH} ` +
            '(separate --frontend-cwd checkout, committed there)'
        : `  Would register in dashboard at: ${PLUGIN_REGISTRY_RELATIVE_PATH}`,
    )
  }
  if (source && source.manifest.config.length > 0) {
    // biffo-template#1517: preview whether the real (non-dry-run) install
    // would refuse for a missing required value — computed, not guessed, so
    // a dry run tells the truth about what install would actually do.
    const { resolved, missingRequired } = resolvePluginConfigSupply(
      name,
      source.manifest.config,
      suppliedConfig,
    )
    console.log(`  Declares ${source.manifest.config.length} config need(s):`)
    for (const c of source.manifest.config) {
      const status = missingRequired.some((m) => m.name === c.name)
        ? 'MISSING (would fail install)'
        : resolved.some((r) => r.name === c.name)
          ? 'supplied'
          : 'not supplied (optional)'
      console.log(`    - ${c.name} (${c.kind}${c.required ? ', required' : ''}): ${status}`)
    }
  }
  console.log(`  Would commit:  feat(plugins): install ${name}@${version}\n`)
}
