import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import { AwsAdapter } from '../adapters/cloud/aws/index.js'
import { GitAdapter } from '../adapters/git/index.js'
import { DEFAULT_STATUS_CHECKS, GitHubAdapter } from '../adapters/source-control/github/index.js'
import { BiffoConfigSchema, type BiffoConfig } from '../config/schema.js'
import { SiblingConfigSchema, type SiblingConfig } from '../config/sibling-schema.js'
import { resolveGithubToken } from '../lib/credentials.js'
import { log } from '../lib/logger.js'
import { loadProjectConfig } from '../lib/session.js'

export const siblingCreateCommand = new Command('create')
  .description('Create a standalone sibling app repository from the Biffo sibling template')
  .argument('<name>', 'Sibling name; must match config.project.name')
  .requiredOption('-c, --config <path>', 'Path to a pre-filled biffo.sibling.json')
  .option('--template <path>', 'Path to sibling template (defaults to bundled skeleton)')
  .option('--dry-run', 'Validate config and print planned changes without creating anything')
  .action(
    async (name: string, options: { config: string; template?: string; dryRun?: boolean }) => {
      try {
        await runSiblingCreate(name, {
          configPath: resolve(options.config),
          templateRoot: options.template ? resolve(options.template) : defaultSiblingTemplateRoot(),
          dryRun: options.dryRun === true,
        })
      } catch (err) {
        log.error((err as Error).message)
        process.exit(1)
      }
    },
  )

export interface SiblingCreateOptions {
  configPath: string
  templateRoot: string
  dryRun: boolean
}

export interface SiblingCreateDeps {
  git: Pick<GitAdapter, 'init' | 'addRemote' | 'add' | 'commit' | 'push' | 'cleanup'>
  github: Pick<
    GitHubAdapter,
    | 'createEmptyRepo'
    | 'createBranch'
    | 'setDefaultBranch'
    | 'configureBranchProtection'
    | 'createEnvironments'
    | 'setRepoSecret'
    | 'setRepoVariable'
  >
  aws: Pick<AwsAdapter, 'verifyCredentials' | 'setupOidcTrust' | 'bootstrapTerraformBackend'>
  makeTempDir: () => string
}

export async function runSiblingCreate(
  name: string,
  options: SiblingCreateOptions,
  deps?: SiblingCreateDeps,
): Promise<void> {
  const config = readSiblingConfig(options.configPath)
  if (config.project.name !== name) {
    throw new Error(
      `Sibling name '${name}' does not match config project.name '${config.project.name}'.`,
    )
  }

  const coreConfig = resolveCoreConfig(config, options.configPath)
  const pathPrefix = config.core.path_prefix ?? config.project.name
  const { org, repo } = githubRepo(config)

  if (options.dryRun) {
    printDryRun(config, coreConfig, pathPrefix, options.templateRoot)
    return
  }

  const token = await resolveGithubToken(true)
  const runtimeDeps =
    deps ??
    ({
      git: new GitAdapter(),
      github: new GitHubAdapter(token),
      aws: new AwsAdapter(config),
      makeTempDir: () => mkdtempSync(join(tmpdir(), `biffo-sibling-${name}-`)),
    } satisfies SiblingCreateDeps)

  let workDir = ''
  try {
    log.step(1, 6, 'Verifying AWS credentials...')
    await runtimeDeps.aws.verifyCredentials()

    log.step(2, 6, 'Creating sibling GitHub repository...')
    const cloneUrl = await runtimeDeps.github.createEmptyRepo(org, repo, config.project.description)

    log.step(3, 6, 'Writing sibling template...')
    workDir = runtimeDeps.makeTempDir()
    writeSiblingTemplate(options.templateRoot, workDir, config, {
      coreProjectName: coreConfig.project.name,
      pathPrefix,
    })
    await runtimeDeps.git.init(workDir, 'main')
    await runtimeDeps.git.addRemote(workDir, 'origin', cloneUrl)
    await runtimeDeps.git.add(workDir, ['.'])
    await runtimeDeps.git.commit(workDir, `feat: scaffold ${name} sibling app`)
    await runtimeDeps.git.push(workDir, 'main', { token } as never)
    log.success('Sibling skeleton pushed')

    log.step(4, 6, 'Configuring AWS bootstrap resources...')
    const oidcRoleArn = await runtimeDeps.aws.setupOidcTrust(config)
    const tfStateBucket = await runtimeDeps.aws.bootstrapTerraformBackend(config.project.name)

    log.step(5, 6, 'Configuring GitHub branches and environments...')
    await runtimeDeps.github.createBranch(org, repo, 'dev', 'main')
    await runtimeDeps.github.createBranch(org, repo, 'staging', 'main')
    await runtimeDeps.github.setDefaultBranch(org, repo, 'dev')
    await runtimeDeps.github.createEnvironments(config)
    await runtimeDeps.github.configureBranchProtection(config, 3_000, DEFAULT_STATUS_CHECKS)

    log.step(6, 6, 'Setting sibling repository secrets and variables...')
    await runtimeDeps.github.setRepoSecret(org, repo, 'SIBLING_OIDC_ROLE_ARN', oidcRoleArn)
    await runtimeDeps.github.setRepoSecret(org, repo, 'SIBLING_GITHUB_TOKEN', token)
    await setSiblingVariables(runtimeDeps.github, config, coreConfig, {
      tfStateBucket,
      pathPrefix,
    })

    console.log(chalk.bold('\n  Sibling app created\n'))
    console.log(`  Repository: https://github.com/${org}/${repo}`)
    console.log(`  Path:       /${pathPrefix}`)
    console.log('\n  Next:')
    console.log(
      '    1. Push to dev or run the sibling Deploy workflow to provision its bucket/API.',
    )
    console.log(
      '    2. Add the resulting SITE_BUCKET_REGIONAL_DOMAIN to the core project siblings.auto.tfvars.json and open a core registration PR.',
    )
    console.log(
      '    3. After the core registration PR deploys, set PARENT_CLOUDFRONT_DISTRIBUTION_ARN and rerun the sibling Deploy workflow.\n',
    )
  } finally {
    if (workDir) runtimeDeps.git.cleanup(workDir)
  }
}

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
          .map((issue) => `  ${issue.path.join('.')} - ${issue.message}`)
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

  throw new Error('Either core.project_name or core.config_path is required.')
}

function parseCoreConfig(path: string): BiffoConfig {
  const result = BiffoConfigSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
  if (!result.success) {
    throw new Error(
      `Invalid core configuration at ${path}:\n` +
        result.error.issues
          .map((issue) => `  ${issue.path.join('.')} - ${issue.message}`)
          .join('\n'),
    )
  }
  return result.data
}

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
        description: config.project.description,
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

async function setSiblingVariables(
  github: Pick<GitHubAdapter, 'setRepoVariable'>,
  config: SiblingConfig,
  coreConfig: BiffoConfig,
  values: { tfStateBucket: string; pathPrefix: string },
): Promise<void> {
  const { org, repo } = githubRepo(config)
  const coreAws = awsConfig(coreConfig)
  const variables: Record<string, string> = {
    SIBLING_DEPLOY_ENABLED: 'true',
    PROJECT_NAME: config.project.name,
    AWS_REGION: awsConfig(config).region,
    TF_STATE_BUCKET: values.tfStateBucket,
    CORE_API_URL: '',
    CORE_PORTAL_URL: '',
    CORE_COGNITO_USER_POOL_ID: '',
    CORE_COGNITO_CLIENT_ID: '',
    CORS_ORIGINS_JSON: '["http://localhost:3000"]',
    PARENT_CLOUDFRONT_DISTRIBUTION_ID: '',
    PARENT_CLOUDFRONT_DISTRIBUTION_ARN: '',
    CORE_PROJECT_NAME: coreConfig.project.name,
    CORE_AWS_REGION: coreAws.region,
    SIBLING_PATH_PREFIX: values.pathPrefix,
  }

  for (const [name, value] of Object.entries(variables)) {
    await github.setRepoVariable(org, repo, name, value)
  }
}

function printDryRun(
  config: SiblingConfig,
  coreConfig: BiffoConfig,
  pathPrefix: string,
  templateRoot: string,
): void {
  const { org, repo } = githubRepo(config)
  console.log(chalk.bold('\n  Dry run - no changes will be made\n'))
  console.log(`  Sibling:       ${config.project.name}`)
  console.log(`  Repository:    ${org}/${repo}`)
  console.log(`  Core project:  ${coreConfig.project.name}`)
  console.log(`  Path prefix:   /${pathPrefix}`)
  console.log(`  Template:      ${templateRoot}`)
  console.log('\n  Would:')
  console.log('    - create an empty private sibling GitHub repository')
  console.log('    - copy and rewrite _skeletons/sibling-template into the repo')
  console.log('    - push main, create dev/staging, and set dev as default')
  console.log('    - create AWS OIDC trust and Terraform state bucket')
  console.log(
    '    - configure repository secrets, variables, environments, and branch protection\n',
  )
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
  while (true) {
    const candidate = join(dir, '_skeletons', 'sibling-template')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return resolve(process.cwd(), '_skeletons', 'sibling-template')
}
