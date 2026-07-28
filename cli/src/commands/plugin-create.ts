import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import chalk from 'chalk'
import { Command } from 'commander'
import { GitAdapter } from '../adapters/git/index.js'
import { GitHubAdapter } from '../adapters/source-control/github/index.js'
import { resolveGithubToken } from '../lib/credentials.js'
import { workflowCheckContexts } from '../lib/workflow-check-contexts.js'
import { INSTANCE_CORE_FILE } from '../lib/core-version.js'
import { log } from '../lib/logger.js'
import { pluginDir, type PluginChannel } from '../lib/plugin-locations.js'
import { validateManifest } from '../lib/plugin-manifest.js'
import { deriveNames, findSkeletonRoot, scaffoldPlugin } from '../lib/plugin-scaffold.js'
import { restorePackagedDotfiles } from '../lib/skeleton-dotfiles.js'

export const pluginCreateCommand = new Command('create')
  .description('Scaffold a new plugin from the Biffo plugin skeleton: biffo plugin create <name>')
  .argument('<name>', 'Plugin name — lowercase kebab-case, e.g. acme-crm')
  .option(
    '--first-party',
    'Scaffold into the template-owned services/_plugins/ carve-out. Only valid in the biffo-template repo itself — see notes.',
  )
  .option(
    '--standalone',
    'Scaffold a standalone plugin repo (ADR-0003 section 2) into ./biffo-plugin-<name>/ instead of into this checkout, keeping its own CI/CD workflows',
  )
  .option(
    '--org <org>',
    'With --standalone, also create the GitHub repo under this org (or user), push, and protect dev',
  )
  .option(
    '--runner-label <label>',
    'With --org, the RUNNER_LABEL the new repo\u2019s CI should run on (defaults to mirroring this checkout\u2019s)',
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
        standalone?: boolean
        org?: string
        runnerLabel?: string
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
            standalone: options.standalone ?? false,
            ...(options.org ? { org: options.org } : {}),
            ...(options.runnerLabel ? { runnerLabel: options.runnerLabel } : {}),
            ...(options.skeleton ? { skeletonRoot: resolve(options.skeleton) } : {}),
            dryRun: options.dryRun ?? false,
            commit: options.commit !== false,
            cwd,
          },
          {
            git: new GitAdapter(),
            makeGitHub: (token: string) => new GitHubAdapter(token),
            resolveToken: resolveGithubToken,
          },
        )
      } catch (err) {
        log.error((err as Error).message)
        process.exit(1)
      }
    },
  )

export interface PluginCreateDeps {
  git: GitAdapter
  /**
   * Only needed for `--standalone --org`. Injected rather than constructed
   * inline so the remote path is unit-testable without a GitHub token, and so
   * a purely local scaffold never resolves credentials it does not use.
   */
  makeGitHub?: (token: string) => StandaloneGitHub
  resolveToken?: () => Promise<string>
}

/** The slice of GitHubAdapter the standalone remote path needs. */
export interface StandaloneGitHub {
  createEmptyRepo(org: string, repo: string, description?: string): Promise<string>
  setDefaultBranch(org: string, repo: string, branch: string): Promise<void>
  protectSingleBranch(
    org: string,
    repo: string,
    branch: string,
    statusChecks: string[],
  ): Promise<void>
  setRepoVariable(org: string, repo: string, name: string, value: string): Promise<void>
  getRepoVariable(org: string, repo: string, name: string): Promise<string | undefined>
  repoRunnerCount(org: string, repo: string): Promise<number | null>
}

export interface PluginCreateOptions {
  firstParty: boolean
  /** Scaffold the standalone-repo authoring shape rather than into this checkout (#803). */
  standalone: boolean
  /** With `standalone`, the GitHub org (or user) to create the repo under (#803). */
  org?: string
  /** With `org`, the RUNNER_LABEL to set on the new repo. Mirrored when omitted. */
  runnerLabel?: string
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
 * instance marker `check-release-subject.ts` uses.
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

  if (options.standalone) {
    if (options.firstParty) {
      throw new Error(
        '--standalone and --first-party are opposites: --first-party authors a plugin *inside* ' +
          'the template at services/_plugins/, while --standalone authors one in its own ' +
          'repository (ADR-0003 section 2). Pick one.',
      )
    }
    await runStandaloneCreate(names, options, deps)
    return
  }

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
  // this module. That covers development from `src/`, the built `dist/`, a
  // project checkout where `cli/` sits beside `_skeletons/`, and an installed
  // package (prepack copies `_skeletons/` in beside `dist/` — see
  // `cli/scripts/packaged-root-assets.mjs`; before #315 it did not, and this
  // command depended on the cwd fallback below to work at all).
  //
  // The fallback to `<cwd>/_skeletons/` remains, because unlike `biffo init`
  // this command only ever runs from inside a Biffo project checkout, where that
  // path is a legitimate source. The explicit existsSync check below means a
  // miss is still reported as a missing skeleton rather than silently scaffolding
  // from nothing.
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
  // See skeleton-dotfiles.ts — npm strips .gitignore from the tarball, so the
  // packaged skeleton carries `_gitignore`. No-op from a template checkout.
  restorePackagedDotfiles(destDir)
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

/**
 * Scaffold the *authoring* shape: a standalone plugin repository (ADR-0003
 * section 2).
 *
 * ## Why this exists
 *
 * ADR-0003 makes standalone repos the designed model — goal 1 is "allow plugins
 * to live in separate repositories, maintaining independent lifecycles and
 * versioning", section 2 specifies a per-plugin repo whose standardised layout
 * includes `.github/workflows/` for an independent CI/CD pipeline, and
 * `biffo plugin install` consumes a plugin by cloning the registry entry's
 * `repo` URL. Yet until #803 no command emitted that shape: `plugin create`
 * only ever scaffolded *in-tree*, dropping exactly the standalone-only files.
 *
 * The consequence was that the skeleton's own workflows were maintained and
 * delivered by nothing, and every real plugin repo was assembled by hand — the
 * same class of silent drift as #243 and #325, where the template maintains a
 * path with no distribution channel.
 *
 * ## What it deliberately does not do
 *
 * It does not create the GitHub repository. That needs branch protection scoped
 * to `dev` alone — a plugin repo is non-deployable and has no staging/main
 * (AGENTS.md section 2) — whereas `configureBranchProtection` protects all three
 * for a deployable instance. Automating it correctly is its own change; the
 * next steps below print the exact commands meanwhile.
 */
async function runStandaloneCreate(
  names: ReturnType<typeof deriveNames>,
  options: PluginCreateOptions,
  deps: PluginCreateDeps,
): Promise<void> {
  // `names.dist` is already the biffo-plugin-<slug> convention every existing
  // plugin repo follows, so the directory matches the repo it becomes.
  const destDir = join(options.cwd, names.dist)

  if (existsSync(destDir)) {
    throw new Error(`${names.dist}/ already exists. Choose a different name, or remove it first.`)
  }

  const skeletonRoot = resolveSkeletonRoot(options)

  if (options.dryRun) {
    console.log(chalk.bold('\n  Dry run — no changes will be made\n'))
    console.log(`  Plugin:          ${names.slug}`)
    console.log('  Channel:         standalone repo')
    console.log(`  Would scaffold:  ${names.dist}/`)
    console.log(`  From skeleton:   ${skeletonRoot}`)
    console.log(`  Python package:  ${names.pkg}   (dist: ${names.dist})`)
    console.log('  Would git init:  yes, on branch dev, with an initial commit\n')
    return
  }

  const { files } = scaffoldPlugin(skeletonRoot, destDir, names, { layout: 'standalone' })
  restorePackagedDotfiles(destDir)
  log.success(`Scaffolded ${String(files.length)} file(s) into ${names.dist}/`)

  const manifest = validateManifest(
    JSON.parse(readFileSync(join(destDir, 'biffo.plugin.json'), 'utf8')),
  )
  if (manifest.name !== names.slug) {
    throw new Error(
      `Scaffolded manifest declares name '${manifest.name}', expected '${names.slug}'. ` +
        `The skeleton's manifest name may have diverged from 'example-plugin'.`,
    )
  }
  log.success(
    `Manifest valid — ${String(manifest.tables.length)} table(s), ${String(manifest.api_routes.length)} route(s)`,
  )

  if (options.commit) {
    // A NEW repo in destDir — never a commit into whatever checkout the user
    // happened to run this from, which is what the in-tree path does.
    await deps.git.init(destDir)
    await deps.git.add(destDir, ['.'])
    await deps.git.commit(destDir, `feat: scaffold ${names.slug} plugin`)
    log.success(`Initialised a git repo on dev with an initial commit`)
  }

  if (options.org !== undefined && options.org !== '') {
    if (!options.commit) {
      throw new Error(
        '--org needs a commit to push. Drop --no-commit, or create the repo yourself using the ' +
          'steps printed by a --no-commit run.',
      )
    }
    await createAndPushStandaloneRepo(options.org, names, destDir, options, deps)
    return
  }

  printStandaloneNextSteps(names, minorOf(manifest.version))
}

/**
 * Create the GitHub repo for a freshly scaffolded standalone plugin, push it,
 * and protect `dev` (#803).
 *
 * ## Why not `configureBranchProtection`
 *
 * That path is for **deployable** repos: it protects `dev`, `staging` and
 * `main` with the core workflow's job names. A plugin repo is non-deployable
 * and has `dev` only (AGENTS.md §2), and its checks are its own CI's job names.
 * Reusing it would wait two minutes each for two branches that will never
 * exist, then require checks that are never reported — protection that reads as
 * configured while blocking every PR for ever.
 *
 * The required contexts are read from the workflow **the scaffold just wrote**,
 * so they cannot drift from the CI they gate. If they cannot be determined the
 * repo is still created and pushed, and protection is skipped loudly — a
 * half-made repo is worse than an unprotected one, and the next steps say what
 * to run.
 */
async function createAndPushStandaloneRepo(
  org: string,
  names: ReturnType<typeof deriveNames>,
  destDir: string,
  options: PluginCreateOptions,
  deps: PluginCreateDeps,
): Promise<void> {
  if (deps.makeGitHub === undefined || deps.resolveToken === undefined) {
    throw new Error('No GitHub adapter available — cannot create a repository.')
  }

  const token = await deps.resolveToken()
  const github = deps.makeGitHub(token)

  const cloneUrl = await github.createEmptyRepo(org, names.dist, `${names.slug} — a Biffo plugin`)

  // BEFORE the push, deliberately. The push is what triggers the first CI run,
  // and `runs-on: ${{ vars.RUNNER_LABEL || 'ubuntu-latest' }}` is resolved from
  // whatever the variable is at that moment. Setting it afterwards is a race
  // that is only ever won by the API call being faster than GitHub's dispatcher
  // — and losing it sends the first run to hosted runners, which is the exact
  // billing failure this exists to prevent.
  await propagateRunnerLabel(org, names.dist, options, deps, github)

  await deps.git.addRemote(destDir, 'origin', cloneUrl)
  await deps.git.push(destDir, 'dev', { token })
  log.success(`Pushed dev to ${org}/${names.dist}`)

  await github.setDefaultBranch(org, names.dist, 'dev')

  const ciPath = join(destDir, '.github', 'workflows', 'ci.yml')
  const contexts = existsSync(ciPath) ? workflowCheckContexts(readFileSync(ciPath, 'utf8')) : []

  if (contexts.length === 0) {
    log.warn(
      `Could not determine required status checks from ${ciPath} — skipping branch protection. ` +
        'Configure it manually on dev once you know the CI job names.',
    )
  } else {
    await github.protectSingleBranch(org, names.dist, 'dev', contexts)
  }

  printStandaloneRemoteNextSteps(names, org)
}

/**
 * Give the new repo a runner to run on (#803 follow-up).
 *
 * ## Why this is not optional
 *
 * The skeleton's workflows run on `${{ vars.RUNNER_LABEL || 'ubuntu-latest' }}`.
 * A brand-new repo has no such variable, so it falls back to GitHub-hosted
 * runners — and where the account's hosted-Actions minutes are exhausted, every
 * job fails before it starts:
 *
 *     The job was not started because recent account payments have failed
 *     or your spending limit needs to be increased
 *
 * On its own that is merely broken CI. Combined with the branch protection this
 * command has just configured, it is worse: protection requires those exact
 * jobs, so **every PR on the new repo is blocked for ever** by checks that can
 * never report. Observed end to end on a real repo before this was added.
 *
 * `sibling create` already solves the same problem the same way
 * (`sibling-create.ts`, "Mirror the core project's RUNNER_LABEL"). The value is
 * fleet-specific — `biffo` and `tabsii` are both in use — so it is read from the
 * checkout this command runs in rather than hardcoded, and `--runner-label`
 * overrides.
 *
 * Best-effort, and loud when it cannot: a repo that exists with an unset label
 * is fixable in one command, whereas aborting here would strand a repo that has
 * already been created and pushed.
 */
async function propagateRunnerLabel(
  org: string,
  repo: string,
  options: PluginCreateOptions,
  deps: PluginCreateDeps,
  github: StandaloneGitHub,
): Promise<void> {
  try {
    let label = options.runnerLabel?.trim()

    if (!label) {
      const source = await currentRepoSlug(options.cwd, deps)
      if (source) {
        label = (await github.getRepoVariable(source.org, source.repo, 'RUNNER_LABEL'))?.trim()
      }
    }

    if (!label) {
      log.warn(
        `No RUNNER_LABEL set on ${org}/${repo} — its CI will use GitHub-hosted runners. ` +
          `If this account routes CI to a self-hosted fleet, every job will fail before it ` +
          `starts, and the branch protection just configured will block every PR on checks ` +
          `that never report. Fix with: gh variable set RUNNER_LABEL --repo ${org}/${repo}`,
      )
      return
    }

    await github.setRepoVariable(org, repo, 'RUNNER_LABEL', label)
    log.success(`RUNNER_LABEL=${label} set on ${org}/${repo}`)

    // Pointing at a fleet is not the same as being able to reach it. Until the
    // fleet's GitHub App is granted access to this repo it sees no runners, and
    // every job queues for ever with NO error (biffo-runners#2) — which, under
    // the branch protection this command applies, blocks every PR just as
    // surely as the billing wall did. Observed on a real new repo: 0 runners
    // here, 3 on an established repo in the same fleet.
    const runners = await github.repoRunnerCount(org, repo)
    if (runners === 0) {
      log.warn(
        `${org}/${repo} points at the '${label}' runner fleet but can see 0 runners. ` +
          `Jobs will queue indefinitely with no error until the fleet's GitHub App is granted ` +
          `access to this repo (biffo-runners#2) — and the branch protection just applied will ` +
          `block every PR until then.`,
      )
    }
  } catch (err: unknown) {
    log.warn(
      `Could not set RUNNER_LABEL on ${org}/${repo}: ${(err as Error).message}. ` +
        `Set it manually if this account uses self-hosted runners.`,
    )
  }
}

/** `owner/repo` of the checkout this command is running in, if it has one. */
async function currentRepoSlug(
  cwd: string,
  deps: PluginCreateDeps,
): Promise<{ org: string; repo: string } | null> {
  try {
    const url = await deps.git.getRemoteUrl(cwd, 'origin')
    const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(url.trim())
    if (match?.[1] === undefined || match[2] === undefined) return null
    return { org: match[1], repo: match[2] }
  } catch {
    return null
  }
}

function printStandaloneRemoteNextSteps(names: ReturnType<typeof deriveNames>, org: string): void {
  console.log(chalk.bold('\n  Standalone plugin repo created!\n'))
  console.log(`  https://github.com/${org}/${names.dist}  (dev, protected)\n`)
  console.log('  Next:')
  console.log(chalk.dim(`    1. cd ${names.dist} && edit biffo.plugin.json`))
  console.log(
    chalk.dim('    2. Add it to the registry so it appears in the plugin store — either set'),
  )
  console.log(
    chalk.dim(
      '       REGISTRY_PUBLISH_TOKEN on the repo, or add it to the registry\u2019s sources.json',
    ),
  )
  console.log(
    chalk.dim(`    3. Consumers install it with: biffo plugin install ${names.slug}@<minor>\n`),
  )
}

/**
 * The `<major>.<minor>` a consumer pins with `biffo plugin install <name>@<minor>`
 * (ADR-0003 goal 4 — minor-version pinning, so upgrades stay deliberate). Read
 * from the scaffolded manifest rather than hardcoded, so bumping the skeleton's
 * version does not leave this printing a stale number.
 */
function minorOf(version: string): string {
  const match = /^(\d+)\.(\d+)/.exec(version)
  return match ? `${match[1]}.${match[2]}` : version
}

function printStandaloneNextSteps(names: ReturnType<typeof deriveNames>, minor: string): void {
  console.log(chalk.bold('\n  Standalone plugin repo scaffolded!\n'))
  console.log(`  ${names.dist}/ is a complete plugin repository: manifest, example table and`)
  console.log('  routes, terraform/ module, and its own CI, release and registry workflows.\n')
  console.log('  Next:')
  console.log(chalk.dim(`    1. cd ${names.dist} && edit biffo.plugin.json`))
  console.log(
    chalk.dim('    2. Create the repo — plugin repos are dev-only (AGENTS.md section 2):'),
  )
  console.log(chalk.dim(`         gh repo create <org>/${names.dist} --private --source=. --push`))
  console.log(
    chalk.dim('         gh api -X PATCH repos/<org>/' + names.dist + ' -f default_branch=dev'),
  )
  console.log(chalk.dim('    3. Publish it to the registry so it appears in the plugin store:'))
  console.log(chalk.dim('         see .github/workflows/publish-registry.yml in the new repo'))
  console.log(
    chalk.dim(`    4. Consumers install it with: biffo plugin install ${names.slug}@${minor}\n`),
  )
}

/**
 * Resolve the skeleton the same way the in-tree path does — see that call
 * site's comment for why the upward walk and the cwd fallback both exist.
 */
function resolveSkeletonRoot(options: PluginCreateOptions): string {
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
  return skeletonRoot
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
