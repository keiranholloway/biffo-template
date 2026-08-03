import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import chalk from 'chalk'
import { Command } from 'commander'
import { AwsAdapter } from '../adapters/cloud/aws/index.js'
import { GitAdapter } from '../adapters/git/index.js'
import { GitHubAdapter, SIBLING_STATUS_CHECKS } from '../adapters/source-control/github/index.js'
import { BiffoConfigSchema, type BiffoConfig } from '../config/schema.js'
import { SiblingConfigSchema, type SiblingConfig } from '../config/sibling-schema.js'
import { assertBuildIsFresh } from '../lib/build-freshness.js'
import { reportBranchProtectionSummary } from '../lib/branch-protection-outcome.js'
import { parseGitHubRepo } from '../lib/core-upgrade.js'
import { getLatestCoreVersion } from '../lib/core-version.js'
import { resolveGithubToken } from '../lib/credentials.js'
import { log } from '../lib/logger.js'
import { resolveRepoIds } from '../lib/oidc.js'
import {
  basePathFor,
  bucketRegionalDomain,
  displayPath,
  isRootPathPrefix,
  registryNameFor,
  RESERVED_SIBLING_NAMES,
  ROOT_SIBLING_NAME,
  serializeRegistry,
  siteBucketName,
  upsertSiblingOrigin,
  type SiblingOrigin,
} from '../lib/root-sibling.js'
import { loadProjectConfig } from '../lib/session.js'
import { setSiblingCoreIdentity } from '../lib/sibling-wiring.js'
import { restorePackagedDotfiles } from '../lib/skeleton-dotfiles.js'
import {
  deleteSiblingSession,
  loadSiblingSession,
  markSiblingStepComplete,
  saveSiblingSession,
  type CoreIdentity,
  type SiblingSession,
} from '../lib/sibling-session.js'

export const siblingCreateCommand = new Command('create')
  .description(
    'Create a standalone sibling app repository from the Biffo sibling template (ADR-0007)',
  )
  .argument('<name>', 'Sibling name; must match config.project.name')
  .requiredOption('-c, --config <path>', 'Path to a pre-filled biffo.sibling.json')
  .option('--template <path>', 'Path to sibling template (defaults to the bundled skeleton)')
  .option(
    '--root',
    `Create this sibling as the ROOT application: it serves "/" (empty path prefix) and takes the ` +
      `core distribution's default cache behaviour. Registered under the reserved name "${ROOT_SIBLING_NAME}". ` +
      '`biffo init` does this for you; use this flag only to re-create a root sibling by hand.',
  )
  .option('--dry-run', 'Validate config and print planned changes without creating anything')
  .option('--fresh', 'Ignore any saved session and start from scratch')
  .action(
    async (
      name: string,
      options: {
        config: string
        template?: string
        root?: boolean
        dryRun?: boolean
        fresh?: boolean
      },
    ) => {
      try {
        // This command creates real GitHub repos and AWS resources; never let it
        // run from a stale cli/dist (issue #190).
        assertBuildIsFresh()
        await runSiblingCreateCommand(name, {
          configPath: resolve(options.config),
          templateRoot: options.template ? resolve(options.template) : defaultSiblingTemplateRoot(),
          root: options.root === true,
          dryRun: options.dryRun === true,
          fresh: options.fresh === true,
        })
      } catch (err) {
        log.error((err as Error).message)
        process.exit(1)
      }
    },
  )

interface CommandOptions {
  configPath: string
  templateRoot: string
  root: boolean
  dryRun: boolean
  fresh: boolean
}

async function runSiblingCreateCommand(name: string, options: CommandOptions): Promise<void> {
  console.log(chalk.bold('\n  Biffo — Sibling App Creator\n'))

  const config = readSiblingConfig(options.configPath, options.root)
  if (config.project.name !== name) {
    throw new Error(
      `Sibling name '${name}' does not match config project.name '${config.project.name}'.`,
    )
  }
  assertPathPrefixIsAllowed(resolvePathPrefix(config))

  const coreConfig = resolveCoreConfig(config, options.configPath)

  if (options.dryRun) {
    printDryRun(config, coreConfig, options.templateRoot)
    return
  }

  if (!existsSync(options.templateRoot)) {
    throw new Error(`Sibling template not found at ${options.templateRoot}`)
  }

  let session: SiblingSession | null = null
  if (!options.fresh) {
    // By name, not `findLatestSiblingSession()`: the session for THIS sibling
    // is the one to resume, whether or not it happens to be the most recently
    // touched file in the directory.
    const saved = loadSiblingSession(name)
    if (saved) {
      session = saved
      console.log(
        chalk.dim(
          `  Resuming previous sibling create for ${name} ` +
            `(completed: ${saved.completedSteps.join(', ') || 'none'})\n`,
        ),
      )
    }
  }
  if (!session) {
    // Saves are monotonic (issue #316), so a stale session file for this name
    // would otherwise merge its old steps into this brand-new run. Starting
    // over means explicitly discarding what was there.
    deleteSiblingSession(name)
    session = {
      version: 1,
      config,
      awsAccountId: (config.cloud as { config: { account_id: string } }).config.account_id,
      awsRegion: (config.cloud as { config: { region: string } }).config.region,
      completedSteps: [],
      outputs: {},
    }
    saveSiblingSession(session)
  }

  const token = await resolveGithubToken(true)
  const github = new GitHubAdapter(token)
  const aws = new AwsAdapter(config)
  const coreAws = new AwsAdapter(coreConfig)
  const git = new GitAdapter()

  // `finally` for the same reason as `biffo init`: a run that aborts after the
  // GitHub step has still left a repo behind, protected or not (#715).
  try {
    await runSiblingCreate(github, aws, coreAws, git, config, session, {
      coreConfig,
      skeletonRoot: options.templateRoot,
      githubToken: token,
    })
  } finally {
    reportBranchProtectionSummary()
  }

  const { org, repo } = githubRepo(config)
  const pathPrefix = resolvePathPrefix(config)

  log.success('\nSibling repo created successfully!')
  console.log(`\n  Repository: https://github.com/${org}/${repo}`)
  console.log(`  Path:       ${displayPath(pathPrefix)}`)
  if (session.outputs.registrationPrUrl) {
    console.log(
      `  Registration PR (against ${coreConfig.project.name}): ${session.outputs.registrationPrUrl}`,
    )
  }
  console.log(
    '\n  Next steps:\n' +
      `  1. Merge the registration PR above — until it merges, baseurl.com${displayPath(pathPrefix)} won't route anywhere.\n` +
      '  2. Run `biffo deploy <env>` on the CORE project (or re-run it if already deployed). That wires\n' +
      '     this sibling automatically: the SIBLING_GITHUB_TOKEN secret, the CORE_* identity variables,\n' +
      '     and — once the registration PR has merged and the core has redeployed —\n' +
      '     PARENT_CLOUDFRONT_DISTRIBUTION_ARN. No manual variable/secret setup is needed (issue #337).\n' +
      "  3. This sibling's first Deploy has already been dispatched (step 9) — watch it rather than\n" +
      '     pushing to trigger one. If it was reported as not dispatched above, run it by hand:\n' +
      '     `gh workflow run deploy.yml --ref dev -f environment=dev`\n',
  )
}

// ─── Exported for testing ────────────────────────────────────────────────────

export interface SiblingCreateGit {
  /**
   * The committer identity git would use here — `user.name` / `user.email`,
   * either resolved. `null` for a value git cannot resolve (#737).
   */
  configuredIdentity(cwd?: string): Promise<{ name: string | null; email: string | null }>
  init(cwd: string, initialBranch?: string): Promise<void>
  addRemote(cwd: string, name: string, url: string): Promise<void>
  add(cwd: string, paths: string[]): Promise<void>
  commit(cwd: string, message: string): Promise<void>
  push(cwd: string, branch: string, opts?: { remote?: string; token?: string }): Promise<void>
  cloneForEditing(repoUrl: string, namePrefix: string, token?: string): Promise<string>
  createBranch(cwd: string, branch: string): Promise<void>
  currentBranch(cwd: string): Promise<string>
  getRemoteUrl(cwd: string, remote?: string): Promise<string>
  cleanup(dir: string): void
}

export interface SiblingCreateOptions {
  coreConfig: BiffoConfig
  skeletonRoot: string
  githubToken: string
  /**
   * Skip step 2 (resolving the core's Cognito/API identity from its deployed
   * Terraform outputs).
   *
   * Set only by `biffo init`, which creates the root application sibling in
   * the same run that creates the core repo — before the core has ever been
   * deployed, so those outputs do not exist yet and resolving them can only
   * fail. The sibling's per-environment CORE_* variables are left unset; its
   * own deploy would in any case be blocked until the core is up, and
   * `biffo sibling create` (without this option) fills them in on a re-run.
   */
  skipCoreIdentity?: boolean
  /**
   * Skip step 7 (opening a registration PR against the core project).
   *
   * Set only by `biffo init`, which has already written the registry entry
   * directly into the core repo it just created — a PR against a repo the
   * same command created moments earlier would be pure ceremony, and leaving
   * it unmerged is exactly the "created but never registered" hole teardown
   * has to paper over.
   */
  skipRegistration?: boolean
}

export async function runSiblingCreate(
  github: GitHubAdapter,
  aws: AwsAdapter,
  coreAws: AwsAdapter,
  git: SiblingCreateGit,
  config: SiblingConfig,
  session: SiblingSession,
  options: SiblingCreateOptions,
): Promise<void> {
  const totalSteps = 9
  const { org, repo } = githubRepo(config)
  const pathPrefix = resolvePathPrefix(config)

  // Before ANY step, and deliberately not inside one (#737).
  //
  // The scaffold commit happens at step 4, in a throwaway temp dir with no
  // repo-local git config. Step 3 has by then already created the GitHub
  // repository — so a missing `user.email` used to surface as git's own error
  // after the repo existed, leaving an empty repo and a half-done scaffold.
  //
  // Checked here because a resumable session makes the late failure worse rather
  // than better: `completedSteps` records the repo as created, so re-running skips
  // straight back to the same failure.
  assertGitIdentity(await git.configuredIdentity())

  // Step 1: Verify AWS credentials
  if (!session.completedSteps.includes('verify_credentials')) {
    log.step(1, totalSteps, 'Verifying AWS credentials...')
    await aws.verifyCredentials()
    markSiblingStepComplete(session, 'verify_credentials')
  } else {
    log.step(1, totalSteps, 'AWS credentials already verified — skipping')
  }

  // Step 2: Resolve the core project's identity (Cognito pool/client, API URL,
  // portal URL) — once per environment this sibling provisions, since each
  // environment has its own Cognito pool (see infra/environments/<env>/main.tf).
  if (options.skipCoreIdentity && !session.completedSteps.includes('resolve_core_identity')) {
    log.step(
      2,
      totalSteps,
      "Core project isn't deployed yet — deferring its identity (CORE_COGNITO_*, CORE_API_URL)",
    )
    // Deliberately NOT marked complete (issue #337). Marking it done here made
    // the deferral a permanent dead-end: a later `biffo sibling create` re-run
    // took the already-complete branch and never re-resolved. The authoritative
    // fix is the core's own `biffo deploy` wiring these once it is up; leaving
    // this step unrecorded ALSO lets a manual re-run resolve them for real. The
    // empty map still satisfies the invariant that the step populates it.
    session.outputs.coreIdentity = {}
  } else if (!session.completedSteps.includes('resolve_core_identity')) {
    log.step(2, totalSteps, "Resolving core project's identity...")
    session.outputs.coreIdentity = await resolveCoreIdentity(
      coreAws,
      options.coreConfig,
      config.environments,
    )
    markSiblingStepComplete(session, 'resolve_core_identity')
  } else {
    log.step(2, totalSteps, 'Core identity already resolved — skipping')
  }
  const coreIdentity = session.outputs.coreIdentity
  if (!coreIdentity) {
    throw new Error(
      'internal error: resolve_core_identity did not populate session.outputs.coreIdentity',
    )
  }

  // Step 3: Create the GitHub repo.
  //
  // Its own checkpoint, recorded the instant the repo exists — NOT shared with
  // the skeleton push below (issue #316). Sharing one checkpoint across both
  // meant a push failure (#315) left the repo created but unrecorded, so the
  // resume re-ran creation against a repo that already existed.
  if (!session.completedSteps.includes('create_repo')) {
    log.step(3, totalSteps, 'Creating GitHub repository...')
    session.outputs.cloneUrl = await github.createEmptyRepo(
      org,
      repo,
      config.project.description || undefined,
    )
    markSiblingStepComplete(session, 'create_repo')
  } else {
    log.step(3, totalSteps, 'GitHub repository already created — skipping')
  }

  // Step 4: Push the sibling skeleton as the repo's first commit.
  const cloneUrl = session.outputs.cloneUrl
  if (!cloneUrl) {
    throw new Error('internal error: create_repo did not populate session.outputs.cloneUrl')
  }
  if (!session.completedSteps.includes('push_skeleton')) {
    // A push that landed but whose checkpoint never got written would otherwise
    // come back as a non-fast-forward rejection on the retry. Commits on the
    // repo mean the skeleton is already there.
    if (await github.repoHasCommits(org, repo)) {
      log.step(4, totalSteps, 'Sibling skeleton already pushed — skipping')
    } else {
      log.step(4, totalSteps, 'Pushing sibling skeleton...')
      await pushSkeleton(
        git,
        options.skeletonRoot,
        cloneUrl,
        config,
        options.coreConfig,
        options.githubToken,
      )
    }
    markSiblingStepComplete(session, 'push_skeleton')
  } else {
    log.step(4, totalSteps, 'Sibling skeleton already pushed — skipping')
  }

  // Step 5: Set up OIDC trust between GitHub Actions and AWS
  if (!session.completedSteps.includes('oidc_trust')) {
    log.step(5, totalSteps, 'Configuring OIDC trust...')
    session.outputs.oidcRoleArn = await aws.setupOidcTrust(
      config,
      await resolveRepoIds(github, config),
    )
    markSiblingStepComplete(session, 'oidc_trust')
  } else {
    log.step(5, totalSteps, 'OIDC trust already configured — skipping')
  }

  // Step 6: Bootstrap Terraform backend
  if (!session.completedSteps.includes('terraform_backend')) {
    log.step(6, totalSteps, 'Bootstrapping Terraform state backend...')
    session.outputs.tfStateBucket = await aws.bootstrapTerraformBackend(config.project.name)
    markSiblingStepComplete(session, 'terraform_backend')
  } else {
    log.step(6, totalSteps, 'Terraform backend already bootstrapped — skipping')
  }

  // Step 7: Configure GitHub (branches, branch protection, environments, secrets, variables)
  //
  // Deliberately still ONE checkpoint after the #316 audit: every call it makes
  // is an idempotent upsert — createBranch returns early if the branch exists,
  // configureBranchProtection/createEnvironments/enableVulnerabilityAlerts are
  // PUTs, and setRepoVariable/setEnvVariable are PATCH-then-POST upserts. None
  // writes git objects, so replaying a partial run is safe and cheap.
  if (!session.completedSteps.includes('github_config')) {
    log.step(7, totalSteps, 'Configuring GitHub repository...')
    await configureSiblingGithub(github, config, options.coreConfig, session, coreIdentity)
    markSiblingStepComplete(session, 'github_config')
  } else {
    log.step(7, totalSteps, 'GitHub already configured — skipping')
  }

  // Step 8: Register this sibling with the core project for CDN path routing
  if (options.skipRegistration && !session.completedSteps.includes('register_with_core')) {
    log.step(8, totalSteps, 'Already registered with the core project by `biffo init` — skipping')
    markSiblingStepComplete(session, 'register_with_core')
  } else if (!session.completedSteps.includes('register_with_core')) {
    log.step(8, totalSteps, 'Opening a registration PR against the core project...')
    session.outputs.registrationPrUrl = await registerWithCore(
      git,
      github,
      config,
      options.coreConfig,
      pathPrefix,
      options.githubToken,
    )
    markSiblingStepComplete(session, 'register_with_core')
  } else {
    log.step(8, totalSteps, 'Already registered with the core project — skipping')
  }

  // Step 9: Dispatch the sibling's first deploy, deliberately.
  //
  // The scaffold push in step 4 carries `[skip ci]` precisely so this is the
  // FIRST Deploy run the repo ever has (#1065). Everything it needs now exists:
  // OIDC trust (5), the Terraform backend (6) and `SIBLING_DEPLOY_ENABLED` (7).
  // Dispatching here also means the run the operator is told to watch is the
  // run that actually deploys, rather than an earlier one that silently did
  // nothing.
  //
  // Best-effort: the sibling is fully provisioned by this point, so a dispatch
  // failure must not fail the whole create — but it must be said out loud
  // rather than swallowed, which is the defect class this issue belongs to.
  if (!session.completedSteps.includes('trigger_first_deploy')) {
    // The sibling's FIRST configured environment, not a hardcoded 'dev': step 7
    // creates GitHub Environments from `config.environments`, so a sibling
    // declaring only `['staging']` has no `dev` Environment to deploy into and
    // a hardcoded input would fail the run it exists to make trustworthy.
    // The `ref` is always `dev` — that is the only branch the skeleton push
    // creates — and the workflow takes its target from the input on a
    // workflow_dispatch, not from the branch.
    const firstEnvironment = config.environments[0] ?? 'dev'
    log.step(9, totalSteps, `Dispatching the first deploy (${firstEnvironment})...`)
    try {
      await github.triggerWorkflow(
        org,
        repo,
        'deploy.yml',
        { environment: firstEnvironment },
        'dev',
      )
      log.info(`  Watch it: https://github.com/${org}/${repo}/actions/workflows/deploy.yml`)
      markSiblingStepComplete(session, 'trigger_first_deploy')
    } catch (err) {
      log.warn(
        `  Could not dispatch the first deploy: ${err instanceof Error ? err.message : String(err)}`,
      )
      log.warn(
        `  Run it by hand: gh workflow run deploy.yml --repo ${org}/${repo} --ref dev -f environment=dev`,
      )
    }
  } else {
    log.step(9, totalSteps, 'First deploy already dispatched — skipping')
  }

  // See the identical call in `runInit`: the run must not end quietly with an
  // unprotected repo (#715, #737 item 2).
  reportBranchProtectionSummary()

  deleteSiblingSession(config.project.name)
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * The routing prefix this sibling serves under. `''` means the root sibling
 * (issue #306) — note `??`, not `||`: an empty prefix is a real, deliberate
 * value and must not fall back to the project name.
 */
export function resolvePathPrefix(config: SiblingConfig): string {
  return config.core.path_prefix ?? config.project.name
}

/**
 * Reject a non-root sibling trying to claim a reserved prefix.
 *
 * `admin` and `login` are the portal's own CloudFront path patterns and `app`
 * is the root sibling's reserved registry name. Claiming any of them produces
 * a duplicate `path_pattern` (or a duplicate `sibling_origins` key) and the
 * apply fails with an opaque duplicate-key error a long way from the cause —
 * `modules/cloud/aws/cdn/variables.tf` rejects it too, but by then a repo and
 * an IAM role already exist. Fail here, before anything is created.
 */
export function assertPathPrefixIsAllowed(pathPrefix: string): void {
  if (isRootPathPrefix(pathPrefix)) return
  if ((RESERVED_SIBLING_NAMES as readonly string[]).includes(pathPrefix)) {
    const extra =
      pathPrefix === ROOT_SIBLING_NAME
        ? ` "${ROOT_SIBLING_NAME}" is the root application sibling, which \`biffo init\` creates; ` +
          'pass --root to create one by hand.'
        : ` "${pathPrefix}" is one of the portal's own routes.`
    throw new Error(
      `Sibling path prefix "${pathPrefix}" is reserved (${RESERVED_SIBLING_NAMES.join(', ')}).` +
        extra,
    )
  }
}

function readSiblingConfig(path: string, root = false): SiblingConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  const withDefaults =
    raw && typeof raw === 'object' && 'project' in raw && 'core' in raw
      ? {
          ...raw,
          core: {
            ...(raw as { core: Record<string, unknown> }).core,
            // --root wins over whatever the file says: it is the whole point of
            // the flag, and a config carrying a stale non-empty prefix would
            // otherwise silently produce a path-routed sibling instead.
            path_prefix: root
              ? ''
              : ((raw as { core: { path_prefix?: unknown } }).core.path_prefix ??
                (raw as { project: { name?: unknown } }).project.name),
          },
        }
      : raw

  const result = SiblingConfigSchema.safeParse(withDefaults)
  if (!result.success) {
    throw new Error(
      'Invalid sibling configuration:\n' +
        result.error.issues
          .map((issue) => `  ${issue.path.join('.')} — ${issue.message}`)
          .join('\n'),
    )
  }
  return result.data
}

function resolveCoreConfig(config: SiblingConfig, configPath: string): BiffoConfig {
  if (config.core.config_path) {
    const corePath = resolve(dirname(configPath), config.core.config_path)
    return parseCoreConfig(corePath)
  }
  if (config.core.project_name) {
    const saved = loadProjectConfig(config.core.project_name)
    if (saved) return saved
    throw new Error(
      `Core project '${config.core.project_name}' was not found in ~/.biffo/projects. ` +
        'Set core.config_path to the core project biffo.config.json instead.',
    )
  }
  // Unreachable — SiblingConfigSchema's superRefine already requires one of these.
  throw new Error('Either core.project_name or core.config_path is required.')
}

function parseCoreConfig(path: string): BiffoConfig {
  const result = BiffoConfigSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
  if (!result.success) {
    throw new Error(
      `Invalid core configuration at ${path}:\n` +
        result.error.issues
          .map((issue) => `  ${issue.path.join('.')} — ${issue.message}`)
          .join('\n'),
    )
  }
  return result.data
}

async function resolveCoreIdentity(
  coreAws: AwsAdapter,
  coreConfig: BiffoConfig,
  environments: string[],
): Promise<Record<string, CoreIdentity>> {
  const coreAwsConfig = (
    coreConfig.cloud as {
      provider: 'aws'
      config: { account_id: string; tf_state_bucket?: string }
    }
  ).config
  const stateBucket =
    coreAwsConfig.tf_state_bucket ??
    `${coreConfig.project.name}-terraform-state-${coreAwsConfig.account_id}`

  const coreIdentity: Record<string, CoreIdentity> = {}
  for (const env of environments) {
    const stateKey = `${env}/terraform.tfstate`
    log.info(`Reading ${coreConfig.project.name}'s Terraform outputs for ${env}...`)
    const outputs = await coreAws.readTerraformOutputs(stateBucket, stateKey)

    for (const key of [
      'cognito_user_pool_id',
      'cognito_client_id',
      'api_gateway_url',
      'portal_url',
    ]) {
      if (!outputs[key]) {
        throw new Error(
          `${key} not found in ${coreConfig.project.name}'s Terraform outputs for ${env}. ` +
            `Has the core project been deployed to ${env}? Run \`biffo deploy ${env}\` from the core project first.`,
        )
      }
    }

    coreIdentity[env] = {
      cognitoUserPoolId: outputs['cognito_user_pool_id']!,
      cognitoClientId: outputs['cognito_client_id']!,
      apiUrl: outputs['api_gateway_url']!,
      portalUrl: outputs['portal_url']!,
    }
  }
  return coreIdentity
}

async function pushSkeleton(
  git: SiblingCreateGit,
  skeletonRoot: string,
  cloneUrl: string,
  config: SiblingConfig,
  coreConfig: BiffoConfig,
  githubToken: string,
): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), `biffo-sibling-${config.project.name}-`))
  try {
    writeSiblingTemplate(skeletonRoot, workDir, config, {
      coreProjectName: coreConfig.project.name,
      pathPrefix: resolvePathPrefix(config),
      // The core template's version at scaffold time (issue #567) — visibility
      // only, mirroring how `biffo init` stamps `biffo.core.json`. See the
      // `template_version` field doc on `SiblingMarker` (lib/sibling-teardown.ts).
      templateVersion: getLatestCoreVersion(),
    })
    await git.init(workDir, 'dev')
    await git.addRemote(workDir, 'origin', cloneUrl)
    await git.add(workDir, ['.'])
    // `[skip ci]` is deliberate. This push lands on `dev`, which is a trigger
    // branch for the skeleton's own Deploy workflow — but OIDC trust (step 5),
    // the Terraform backend (step 6) and `SIBLING_DEPLOY_ENABLED` (step 7) do
    // not exist yet, so the run cannot deploy anything whatever it does.
    //
    // It used to fire anyway, evaluate `if: vars.SIBLING_DEPLOY_ENABLED ==
    // 'true'` against an unset (empty) variable, skip both deploy jobs and
    // conclude **success** — so every sibling was born with a green Deploy run
    // that had created nothing, and nothing distinguished it from a real one
    // (#1065). Suppressing the run is the fix rather than racing to set the
    // variable first: the deploy genuinely cannot succeed until steps 5-7 have
    // run, so an earlier variable would only convert a false green into a real
    // failure. Step 9 dispatches the deploy deliberately once it can work.
    await git.commit(
      workDir,
      `feat: scaffold ${config.project.name} sibling app (ADR-0007)\n\n[skip ci]`,
    )
    await git.push(workDir, 'dev', { token: githubToken })
  } finally {
    git.cleanup(workDir)
  }
}

/**
 * Copies the sibling skeleton into `targetDir` and rewrites the two files
 * that need real, per-sibling values baked in: `biffo.sibling.json` (its own
 * identity) and, for local-dev convenience only, `apps/frontend/.env.example`
 * (real CI/deploy values are wired separately, as GitHub Environment
 * variables — see configureSiblingGithub — since Next.js inlines
 * NEXT_PUBLIC_* at build time from the CI runner's env, not from this file).
 */
export function writeSiblingTemplate(
  templateRoot: string,
  targetDir: string,
  config: SiblingConfig,
  context: {
    coreProjectName: string
    pathPrefix: string
    /**
     * The core template's version this sibling is being scaffolded from
     * (issue #567) — typically `getLatestCoreVersion()`. Stamped into
     * `biffo.sibling.json` for drift *visibility* only: it does not power any
     * upgrade mechanism today (see `SiblingMarker.template_version` in
     * `lib/sibling-teardown.ts`).
     */
    templateVersion: string
  },
): void {
  if (!existsSync(templateRoot)) {
    throw new Error(`Sibling template not found at ${templateRoot}`)
  }
  cpSync(templateRoot, targetDir, { recursive: true })
  // npm strips .gitignore from published tarballs, so the packaged skeleton
  // carries it as `_gitignore`. Without this the scaffolded repo's first commit
  // could include node_modules/, .terraform/ and .env — see skeleton-dotfiles.ts.
  restorePackagedDotfiles(targetDir)

  writeFileSync(
    join(targetDir, 'biffo.sibling.json'),
    JSON.stringify(
      {
        name: config.project.name,
        core_project: context.coreProjectName,
        path_prefix: context.pathPrefix,
        // Visibility only (issue #567) — see SiblingMarker.template_version.
        template_version: context.templateVersion,
        ...(config.project.description ? { description: config.project.description } : {}),
        // Always written (even when empty) so the field is discoverable — declare
        // this sibling's notable routes here and they surface on the core's
        // Microservices tab. See SiblingConfigSchema.project.routes.
        routes: config.project.routes,
      },
      null,
      2,
    ) + '\n',
  )

  const envPath = join(targetDir, 'apps', 'frontend', '.env.example')
  try {
    // `basePathFor`, not `/${prefix}` — the root sibling's basePath is the
    // empty string, and Next.js refuses to build with a basePath of "/".
    const path = basePathFor(context.pathPrefix)
    const content = readFileSync(envPath, 'utf8')
      .replace(/^NEXT_PUBLIC_SIBLING_NAME=.*$/m, `NEXT_PUBLIC_SIBLING_NAME=${config.project.name}`)
      .replace(/^NEXT_PUBLIC_SIBLING_PATH_PREFIX=.*$/m, `NEXT_PUBLIC_SIBLING_PATH_PREFIX=${path}`)
      .replace(/^NEXT_PUBLIC_BASE_PATH=.*$/m, `NEXT_PUBLIC_BASE_PATH=${path}`)
    writeFileSync(envPath, content)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

async function configureSiblingGithub(
  github: GitHubAdapter,
  config: SiblingConfig,
  coreConfig: BiffoConfig,
  session: SiblingSession,
  coreIdentity: Record<string, CoreIdentity>,
): Promise<void> {
  const { org, repo } = githubRepo(config)

  // `dev` (the integration branch, #559) is already the repo's first pushed
  // branch (see pushSkeleton). Cut `staging` and `main` off it as promotion
  // targets (`main` = production, reserved until a prod environment is built),
  // regardless of which environments this sibling provisions — config.environments
  // only controls GitHub *Environments* and per-env variables below, not the
  // branch structure itself.
  await github.createBranch(org, repo, 'staging', 'dev')
  await github.createBranch(org, repo, 'main', 'dev')
  await github.setDefaultBranch(org, repo, 'dev')

  // SIBLING_STATUS_CHECKS, not the default: a sibling ships an E2E harness and
  // an instance does not, so this is where the extra required context belongs
  // (#1208). Requiring it on an instance would hang every PR on a job the
  // template's ci.yml has no equivalent of.
  await github.configureBranchProtection(config, undefined, SIBLING_STATUS_CHECKS)
  await github.createEnvironments(config)
  // Bind it to admins as well (#1058). A sibling is a full deployable repo with
  // the same three branches, so leaving it advisory would reintroduce the
  // estate's #1052 state one sibling at a time — and siblings are the commonest
  // thing this estate creates. Safe here rather than needing to be last: the
  // sibling's only git write is `pushSkeleton`, which has already happened by
  // the time this function runs, and everything below is repo settings.
  await github.sealBranchProtection(org, repo)

  // Native GitHub security parity with the core project: Dependabot alerts
  // (the sibling skeleton ships the CI scanners + CodeQL + Renovate).
  await github.enableVulnerabilityAlerts(org, repo)

  await github.setRepoVariable(org, repo, 'PROJECT_NAME', config.project.name)
  // Deliberately separate from PROJECT_NAME: the routing path segment
  // (baseurl.com/<PATH_PREFIX>/*) can differ from the sibling's own
  // project/repo name (e.g. project "tabsii-crm" routed at "/crm") — the
  // deploy workflow's S3 sync destination, Next.js basePath, and CDN
  // invalidation paths must all use this, not PROJECT_NAME, or the built
  // site ends up uploaded/rewritten under a prefix CloudFront never
  // routes to.
  // Empty for the root sibling. The skeleton's deploy.yml treats an empty
  // PATH_PREFIX as "serve from the bucket root" throughout (basePath, S3 sync
  // destination, CloudFront invalidation) rather than producing "/", "//" and
  // "//*", each of which is wrong in its own way.
  //
  // GitHub's Actions variables API rejects an empty value with a 422
  // ("Variable value cannot be empty"), so the root sibling's prefix cannot be
  // *stored* — only left unset (issue #319). That is exactly equivalent for
  // every consumer: GitHub evaluates an unset `vars.X` to the empty string, so
  // `${{ vars.PATH_PREFIX }}` yields '' either way. Do NOT substitute a
  // sentinel like '/' or 'root' — see the note above for why '/' is wrong, and
  // a sentinel would have to be decoded in every consumer.
  const pathPrefix = resolvePathPrefix(config)
  if (pathPrefix !== '') {
    await github.setRepoVariable(org, repo, 'PATH_PREFIX', pathPrefix)
  }
  await github.setRepoVariable(org, repo, 'AWS_REGION', awsConfig(config).region)
  await github.setRepoVariable(org, repo, 'SIBLING_DEPLOY_ENABLED', 'true')

  // Mirror the core project's RUNNER_LABEL (if any) onto the sibling. The
  // skeleton workflows run on `${{ vars.RUNNER_LABEL || 'ubuntu-latest' }}`, so
  // when the core project routes CI to a self-hosted runner fleet (e.g. because
  // its GitHub plan's hosted-Actions minutes are exhausted), the sibling must do
  // the same or every one of its jobs fails at the billing wall. This value is
  // org/project-specific, so it's read from the core repo at create-time rather
  // than hardcoded. Absent/empty on the core repo → leave it unset so the
  // sibling keeps the generic `ubuntu-latest` default. Best-effort: a failure to
  // read the core variable must not abort provisioning.
  try {
    const { org: coreOrg, repo: coreRepo } = (
      coreConfig.source_control as { provider: 'github'; config: { org: string; repo: string } }
    ).config
    const runnerLabel = await github.getRepoVariable(coreOrg, coreRepo, 'RUNNER_LABEL')
    if (runnerLabel && runnerLabel.trim()) {
      await github.setRepoVariable(org, repo, 'RUNNER_LABEL', runnerLabel)
    }
  } catch (err: unknown) {
    log.warn(
      `Could not propagate RUNNER_LABEL from the core project to ${org}/${repo}: ` +
        `${(err as Error).message}. The sibling will default to ubuntu-latest runners.`,
    )
  }

  if (session.outputs.tfStateBucket) {
    await github.setRepoVariable(org, repo, 'TF_STATE_BUCKET', session.outputs.tfStateBucket)
  }

  // When the core is already deployed (the manual `biffo sibling create` path),
  // set each environment's CORE_* identity + CORS. On the `biffo init` deferred
  // path coreIdentity is empty and nothing is set here — the core's own
  // `biffo deploy` fills these in (plus PARENT_CLOUDFRONT_*) once it is up,
  // via wireSiblingsAfterCoreDeploy (issue #337).
  for (const env of config.environments) {
    const identity = coreIdentity[env]
    if (!identity) continue
    await setSiblingCoreIdentity(github, org, repo, env, identity)
  }

  if (session.outputs.oidcRoleArn) {
    await github.setRepoSecret(org, repo, 'SIBLING_OIDC_ROLE_ARN', session.outputs.oidcRoleArn)
  }
}

/**
 * Reads siblings.auto.tfvars.json if present. Reads directly and catches
 * ENOENT rather than checking existsSync first — an existence check
 * followed by a separate read is a TOCTOU race (the file could be removed
 * in between), even though in practice nothing else touches this freshly
 * cloned temp directory.
 */
function readExistingSiblingOrigins(filePath: string): { sibling_origins?: SiblingOrigin[] } {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as { sibling_origins?: SiblingOrigin[] }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

/**
 * Pre-flight (issue #151): a sibling only actually routes if the core project's
 * `modules/cloud/aws/cdn` supports ADR-0007's `sibling_origins` (origin +
 * ordered_cache_behavior dynamic blocks, PR #120). A core that hasn't run
 * `biffo core upgrade` to a template version with it would still merge the
 * registration PR cleanly and report a green deploy — but CloudFront would never
 * gain the origin/behavior, so the failure is completely silent. Check the
 * capability directly (rather than inferring from a version number that can
 * drift) and fail with an actionable message before writing anything.
 */
/**
 * Pre-flight (issue #737): `git commit` needs a committer identity, and the
 * scaffold commits in a throwaway temp dir where no repo-local config exists.
 *
 * Without this the run fails at step 4 — **after** step 3 has already created the
 * GitHub repository — with git's own message about setting `user.email`. The
 * founder is then left with an empty repo, a half-finished scaffold, and an error
 * that names neither. That sequence is the "onboarding tax" this issue is about:
 * the cost is not the missing config, it is discovering it too late to be cheap.
 *
 * So it is checked before anything is created, and the message says what to run.
 *
 * @param identity what git resolves for the committer
 */
export function assertGitIdentity(identity: { name: string | null; email: string | null }): void {
  const missing = [identity.name ? null : 'user.name', identity.email ? null : 'user.email'].filter(
    (v): v is string => v !== null,
  )
  if (missing.length === 0) return
  throw new Error(
    `git has no ${missing.join(' or ')} configured, so the scaffold commit would fail ` +
      `after the GitHub repository had already been created. Set it first:\n` +
      missing
        .map(
          (k) =>
            `  git config --global ${k} "${k === 'user.name' ? 'Your Name' : 'you@example.com'}"`,
        )
        .join('\n'),
  )
}

export function assertCoreSupportsSiblingRouting(
  cloneDir: string,
  coreRepo: string,
  pathPrefix = 'x',
): void {
  const cdnVarsPath = join(cloneDir, 'modules', 'cloud', 'aws', 'cdn', 'variables.tf')
  let declaresSiblingOrigins = false
  try {
    declaresSiblingOrigins = /variable\s+"sibling_origins"/.test(readFileSync(cdnVarsPath, 'utf8'))
  } catch {
    declaresSiblingOrigins = false
  }
  if (!declaresSiblingOrigins) {
    throw new Error(
      `The core project "${coreRepo}" doesn't support sibling CDN routing yet ` +
        `(its modules/cloud/aws/cdn predates ADR-0007). Run \`biffo core upgrade\` ` +
        `against it first, then re-run \`biffo sibling create\`.`,
    )
  }

  // The root sibling needs strictly more than sibling routing: it needs a core
  // whose default_cache_behavior follows the "app" origin (issue #306). An
  // older core would merge the registration cleanly, gain the origin, and
  // route nothing to it — the same silent failure this function already exists
  // to prevent, one layer up.
  if (!isRootPathPrefix(pathPrefix)) return
  const cdnMainPath = join(cloneDir, 'modules', 'cloud', 'aws', 'cdn', 'main.tf')
  let supportsRoot = false
  try {
    supportsRoot = /root_sibling_registered/.test(readFileSync(cdnMainPath, 'utf8'))
  } catch {
    supportsRoot = false
  }
  if (!supportsRoot) {
    throw new Error(
      `The core project "${coreRepo}" doesn't support a ROOT application sibling yet ` +
        `(its modules/cloud/aws/cdn default_cache_behavior still can't follow the ` +
        `"${ROOT_SIBLING_NAME}" origin — issue #306). Run \`biffo core upgrade\` against it ` +
        `first, then re-run with --root.`,
    )
  }
}

async function registerWithCore(
  git: SiblingCreateGit,
  github: GitHubAdapter,
  config: SiblingConfig,
  coreConfig: BiffoConfig,
  pathPrefix: string,
  githubToken: string,
): Promise<string> {
  const { org: coreOrg, repo: coreRepo } = (
    coreConfig.source_control as { provider: 'github'; config: { org: string; repo: string } }
  ).config
  const coreCloneUrl = `https://github.com/${coreOrg}/${coreRepo}.git`
  const coreAwsRegion = awsConfig(coreConfig).region
  const siblingAccountId = (config.cloud as { provider: 'aws'; config: { account_id: string } })
    .config.account_id

  const cloneDir = await git.cloneForEditing(
    coreCloneUrl,
    `biffo-sibling-register-${config.project.name}`,
    githubToken,
  )
  // The registry key. NEVER the path prefix directly: the root sibling's
  // prefix is "" and an empty `sibling_origins[].name` would make it
  // undiscoverable to teardown's collectSiblings() — a leaked repo, a leaked
  // bucket, and a bill (lib/root-sibling.ts).
  const name = registryNameFor(pathPrefix)

  try {
    assertCoreSupportsSiblingRouting(cloneDir, coreRepo, pathPrefix)

    const base = await git.currentBranch(cloneDir)
    const branch = `biffo/register-sibling-${config.project.name}`.replace(/[^a-zA-Z0-9._/-]/g, '-')
    await git.createBranch(cloneDir, branch)

    const touchedFiles: string[] = []
    for (const env of config.environments) {
      const bucketName = siteBucketName(config.project.name, env, siblingAccountId)
      const domain = bucketRegionalDomain(bucketName, coreAwsRegion)
      const relativePath = join('infra', 'environments', env, 'siblings.auto.tfvars.json')
      const filePath = join(cloneDir, relativePath)

      const existing = readExistingSiblingOrigins(filePath)
      // description and routes feed the portal's Microservices tab (built into
      // siblings.json at deploy time). Both omitted when empty, to keep entries
      // lean; Terraform silently drops these extra attributes (the sibling_origins
      // variable is typed to name + bucket only), so they're display-only.
      const siblings = upsertSiblingOrigin(existing.sibling_origins ?? [], {
        name,
        bucket_regional_domain: domain,
        ...(config.project.description ? { description: config.project.description } : {}),
        ...(config.project.routes.length > 0 ? { routes: config.project.routes } : {}),
      })

      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, serializeRegistry(siblings))
      touchedFiles.push(relativePath)
    }

    await git.add(cloneDir, touchedFiles)
    await git.commit(
      cloneDir,
      isRootPathPrefix(pathPrefix)
        ? `infra(cdn): register root application sibling "${name}" at / (ADR-0007)`
        : `infra(cdn): register sibling "${name}" for path-based routing (ADR-0007)`,
    )
    await git.push(cloneDir, branch, { token: githubToken })

    const remoteUrl = await git.getRemoteUrl(cloneDir)
    const { owner, repo } = parseGitHubRepo(remoteUrl)
    const pr = await github.createPullRequest({
      owner,
      repo,
      head: branch,
      base,
      title: isRootPathPrefix(pathPrefix)
        ? `Register root application sibling "${name}" at / (ADR-0007)`
        : `Register sibling "${name}" for CDN routing (ADR-0007)`,
      body: buildRegistrationPrBody(config, pathPrefix, touchedFiles),
    })
    return pr.url
  } finally {
    git.cleanup(cloneDir)
  }
}

function buildRegistrationPrBody(
  config: SiblingConfig,
  pathPrefix: string,
  touchedFiles: string[],
): string {
  const { org, repo } = githubRepo(config)
  return [
    'Automated sibling registration generated by `biffo sibling create` (ADR-0007).',
    '',
    isRootPathPrefix(pathPrefix)
      ? `Adds **${org}/${repo}** to this project's CloudFront distribution as the ROOT application origin ` +
        `(reserved name \`${ROOT_SIBLING_NAME}\`, empty path prefix) — once merged and redeployed, the ` +
        `distribution's \`default_cache_behavior\` targets that sibling's own S3 bucket, so \`baseurl.com/\` ` +
        'and everything not claimed by an explicit behaviour (`/admin*`, `/login*`, other siblings) routes ' +
        "there. That includes `/_next/*`, which the portal vacated by setting `assetPrefix: '/admin'`."
      : `Adds **${org}/${repo}** to this project's CloudFront distribution as a new path-routed origin — ` +
        `once merged and redeployed, \`baseurl.com/${pathPrefix}/*\` routes to that sibling's own S3 bucket.`,
    '',
    `## Files changed (${touchedFiles.length})`,
    '',
    ...touchedFiles.map((f) => `- \`${f}\``),
    '',
    '## After merging',
    '',
    "This sibling's own S3 bucket policy still needs this distribution's real ARN " +
      '(a two-phase handshake — see the sibling repo\'s README, "The two-phase CDN registration"). ' +
      'Once this PR merges and this project redeploys, set `PARENT_CLOUDFRONT_DISTRIBUTION_ARN` on the ' +
      'sibling repo and re-run its deploy workflow.',
  ].join('\n')
}

function printDryRun(config: SiblingConfig, coreConfig: BiffoConfig, templateRoot: string): void {
  const { org, repo } = githubRepo(config)
  const pathPrefix = resolvePathPrefix(config)
  console.log(chalk.bold('\n  Dry run — no changes will be made\n'))
  console.log(`  Sibling:       ${config.project.name}`)
  console.log(`  Repository:    ${org}/${repo}`)
  console.log(`  Core project:  ${coreConfig.project.name}`)
  console.log(
    `  Path prefix:   ${displayPath(pathPrefix)}` +
      (isRootPathPrefix(pathPrefix)
        ? ` (ROOT application — registered as "${ROOT_SIBLING_NAME}", takes the CDN default behaviour)`
        : ''),
  )
  console.log(`  Environments:  ${config.environments.join(', ')}`)
  console.log(`  Template:      ${templateRoot}`)
  console.log('\n  Would:')
  console.log("    - resolve the core project's Cognito/API identity for each environment")
  console.log('    - create an empty private sibling GitHub repository')
  console.log('    - copy and rewrite _skeletons/sibling-template into the repo')
  console.log('    - push main, create dev/staging, and set dev as default')
  console.log('    - create AWS OIDC trust and a Terraform state bucket')
  console.log('    - configure repository secrets, variables, environments, and branch protection')
  console.log('    - open a PR against the core project to register this sibling for CDN routing\n')
}

function githubRepo(config: SiblingConfig): { org: string; repo: string } {
  return (config.source_control as { provider: 'github'; config: { org: string; repo: string } })
    .config
}

function awsConfig(config: SiblingConfig | BiffoConfig): { region: string } {
  return (config.cloud as { provider: 'aws'; config: { region: string } }).config
}

/**
 * Locate `_skeletons/sibling-template` by walking up from this module.
 *
 * Two arrangements satisfy the single walk: a template checkout (`cli/dist/` or
 * `cli/src/` walks up to the repo root) and an installed package (prepack copies
 * `_skeletons/` in beside `dist/` — see `cli/scripts/packaged-root-assets.mjs`).
 *
 * There is deliberately no `process.cwd()` fallback. It used to return
 * `<cwd>/_skeletons/sibling-template` unconditionally, so when the package
 * shipped without the skeleton at all — which it did, up to 0.39.0 — `biffo
 * init` created both repos and then failed at step 6/6 naming a path under the
 * user's working directory. That pointed every reader at their own cwd instead
 * of the packaging defect, and cost a full teardown/recreate validation cycle to
 * diagnose (#315). A missing asset is a broken build, not a wrong cwd, and it
 * says so.
 */
export function defaultSiblingTemplateRoot(): string {
  const start = dirname(fileURLToPath(import.meta.url))
  let dir = start
  for (;;) {
    const candidate = join(dir, '_skeletons', 'sibling-template')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(
    `Could not locate _skeletons/sibling-template above ${start}. ` +
      'This CLI build is missing its sibling skeleton: the published package must ship ' +
      '_skeletons/ beside dist/ (written by prepack, listed in package.json "files"). ' +
      'Reinstall the CLI (npm i -g @biffo/cli@latest), or pass --template <path> to a ' +
      'biffo-template checkout.',
  )
}
