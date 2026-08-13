import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import { execa } from 'execa'
import inquirer from 'inquirer'
import { GitAdapter } from '../adapters/git/index.js'
import { PluginMigrationsAdapter } from '../adapters/plugin-migrations/index.js'
import { RegistryAdapter, type RegistryPluginEntry } from '../adapters/registry/index.js'
import {
  type LockfileRefreshOutcome,
  type RunCommandFn,
  describeFailures,
  lockfilesNeedingRefresh,
  refreshLockfiles,
} from '../lib/lockfile-refresh.js'
import { log } from '../lib/logger.js'
import { validateManifest } from '../lib/plugin-manifest.js'
import {
  inTreePluginProvenance,
  readProvenance,
  reconcileProvenance,
  resolveLocalProvenance,
  resolveRegistryProvenance,
  writePluginProvenance,
} from '../lib/plugin-provenance.js'
import { pluginSeedImportDir, vendorPluginSeed } from '../lib/plugin-seed-vendor.js'
import { copyPluginSource } from '../lib/plugin-source-copy.js'
import { findPluginModuleReferences } from '../lib/plugin-terraform-wiring.js'
import { applyWorkspaceSources, readTomlStringArray } from '../lib/plugin-workspace-sources.js'
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
  /**
   * Runs a lockfile-regeneration command (`uv lock`) in the instance when a
   * plugin refresh changes a dependency it locks. Optional and defaulted to
   * `execa` at each call site (`defaultRunCommand` below) — injectable so the
   * relock is testable without a real `uv` on the machine, same shape and
   * same injection point as `core-upgrade.ts`'s `CoreUpgradeDeps.runCommand`
   * (issue #1569).
   */
  runCommand?: RunCommandFn
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

    // Checked against the freshly-cloned source, before anything is mutated,
    // so a refusal leaves the checkout untouched (biffo-template#1563). Only
    // matters when the new version ships no terraform/ of its own — if it
    // does, the module below is replaced in place, not removed, so nothing
    // can go dangling.
    if (!existsSync(join(tmpDir, 'terraform'))) {
      refuseIfModuleStillReferenced(options.cwd, modulesDir, entry.name)
    }

    // Read before the wholesale replace below destroys it — see
    // reconcileProvenance's docstring for why this can't be read afterward.
    const previousProvenance = readProvenance(targetDir)

    // Read before the same replace destroys it too — compared against the
    // post-copy version below to decide whether `uv.lock` needs regenerating
    // (issue #1569). See `relockIfDependenciesChanged`'s docstring.
    const previousPyproject = readPyprojectIfPresent(targetDir)

    rmSync(targetDir, { recursive: true, force: true })
    mkdirSync(targetDir, { recursive: true })
    cpSync(tmpDir, targetDir, { recursive: true })
    log.success(`Upgraded plugin source at services/${entry.name}/`)

    // Record where this copy came from (#1547) — see plugin-provenance.ts.
    const nextProvenance = resolveRegistryProvenance(
      entry.repo,
      await deps.git.resolveDefaultBranchSha(entry.repo),
    )
    writePluginProvenance(targetDir, reconcileProvenance(previousProvenance, nextProvenance))

    applyWorkspaceSources(targetDir, options.cwd, `services/${entry.name}`)

    // Read after `applyWorkspaceSources`, the same version that lands in the
    // commit — see `relockIfDependenciesChanged`'s docstring for why that
    // ordering matters.
    const newPyproject = readPyprojectIfPresent(targetDir)

    const stagePaths = [`services/${entry.name}`]

    // Full replace of any previously-copied Terraform module: re-copy if the
    // new version ships one, remove if it no longer does, rather than
    // leaving a stale mix of old and new files. Safe unconditionally at this
    // point — the guard above has already refused if removal-without-a-
    // replacement would orphan a reference.
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
      // A new minor version's manifest may declare new tables, new columns
      // on already-migrated tables, both, or neither —
      // generate_migration_for_plugin (services/api/src/api/migrations/
      // plugin_migrations.py) diffs both levels against what versions_dir
      // already has: new tables and additive columns are appended as a new,
      // separately chained migration; an unchanged table+column shape is a
      // no-op; a column removed, retyped, or nullability-changed on an
      // already-migrated table makes it refuse outright (a thrown error,
      // surfaced via the outer catch below) rather than guess — see that
      // function's docstring (issue #1539). It never rewrites/replaces a
      // previous migration.
      log.info(
        `Checking for a migration for services/${entry.name}/'s ${manifest.tables.length} table(s)...`,
      )
      const generatedPaths = await deps.migrations.generate(options.cwd, [entry.name])
      for (const absPath of generatedPaths) {
        stagePaths.push(relative(options.cwd, absPath))
      }
      if (generatedPaths.length > 0) {
        log.success(`Generated migration: ${relative(options.cwd, generatedPaths[0]!)}`)
      } else {
        log.info(
          `${entry.name}'s tables and columns already match the manifest — no migration needed.`,
        )
      }
    }

    // Vendor the plugin's declared tenant-scoped baseline-row seed, if any
    // (biffo-template#1554) — full replace, same as the Terraform module
    // above; a no-op when the new manifest declares no `seed`.
    const seedResult = vendorPluginSeed(targetDir, manifest, options.cwd)
    if (seedResult.vendored) {
      stagePaths.push(seedResult.stagedPath!)
    }

    // Re-lock the instance if this version changed a dependency (#1569) —
    // before staging, so a regenerated uv.lock lands in the same commit as
    // the manifest that invalidated it, matching core-upgrade's #393 fix.
    const lockOutcomes = await relockIfDependenciesChanged(
      options.cwd,
      `services/${entry.name}/pyproject.toml`,
      previousPyproject,
      newPyproject,
      deps,
    )
    for (const outcome of lockOutcomes) {
      if (outcome.ok) stagePaths.push(outcome.trigger.lockfile)
    }

    const label = currentVersion
      ? `${entry.name} ${currentVersion} -> ${entry.version}`
      : `${entry.name} to ${entry.version}`
    const commitMessage = `feat(plugins): upgrade ${label}`
    await deps.git.add(options.cwd, stagePaths)
    await deps.git.commit(options.cwd, commitMessage)
    log.success(`Committed: ${commitMessage}`)

    // A lock failure must not read as an unqualified success (#1539's same
    // reasoning) — the commit still happened, but CI will fail on the
    // mismatch until the printed command is run by hand.
    const lockFailures = describeFailures(lockOutcomes)
    if (lockFailures.length > 0) {
      console.log(chalk.yellow.bold('\n  ⚠ Plugin upgraded, but uv.lock needs attention\n'))
      for (const failure of lockFailures) console.log(chalk.yellow(`  ${failure}`))
      console.log()
    } else {
      console.log(chalk.bold('\n  Plugin upgraded!\n'))
    }
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

    // Checked against the checkout on disk, before anything is mutated, so a
    // refusal leaves the checkout untouched (biffo-template#1563) — same
    // guard and same reasoning as the registry path above. `source.sourceDir`
    // is correct whether or not this is an in-tree refresh: inTreeSource means
    // it already equals targetDir, so nothing about the check changes.
    if (!existsSync(join(source.sourceDir, 'terraform'))) {
      refuseIfModuleStillReferenced(options.cwd, modulesDir, source.name)
    }

    // Read before the wholesale replace below destroys it — see
    // reconcileProvenance's docstring for why this can't be read afterward.
    // (The in-tree branch never deletes targetDir, so this is a no-op read
    // of whatever is already correctly there — reading it unconditionally,
    // rather than only in the non-in-tree branch, keeps this one line
    // instead of two near-identical ones either side of the if/else.)
    const previousProvenance = readProvenance(targetDir)

    // Read before the same replace destroys it (a no-op read in the
    // inTreeSource branch, since nothing is deleted there) — compared against
    // the post-copy version below to decide whether `uv.lock` needs
    // regenerating (issue #1569). See `relockIfDependenciesChanged`'s
    // docstring.
    const previousPyproject = readPyprojectIfPresent(targetDir)

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

    // Record where this copy came from (#1547) — see plugin-provenance.ts.
    // reconcileProvenance (not an unconditional write) matters here
    // specifically: a byte-identical --local refresh is meant to be a no-op
    // (see the "nothing to commit" handling below), and touching the
    // provenance file's timestamp unconditionally would defeat that.
    const nextProvenance = inTreeSource
      ? inTreePluginProvenance(`services/${source.name}`)
      : await resolveLocalProvenance(source.sourceDir, source.origin)
    writePluginProvenance(targetDir, reconcileProvenance(previousProvenance, nextProvenance))

    applyWorkspaceSources(targetDir, options.cwd, `services/${source.name}`)

    // Read after `applyWorkspaceSources`, the same version that lands in the
    // commit — see `relockIfDependenciesChanged`'s docstring for why that
    // ordering matters.
    const newPyproject = readPyprojectIfPresent(targetDir)

    const stagePaths = [`services/${source.name}`]

    // Full replace of any previously-copied Terraform module, same as the
    // registry path: re-copy if the checkout ships one, remove if it no
    // longer does. Safe unconditionally here — the guard above has already
    // refused if removal-without-a-replacement would orphan a reference.
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
      // Same idempotency guarantee the registry path relies on (see its
      // comment above): generate_migration_for_plugin diffs both the
      // manifest's table set AND, for tables already migrated, its column
      // shape (issue #1539) against what versions_dir already has. A
      // route-only or otherwise no-op edit calls this and gets back an
      // empty list; a new table or an added column on an existing table
      // produces a new, additive migration file; a column removed, retyped,
      // or nullability-changed on an already-migrated table makes it throw
      // rather than guess, surfaced via the outer catch below.
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
        log.info(
          `${source.name}'s tables and columns already match the manifest — no migration needed.`,
        )
      }
    } else {
      log.info(`${source.name} declares no tables — nothing to migrate.`)
    }

    // Vendor the plugin's declared tenant-scoped baseline-row seed, if any
    // (biffo-template#1554) — full replace, same as the Terraform module
    // above; a no-op when the manifest declares no `seed`.
    const seedResult = vendorPluginSeed(targetDir, manifest, options.cwd)
    if (seedResult.vendored) {
      stagePaths.push(seedResult.stagedPath!)
    }

    // Re-lock the instance if this refresh changed a dependency (#1569) —
    // before staging, so a regenerated uv.lock lands in the same commit as
    // the manifest that invalidated it, matching core-upgrade's #393 fix.
    // The in-tree-source, byte-identical, and "version unchanged" no-op cases
    // all correctly produce no dependency change (previousPyproject equals
    // newPyproject) and so trigger nothing here.
    const lockOutcomes = await relockIfDependenciesChanged(
      options.cwd,
      `services/${source.name}/pyproject.toml`,
      previousPyproject,
      newPyproject,
      deps,
    )
    for (const outcome of lockOutcomes) {
      if (outcome.ok) stagePaths.push(outcome.trigger.lockfile)
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
    // this path deliberately does not have. A dependency change that
    // regenerated uv.lock (above) always leaves something staged, so this
    // short-circuit cannot fire on a refresh that genuinely needs a lock.
    if (!(await deps.git.hasUncommittedChanges(options.cwd))) {
      log.warn(`services/${source.name}/ already matches ${source.origin} — nothing to commit.`)
      return
    }

    const commitMessage = `chore(plugins): refresh ${source.name} from local checkout`
    await deps.git.commit(options.cwd, commitMessage)
    log.success(`Committed: ${commitMessage}`)

    // A lock failure must not read as an unqualified success (#1539's same
    // reasoning) — the commit still happened, but CI will fail on the
    // mismatch until the printed command is run by hand.
    const lockFailures = describeFailures(lockOutcomes)
    if (lockFailures.length > 0) {
      console.log(chalk.yellow.bold('\n  ⚠ Plugin refreshed, but uv.lock needs attention\n'))
      for (const failure of lockFailures) console.log(chalk.yellow(`  ${failure}`))
      console.log()
    } else {
      console.log(chalk.bold('\n  Plugin refreshed!\n'))
    }
    console.log(`  services/${source.name}/ now matches ${source.origin}`)
    console.log('  Push and redeploy to apply any updated tables and routes:')
    console.log(chalk.dim(`    git push`))
    console.log(chalk.dim(`    biffo deploy <environment> --app-only\n`))
  } finally {
    source.cleanup()
  }
}

/**
 * Refuses a refresh that would delete `modules/plugins/<name>/` while
 * anything under `infra/**` still points at it (biffo-template#1563).
 *
 * A plugin repo shipping no `terraform/` is **missing a file**, not
 * declaring that the module should be removed — indistinguishable from a
 * repo that never adopted the skeleton (skeleton-adoption tracking measures
 * `terraform/*.tf` at 1/2 across plugin repos right now). The same refresh
 * against a copy that still ships `terraform/` preserves the module; that
 * asymmetry alone must not be what deletes live infrastructure.
 *
 * Only meaningful when the *new* source ships no `terraform/` of its own —
 * every call site below checks that first. When it does ship one, the module
 * is about to be replaced in place, not removed, so nothing can go dangling
 * and this is not called.
 */
function refuseIfModuleStillReferenced(cwd: string, modulesDir: string, name: string): void {
  if (!existsSync(modulesDir)) return // nothing to remove
  const refs = findPluginModuleReferences(cwd, name)
  if (refs.length === 0) return // genuinely unreferenced — removing it is fine
  const refList = refs.map((r) => `  ${r.file}:${r.line}  ${r.text}`).join('\n')
  throw new Error(
    `Refusing to remove modules/plugins/${name}/ — '${name}' ships no terraform/ directory in ` +
      `this version, but the module is still referenced:\n${refList}\n` +
      `A plugin repo without terraform/ is missing the directory, not declaring that the module ` +
      `should go, and a wrong destructive action here is worse than no action. Either remove the ` +
      `reference(s) above yourself, or run 'biffo plugin uninstall ${name}', which removes the ` +
      `module and unwires the reference together.`,
  )
}

/**
 * Re-lock the instance's `uv.lock` when a plugin refresh changed a dependency
 * it locks (issue #1569).
 *
 * ## What broke
 *
 * A plugin's `pyproject.toml` is copied wholesale into `services/<name>/` by
 * both refresh paths above, but nothing regenerated `uv.lock` afterward —
 * `services/<name>/` is a `[tool.uv.workspace]` member (root `pyproject.toml`),
 * so a dependency change there invalidates the root lockfile the same way a
 * core-upgrade-rewritten manifest does (#393, `lib/lockfile-refresh.ts`). The
 * refresh committed fine locally and failed in CI on `uv sync --all-groups
 * --locked`, naming `uv.lock` rather than the plugin — a confusing detour from
 * a commit that looked like it only touched plugin source.
 *
 * ## Chosen fix: auto-lock, not just warn
 *
 * The issue offered two options — auto-run `uv lock`, or at minimum print a
 * warning. This takes the auto-lock option, reusing the exact machinery
 * `core-upgrade.ts` already built and ships for the structurally identical
 * problem (`lockfilesNeedingRefresh` / `refreshLockfiles` / `describeFailures`
 * in `lib/lockfile-refresh.ts`) rather than re-deriving a second, divergent
 * implementation of the same fix:
 *
 * - It is the smaller behavioural surface for a user to learn — `core upgrade`
 *   and `plugin upgrade` already share the "manifest changed → lockfile
 *   regenerated in this repo, committed alongside" contract, and a plugin
 *   dependency change is not different in kind.
 * - A warn-only fix still leaves every dependency-changing refresh red on its
 *   own CI run, just with a better error message — the exact failure the
 *   issue reports still happens, only explained rather than avoided. The
 *   auto-lock keeps `biffo plugin upgrade --local` usable as advertised: "push
 *   and redeploy" (the command's own closing instructions) with green CI.
 *
 * ## Failure mode: soft, and stated at the point of success
 *
 * `uv lock` can fail — no network, no `uv` on PATH, a real resolution
 * conflict a plugin's new pin introduces. A failure here must not discard an
 * otherwise-good plugin refresh (the source copy, migration, Terraform sync
 * all already succeeded) by throwing and aborting the whole command, nor
 * silently commit a stale `uv.lock` and let CI discover the mismatch with no
 * connection back to "this plugin refresh needs `uv lock`" — the exact "do
 * not report a conclusion the operation did not earn" reasoning #1539 already
 * established for a sibling case. So: the refresh still commits (with
 * whatever `uv.lock` state resulted — unchanged on failure, since a failed
 * `uv lock` does not write a partial file), and the two call sites below
 * downgrade "Plugin upgraded!" / "Plugin refreshed!" to a yellow warning
 * banner naming the exact command to run by hand, rather than printing an
 * unqualified success next to a lockfile CI will reject.
 *
 * ## Detecting "a dependency actually changed", not "the file changed"
 *
 * Re-locking on every refresh would be slow and produce a lockfile diff on
 * every routine, dependency-free refresh — most of which touch no manifest at
 * all. So this compares the *parsed dependency surface* of
 * `services/<name>/pyproject.toml` before the copy and after it (post
 * `applyWorkspaceSources`, since that is the version that lands in the
 * commit), not the raw file text: `applyWorkspaceSources` unconditionally
 * rewrites the `[tool.uv.sources]` section, which would make every refresh
 * of a workspace-sourced plugin look like a dependency change under a naive
 * text diff even when the actual dependency list is untouched.
 * `dependencySurface` extracts, comment- and whitespace-blind (reusing
 * `readTomlStringArray`'s bracket-aware scanner from
 * `lib/plugin-workspace-sources.ts`):
 *
 * - `[project] dependencies` (full version-spec strings, so a bump like
 *   `httpx>=0.28.1` -> `httpx>=0.29.0` counts as a change, not just an
 *   add/remove);
 * - every named array under `[dependency-groups]` (`dev`, or whatever a
 *   plugin calls it — the exact shape biffo-plugin-marketing#138 added
 *   `pyyaml>=6.0` to, which is what prompted this issue);
 * - every named array under `[project.optional-dependencies]`.
 *
 * Known gap: a `requires-python` change alone (no dependency list edited) is
 * not covered — rare in practice for a minor plugin refresh, and `uv lock`
 * would still fail loudly in that instance's own CI with a readable error if
 * it ever does, rather than silently mis-resolving.
 *
 * ## JS: checked, not assumed
 *
 * The issue asked whether a plugin's `web`/`web-admin` `package.json` can
 * likewise reach the instance's root lockfile. It cannot: `pnpm-workspace.yaml`
 * at the repo root lists only `apps/*`, `packages/*` and `cli` as workspace
 * packages — `services/*` is not a member, so `services/<name>/web-admin/`
 * (which ships its own `pnpm-lock.yaml` in the plugin skeleton) is never
 * resolved by the instance's root `pnpm-lock.yaml`. Only `uv.lock` is wired
 * here; there is nothing for pnpm to do.
 */
async function relockIfDependenciesChanged(
  cwd: string,
  relPyprojectPath: string,
  previousPyproject: string | null,
  newPyproject: string | null,
  deps: PluginUpgradeDeps,
): Promise<LockfileRefreshOutcome[]> {
  if (!dependenciesChanged(previousPyproject, newPyproject)) return []

  const triggers = lockfilesNeedingRefresh([relPyprojectPath], cwd)
  if (triggers.length === 0) return []

  const run = deps.runCommand ?? defaultRunCommand
  const outcomes = await refreshLockfiles(cwd, triggers, run)

  const refreshed = outcomes.filter((o) => o.ok)
  if (refreshed.length > 0) {
    log.success(
      `Refreshed ${refreshed.map((o) => o.trigger.lockfile).join(', ')} — this refresh changed ` +
        'a dependency it locks.',
    )
  }
  for (const message of describeFailures(outcomes)) log.warn(message)
  return outcomes
}

const defaultRunCommand: RunCommandFn = async (command, cwd) => {
  const [bin, ...args] = command
  if (!bin) return { ok: false, error: 'empty command' }
  try {
    await execa(bin, args, { cwd })
    return { ok: true }
  } catch (err) {
    const cause = err as { shortMessage?: string; stderr?: string; message?: string }
    const detail = cause.stderr?.trim() || cause.shortMessage || cause.message || 'failed'
    return { ok: false, error: detail.split('\n')[0] ?? 'failed' }
  }
}

/** `services/<name>/pyproject.toml`'s content, or null if it does not exist —
 * a plugin with no Python dependencies (tables/routes only) legitimately has
 * none. */
function readPyprojectIfPresent(targetDir: string): string | null {
  const path = join(targetDir, 'pyproject.toml')
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

/** True when the two `pyproject.toml` texts' dependency surfaces differ — see
 * `relockIfDependenciesChanged`'s docstring for what "surface" means and why. */
function dependenciesChanged(before: string | null, after: string | null): boolean {
  if (before === after) return false // includes both null
  const beforeItems = before ? dependencySurface(before) : []
  const afterItems = after ? dependencySurface(after) : []
  return JSON.stringify(beforeItems) !== JSON.stringify(afterItems)
}

/** The sorted, comment-blind dependency strings a pyproject.toml declares —
 * `[project] dependencies` plus every array under `[dependency-groups]` and
 * `[project.optional-dependencies]`. */
function dependencySurface(text: string): string[] {
  const items = [...readTomlStringArray(text, 'dependencies')]
  for (const header of ['dependency-groups', 'project.optional-dependencies']) {
    const body = tomlTableBody(text, header)
    if (!body) continue
    for (const m of body.matchAll(/^([A-Za-z0-9_.-]+)\s*=\s*\[/gm)) {
      items.push(...readTomlStringArray(body, m[1]!))
    }
  }
  return items.sort()
}

/** The text of a TOML table between `[header]` and the next top-level `[...]`
 * header (or EOF), or null if `header` is absent. */
function tomlTableBody(text: string, header: string): string | null {
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const headerMatch = new RegExp(`^\\[${escaped}\\]\\s*$`, 'm').exec(text)
  if (!headerMatch) return null
  const rest = text.slice(headerMatch.index + headerMatch[0].length)
  const nextHeader = /^\[/m.exec(rest)
  return nextHeader ? rest.slice(0, nextHeader.index) : rest
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
  if (entry.baseline_tables && entry.baseline_tables.length > 0) {
    console.log(
      `  Would re-vendor seed DDL into: ${pluginSeedImportDir(entry.name)}/ ` +
        `(baseline_tables: ${entry.baseline_tables.join(', ')})`,
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
        '(generated for a new table or an added column on an already-migrated table; ' +
        'a removed/retyped/nullability-changed column stops the refresh instead — #1539)',
    )
  }
  if (source.manifest.seed) {
    console.log(
      `  Would re-vendor seed DDL into: ${pluginSeedImportDir(source.name)}/ ` +
        `(baseline_tables: ${source.manifest.seed.baseline_tables.join(', ') || 'none declared'})`,
    )
  }
  console.log(`  Would commit:  chore(plugins): refresh ${source.name} from local checkout\n`)
}
