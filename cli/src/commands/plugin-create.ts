import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import chalk from 'chalk'
import { Command } from 'commander'
import { GitAdapter } from '../adapters/git/index.js'
import { INSTANCE_CORE_FILE } from '../lib/core-version.js'
import { log } from '../lib/logger.js'
import { pluginDir, type PluginChannel } from '../lib/plugin-locations.js'
import { validateManifest } from '../lib/plugin-manifest.js'
import { deriveNames, findSkeletonRoot, scaffoldPlugin } from '../lib/plugin-scaffold.js'

export const pluginCreateCommand = new Command('create')
  .description('Scaffold a new plugin from the Biffo plugin skeleton: biffo plugin create <name>')
  .argument('<name>', 'Plugin name — lowercase kebab-case, e.g. acme-crm')
  .option(
    '--first-party',
    'Scaffold into the template-owned services/_plugins/ carve-out. Only valid in the biffo-template repo itself — see notes.',
  )
  .option(
    '--skeleton <path>',
    'Path to the plugin skeleton (defaults to _skeletons/plugin-template)',
  )
  .option('--dry-run', 'Print planned changes without modifying the repo')
  .option('--no-commit', 'Scaffold the files but leave them uncommitted')
  .option('--cwd <path>', 'Project root to scaffold into (defaults to the current directory)')
  .action(
    async (
      name: string,
      options: {
        firstParty?: boolean
        skeleton?: string
        dryRun?: boolean
        commit?: boolean
        cwd?: string
      },
    ) => {
      const cwd = options.cwd ? resolve(options.cwd) : process.cwd()
      try {
        await runPluginCreate(
          name,
          {
            firstParty: options.firstParty ?? false,
            ...(options.skeleton ? { skeletonRoot: resolve(options.skeleton) } : {}),
            dryRun: options.dryRun ?? false,
            commit: options.commit !== false,
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

export interface PluginCreateDeps {
  git: GitAdapter
}

export interface PluginCreateOptions {
  firstParty: boolean
  skeletonRoot?: string
  dryRun: boolean
  commit: boolean
  cwd: string
}

/**
 * Scaffolds a new plugin into the current checkout from
 * `_skeletons/plugin-template/`.
 *
 * **Where it scaffolds, and why.** The default is `services/<name>/`, the
 * user-owned channel (#243). That is the correct home for a plugin you are
 * authoring: `biffo core upgrade` never touches user-owned paths, so your
 * plugin is yours to edit and cannot be overwritten by a template sync.
 *
 * `--first-party` scaffolds into `services/_plugins/<name>/` instead, which is
 * **template-owned**. That is only ever right inside the biffo-template repo
 * itself, where first-party plugins are authored and shipped in lockstep with
 * core. In an *instance* it would be actively harmful: the next
 * `biffo core upgrade` three-way-merges every template-owned path, so a plugin
 * you wrote there would be merged against a template that has never heard of
 * it. So the flag is refused when `biffo.core.json` is present — the same
 * instance marker `check-core-version-bump.ts` uses.
 *
 * The scaffold is validated before it is committed: the rewritten manifest goes
 * through `validateManifest`, so a broken skeleton fails here rather than at
 * the user's next deploy.
 */
export async function runPluginCreate(
  name: string,
  options: PluginCreateOptions,
  deps: PluginCreateDeps,
): Promise<void> {
  const names = deriveNames(name)

  const isInstance = existsSync(join(options.cwd, INSTANCE_CORE_FILE))
  if (options.firstParty && isInstance) {
    throw new Error(
      `--first-party scaffolds into services/_plugins/, which is template-owned: ` +
        `\`biffo core upgrade\` three-way-merges it against the template on every upgrade, ` +
        `and the template has no '${names.slug}'. This checkout is a Biffo instance ` +
        `(${INSTANCE_CORE_FILE} is present), so your plugin belongs in the user-owned ` +
        `${pluginDir(names.slug, 'third-party')}/ — re-run without --first-party.`,
    )
  }

  const channel: PluginChannel = options.firstParty ? 'first-party' : 'third-party'
  const relDir = pluginDir(names.slug, channel)
  const destDir = join(options.cwd, relDir)

  const servicesDir = join(options.cwd, 'services')
  if (!existsSync(servicesDir)) {
    throw new Error(
      `${servicesDir} does not exist — is ${options.cwd} the root of a Biffo project checkout?`,
    )
  }
  if (existsSync(destDir)) {
    throw new Error(`${relDir}/ already exists. Choose a different name, or remove it first.`)
  }

  // Resolve the skeleton the same way `sibling-create.ts` does: walk up from
  // this module (works from both `src/` in development and the built `dist/`,
  // and inside a project checkout where `cli/` sits beside `_skeletons/`), then
  // fall back to the project root — which is what covers a globally installed
  // `@biffo/cli`, whose package does not ship `_skeletons/`.
  const here = dirname(fileURLToPath(import.meta.url))
  const skeletonRoot =
    options.skeletonRoot ??
    findSkeletonRoot(here, 'plugin-template') ??
    join(options.cwd, '_skeletons', 'plugin-template')
  if (!existsSync(skeletonRoot)) {
    throw new Error(
      `Could not find the plugin skeleton (_skeletons/plugin-template/). ` +
        `Pass --skeleton <path> to point at it explicitly.`,
    )
  }

  if (options.dryRun) {
    printDryRun(names, relDir, skeletonRoot, channel)
    return
  }

  const { files, skipped } = scaffoldPlugin(skeletonRoot, destDir, names)
  log.success(`Scaffolded ${files.length} file(s) into ${relDir}/`)
  for (const { entry, reason } of skipped) {
    log.info(`Skipped ${entry} — ${reason}`)
  }

  // Validate what we just wrote, so a broken scaffold fails now rather than at
  // the user's next deploy.
  const manifestPath = join(destDir, 'biffo.plugin.json')
  const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
  if (manifest.name !== names.slug) {
    throw new Error(
      `Scaffolded manifest declares name '${manifest.name}', expected '${names.slug}'. ` +
        `The skeleton's manifest name may have diverged from 'example-plugin'.`,
    )
  }
  log.success(
    `Manifest valid — ${manifest.tables.length} table(s), ${manifest.api_routes.length} route(s)`,
  )

  if (options.commit) {
    if (!(await deps.git.isGitRepo(options.cwd))) {
      throw new Error(
        `${options.cwd} is not a git repository — biffo plugin create must be run from a Biffo project checkout.`,
      )
    }
    const commitMessage = `feat(plugins): scaffold ${names.slug} plugin`
    await deps.git.add(options.cwd, [relDir])
    await deps.git.commit(options.cwd, commitMessage)
    log.success(`Committed: ${commitMessage}`)
  }

  printNextSteps(names, relDir, channel)
}

function printDryRun(
  names: ReturnType<typeof deriveNames>,
  relDir: string,
  skeletonRoot: string,
  channel: PluginChannel,
): void {
  console.log(chalk.bold('\n  Dry run — no changes will be made\n'))
  console.log(`  Plugin:          ${names.slug}`)
  console.log(`  Channel:         ${channel}`)
  console.log(`  Would scaffold:  ${relDir}/`)
  console.log(`  From skeleton:   ${skeletonRoot}`)
  console.log(`  Python package:  ${names.pkg}   (dist: ${names.dist})`)
  console.log(`  Would commit:    feat(plugins): scaffold ${names.slug} plugin\n`)
}

function printNextSteps(
  names: ReturnType<typeof deriveNames>,
  relDir: string,
  channel: PluginChannel,
): void {
  console.log(chalk.bold('\n  Plugin scaffolded!\n'))
  console.log(`  ${relDir}/ contains a working example: one table, four CRUD routes,`)
  console.log(`  one event subscription, and a terraform/ module for its Lambda.\n`)
  console.log('  Next:')
  console.log(chalk.dim(`    1. Edit ${relDir}/biffo.plugin.json — your tables and routes`))
  console.log(chalk.dim(`    2. Edit ${relDir}/src/${names.pkg}/plugin.py — your event handlers`))
  console.log(chalk.dim(`    3. biffo plugin install --local ${relDir}`))
  console.log(
    chalk.dim('       (copies terraform/ into modules/plugins/, generates the migration)\n'),
  )
  if (channel === 'first-party') {
    log.warn(
      `${relDir}/ is template-owned: it will be distributed to every instance by ` +
        '`biffo core upgrade`, and bumping core.version is required for it (ADR-0006).',
    )
  }
}
