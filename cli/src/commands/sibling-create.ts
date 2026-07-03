import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import { AwsAdapter } from '../adapters/cloud/aws/index.js'
import { GitAdapter } from '../adapters/git/index.js'
import { GitHubAdapter } from '../adapters/source-control/github/index.js'
import { BiffoConfigSchema, type BiffoConfig } from '../config/schema.js'
import { SiblingConfigSchema, type SiblingConfig } from '../config/sibling-schema.js'
import { parseGitHubRepo } from '../lib/core-upgrade.js'
import { resolveGithubToken } from '../lib/credentials.js'
import { log } from '../lib/logger.js'
import { loadProjectConfig } from '../lib/session.js'
import {
  deleteSiblingSession,
  findLatestSiblingSession,
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
  .option('--dry-run', 'Validate config and print planned changes without creating anything')
  .option('--fresh', 'Ignore any saved session and start from scratch')
  .action(
    async (
      name: string,
      options: { config: string; template?: string; dryRun?: boolean; fresh?: boolean },
    ) => {
      try {
        await runSiblingCreateCommand(name, {
          configPath: resolve(options.config),
          templateRoot: options.template ? resolve(options.template) : defaultSiblingTemplateRoot(),
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
  dryRun: boolean
  fresh: boolean
}

async function runSiblingCreateCommand(name: string, options: CommandOptions): Promise<void> {
  console.log(chalk.bold('\n  Biffo — Sibling App Creator\n'))

  const config = readSiblingConfig(options.configPath)
  if (config.project.name !== name) {
    throw new Error(
      `Sibling name '${name}' does not match config project.name '${config.project.name}'.`,
    )
  }

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
    const saved = findLatestSiblingSession()
    if (saved && saved.config.project?.name === name) {
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

  await runSiblingCreate(github, aws, coreAws, git, config, session, {
    coreConfig,
    skeletonRoot: options.templateRoot,
    githubToken: token,
  })

  const { org, repo } = githubRepo(config)
  const pathPrefix = config.core.path_prefix ?? config.project.name

  log.success('\nSibling repo created successfully!')
  console.log(`\n  Repository: https://github.com/${org}/${repo}`)
  console.log(`  Path:       /${pathPrefix}`)
  if (session.outputs.registrationPrUrl) {
    console.log(
      `  Registration PR (against ${coreConfig.project.name}): ${session.outputs.registrationPrUrl}`,
    )
  }
  console.log(
    '\n  Next steps:\n' +
      `  1. Merge the registration PR above — until it merges, baseurl.com/${pathPrefix} won't route anywhere.\n` +
      '  2. Add a SIBLING_GITHUB_TOKEN secret to this new repo (a PAT with repo scope) — needed by its\n' +
      '     deploy workflow to export Terraform outputs as environment variables, same as the core project.\n' +
      "  3. Push to `dev` (or run the Deploy workflow manually) to provision this sibling's own AWS resources.\n" +
      '  4. Once the registration PR has ALSO merged and the core project has redeployed, set\n' +
      '     PARENT_CLOUDFRONT_DISTRIBUTION_ARN on this repo and re-run its Deploy workflow — see this\n' +
      '     repo\'s README, "The two-phase CDN registration".\n',
  )
}

// ─── Exported for testing ────────────────────────────────────────────────────

export interface SiblingCreateGit {
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
  const totalSteps = 7
  const { org, repo } = githubRepo(config)
  const pathPrefix = config.core.path_prefix ?? config.project.name

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
  if (!session.completedSteps.includes('resolve_core_identity')) {
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

  // Step 3: Create the GitHub repo and push the sibling skeleton as its first commit
  if (!session.completedSteps.includes('create_repo')) {
    log.step(3, totalSteps, 'Creating GitHub repository and pushing sibling skeleton...')
    const cloneUrl = await github.createEmptyRepo(
      org,
      repo,
      config.project.description || undefined,
    )
    session.outputs.cloneUrl = cloneUrl
    await pushSkeleton(
      git,
      options.skeletonRoot,
      cloneUrl,
      config,
      options.coreConfig,
      options.githubToken,
    )
    markSiblingStepComplete(session, 'create_repo')
  } else {
    log.step(3, totalSteps, 'GitHub repository already created — skipping')
  }

  // Step 4: Set up OIDC trust between GitHub Actions and AWS
  if (!session.completedSteps.includes('oidc_trust')) {
    log.step(4, totalSteps, 'Configuring OIDC trust...')
    session.outputs.oidcRoleArn = await aws.setupOidcTrust(config)
    markSiblingStepComplete(session, 'oidc_trust')
  } else {
    log.step(4, totalSteps, 'OIDC trust already configured — skipping')
  }

  // Step 5: Bootstrap Terraform backend
  if (!session.completedSteps.includes('terraform_backend')) {
    log.step(5, totalSteps, 'Bootstrapping Terraform state backend...')
    session.outputs.tfStateBucket = await aws.bootstrapTerraformBackend(config.project.name)
    markSiblingStepComplete(session, 'terraform_backend')
  } else {
    log.step(5, totalSteps, 'Terraform backend already bootstrapped — skipping')
  }

  // Step 6: Configure GitHub (branches, branch protection, environments, secrets, variables)
  if (!session.completedSteps.includes('github_config')) {
    log.step(6, totalSteps, 'Configuring GitHub repository...')
    await configureSiblingGithub(github, config, session, coreIdentity)
    markSiblingStepComplete(session, 'github_config')
  } else {
    log.step(6, totalSteps, 'GitHub already configured — skipping')
  }

  // Step 7: Register this sibling with the core project for CDN path routing
  if (!session.completedSteps.includes('register_with_core')) {
    log.step(7, totalSteps, 'Opening a registration PR against the core project...')
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
    log.step(7, totalSteps, 'Already registered with the core project — skipping')
  }

  deleteSiblingSession(config.project.name)
}

// ─────────────────────────────────────────────────────────────────────────────

function readSiblingConfig(path: string): SiblingConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  const withDefaults =
    raw && typeof raw === 'object' && 'project' in raw && 'core' in raw
      ? {
          ...raw,
          core: {
            ...(raw as { core: Record<string, unknown> }).core,
            path_prefix:
              (raw as { core: { path_prefix?: unknown } }).core.path_prefix ??
              (raw as { project: { name?: unknown } }).project.name,
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
      pathPrefix: config.core.path_prefix ?? config.project.name,
    })
    await git.init(workDir, 'main')
    await git.addRemote(workDir, 'origin', cloneUrl)
    await git.add(workDir, ['.'])
    await git.commit(workDir, `feat: scaffold ${config.project.name} sibling app (ADR-0007)`)
    await git.push(workDir, 'main', { token: githubToken })
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
  context: { coreProjectName: string; pathPrefix: string },
): void {
  if (!existsSync(templateRoot)) {
    throw new Error(`Sibling template not found at ${templateRoot}`)
  }
  cpSync(templateRoot, targetDir, { recursive: true })

  writeFileSync(
    join(targetDir, 'biffo.sibling.json'),
    JSON.stringify(
      {
        name: config.project.name,
        core_project: context.coreProjectName,
        path_prefix: context.pathPrefix,
        ...(config.project.description ? { description: config.project.description } : {}),
      },
      null,
      2,
    ) + '\n',
  )

  const envPath = join(targetDir, 'apps', 'frontend', '.env.example')
  try {
    const path = `/${context.pathPrefix}`
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
  session: SiblingSession,
  coreIdentity: Record<string, CoreIdentity>,
): Promise<void> {
  const { org, repo } = githubRepo(config)

  // Always all three branches, regardless of which environments this sibling
  // provisions (matches `biffo init`'s own convention — config.environments
  // only controls GitHub *Environments* and per-env variables below, not the
  // branch structure itself).
  await github.createBranch(org, repo, 'dev', 'main')
  await github.createBranch(org, repo, 'staging', 'main')
  await github.setDefaultBranch(org, repo, 'dev')

  await github.configureBranchProtection(config)
  await github.createEnvironments(config)

  await github.setRepoVariable(org, repo, 'PROJECT_NAME', config.project.name)
  await github.setRepoVariable(org, repo, 'AWS_REGION', awsConfig(config).region)
  await github.setRepoVariable(org, repo, 'SIBLING_DEPLOY_ENABLED', 'true')
  if (session.outputs.tfStateBucket) {
    await github.setRepoVariable(org, repo, 'TF_STATE_BUCKET', session.outputs.tfStateBucket)
  }

  for (const env of config.environments) {
    const identity = coreIdentity[env]
    if (!identity) continue
    await github.setEnvVariable(
      org,
      repo,
      env,
      'CORE_COGNITO_USER_POOL_ID',
      identity.cognitoUserPoolId,
    )
    await github.setEnvVariable(org, repo, env, 'CORE_COGNITO_CLIENT_ID', identity.cognitoClientId)
    await github.setEnvVariable(org, repo, env, 'CORE_API_URL', identity.apiUrl)
    await github.setEnvVariable(org, repo, env, 'CORE_PORTAL_URL', identity.portalUrl)
  }

  if (session.outputs.oidcRoleArn) {
    await github.setRepoSecret(org, repo, 'SIBLING_OIDC_ROLE_ARN', session.outputs.oidcRoleArn)
  }
}

/** AWS's S3 virtual-hosted-style regional domain — us-east-1 uses the legacy
 * global endpoint form, every other region includes the region in the host. */
function bucketRegionalDomain(bucketName: string, region: string): string {
  return region === 'us-east-1'
    ? `${bucketName}.s3.amazonaws.com`
    : `${bucketName}.s3.${region}.amazonaws.com`
}

/** Matches modules/cloud/aws/storage/main.tf's local.site_bucket naming. */
function siteBucketName(projectName: string, environment: string, accountId: string): string {
  return `${projectName}-${environment}-site-${accountId}`
}

/**
 * Reads siblings.auto.tfvars.json if present. Reads directly and catches
 * ENOENT rather than checking existsSync first — an existence check
 * followed by a separate read is a TOCTOU race (the file could be removed
 * in between), even though in practice nothing else touches this freshly
 * cloned temp directory.
 */
function readExistingSiblingOrigins(filePath: string): {
  sibling_origins?: Array<{ name: string; bucket_regional_domain: string }>
} {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as {
      sibling_origins?: Array<{ name: string; bucket_regional_domain: string }>
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
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
  try {
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
      const siblings = (existing.sibling_origins ?? []).filter((s) => s.name !== pathPrefix)
      siblings.push({ name: pathPrefix, bucket_regional_domain: domain })

      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, JSON.stringify({ sibling_origins: siblings }, null, 2) + '\n')
      touchedFiles.push(relativePath)
    }

    await git.add(cloneDir, touchedFiles)
    await git.commit(
      cloneDir,
      `infra(cdn): register sibling "${pathPrefix}" for path-based routing (ADR-0007)`,
    )
    await git.push(cloneDir, branch, { token: githubToken })

    const remoteUrl = await git.getRemoteUrl(cloneDir)
    const { owner, repo } = parseGitHubRepo(remoteUrl)
    const pr = await github.createPullRequest({
      owner,
      repo,
      head: branch,
      base,
      title: `Register sibling "${pathPrefix}" for CDN routing (ADR-0007)`,
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
    `Adds **${org}/${repo}** to this project's CloudFront distribution as a new path-routed origin — ` +
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
  const pathPrefix = config.core.path_prefix ?? config.project.name
  console.log(chalk.bold('\n  Dry run — no changes will be made\n'))
  console.log(`  Sibling:       ${config.project.name}`)
  console.log(`  Repository:    ${org}/${repo}`)
  console.log(`  Core project:  ${coreConfig.project.name}`)
  console.log(`  Path prefix:   /${pathPrefix}`)
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

function defaultSiblingTemplateRoot(): string {
  let dir = dirname(new URL(import.meta.url).pathname)
  for (;;) {
    const candidate = join(dir, '_skeletons', 'sibling-template')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return resolve(process.cwd(), '_skeletons', 'sibling-template')
}
