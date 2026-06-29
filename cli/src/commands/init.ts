import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import chalk from 'chalk'
import { Command } from 'commander'
import inquirer from 'inquirer'
import { BiffoConfigSchema, type BiffoConfig } from '../config/schema.js'
import { AwsAdapter } from '../adapters/cloud/aws/index.js'
import { GitHubAdapter } from '../adapters/source-control/github/index.js'
import { log } from '../lib/logger.js'
import {
  deleteSession,
  findLatestSession,
  markStepComplete,
  saveSession,
  type InitSession,
} from '../lib/session.js'

export const initCommand = new Command('init')
  .description('Scaffold a new project from the Biffo template')
  .option('-c, --config <path>', 'Path to a pre-filled biffo.config.json')
  .option('--dry-run', 'Validate config without making any changes')
  .option('--fresh', 'Ignore any saved session and start from scratch')
  .action(async (options: { config?: string; dryRun?: boolean; fresh?: boolean }) => {
    console.log(chalk.bold('\n  Biffo — Project Initialiser\n'))

    // Resolve credentials up-front — before asking any project questions —
    // so the user never fills in a long form only to hit a missing-token error.
    const githubToken = await resolveGithubToken()
    const { accountId, region } = await resolveAwsCredentials()

    let session: InitSession | null = null
    let config: BiffoConfig

    if (options.config) {
      const rawConfig = JSON.parse(readFileSync(resolve(options.config), 'utf8'))
      config = parseConfig(rawConfig)
      session = {
        version: 1,
        config,
        awsAccountId: accountId,
        awsRegion: region,
        completedSteps: [],
        outputs: {},
      }
    } else if (!options.fresh) {
      // Offer to resume a saved session
      const saved = findLatestSession()
      if (saved) {
        const { resume } = await inquirer.prompt<{ resume: boolean }>([
          {
            type: 'confirm',
            name: 'resume',
            message:
              `Resume previous init for ${chalk.bold(saved.config.project?.name ?? '?')}` +
              ` (completed: ${saved.completedSteps.join(', ') || 'none'})?`,
            default: true,
          },
        ])
        if (resume) {
          session = saved
          session.awsAccountId = accountId
          session.awsRegion = region
          config = parseConfig(session.config)
          console.log()
        }
      }
    }

    if (!session) {
      const rawConfig = await promptForConfig(accountId, region)
      config = parseConfig(rawConfig)
      session = {
        version: 1,
        config,
        awsAccountId: accountId,
        awsRegion: region,
        completedSteps: [],
        outputs: {},
      }
      saveSession(session)
    }

    config = config!

    log.success('Configuration valid')

    if (options.dryRun) {
      console.log('\n', JSON.stringify(config, null, 2))
      return
    }

    const github = new GitHubAdapter(githubToken)
    const aws = new AwsAdapter(config)

    await runInit(github, aws, config, session)

    const { org, repo } = (
      config.source_control as { provider: 'github'; config: { org: string; repo: string } }
    ).config

    log.success('\nProject initialised successfully!')
    console.log(`\n  Repository: https://github.com/${org}/${repo}`)
    console.log('  Next: clone your repo and run the first deploy\n')
  })

// ─── Exported for testing ────────────────────────────────────────────────────

export async function runInit(
  github: GitHubAdapter,
  aws: AwsAdapter,
  config: BiffoConfig,
  session: InitSession,
): Promise<void> {
  const totalSteps = 5

  // Step 1: Verify AWS credentials
  if (!session.completedSteps.includes('verify_credentials')) {
    log.step(1, totalSteps, 'Verifying AWS credentials...')
    await aws.verifyCredentials()
    markStepComplete(session, 'verify_credentials')
  } else {
    log.step(1, totalSteps, 'AWS credentials already verified — skipping')
  }

  // Step 2: Create GitHub repo from template
  if (!session.completedSteps.includes('create_repo')) {
    log.step(2, totalSteps, 'Creating GitHub repository...')
    const cloneUrl = await github.createRepoFromTemplate(config)
    session.outputs.cloneUrl = cloneUrl
    markStepComplete(session, 'create_repo')
  } else {
    log.step(2, totalSteps, 'GitHub repository already created — skipping')
  }

  // Step 3: Set up OIDC trust between GitHub Actions and AWS
  if (!session.completedSteps.includes('oidc_trust')) {
    log.step(3, totalSteps, 'Configuring OIDC trust...')
    const roleArn = await aws.setupOidcTrust(config)
    session.outputs.oidcRoleArn = roleArn
    config.cloud.config = {
      ...config.cloud.config,
      oidc_role_arn: roleArn,
    } as typeof config.cloud.config
    markStepComplete(session, 'oidc_trust')
  } else {
    log.step(3, totalSteps, 'OIDC trust already configured — skipping')
    if (session.outputs.oidcRoleArn) {
      config.cloud.config = {
        ...config.cloud.config,
        oidc_role_arn: session.outputs.oidcRoleArn,
      } as typeof config.cloud.config
    }
  }

  // Step 4: Bootstrap Terraform backend
  if (!session.completedSteps.includes('terraform_backend')) {
    log.step(4, totalSteps, 'Bootstrapping Terraform state backend...')
    await aws.bootstrapTerraformBackend(config.project.name)
    markStepComplete(session, 'terraform_backend')
  } else {
    log.step(4, totalSteps, 'Terraform backend already bootstrapped — skipping')
  }

  // Step 5: Configure GitHub (branch protection, environments, secrets)
  if (!session.completedSteps.includes('github_config')) {
    log.step(5, totalSteps, 'Configuring GitHub repository...')
    await github.configureBranchProtection(config)
    await github.createEnvironments(config)
    const { org, repo } = (
      config.source_control as { provider: 'github'; config: { org: string; repo: string } }
    ).config
    if (session.outputs.oidcRoleArn) {
      await github.setRepoSecret(org, repo, 'BIFFO_OIDC_ROLE_ARN', session.outputs.oidcRoleArn)
    }
    markStepComplete(session, 'github_config')
  } else {
    log.step(5, totalSteps, 'GitHub already configured — skipping')
  }

  deleteSession(config.project.name)
}

// ─────────────────────────────────────────────────────────────────────────────

function parseConfig(raw: unknown): BiffoConfig {
  const result = BiffoConfigSchema.safeParse(raw)
  if (!result.success) {
    log.error('Invalid configuration:')
    result.error.issues.forEach((issue) => {
      log.error(`  ${issue.path.join('.')} — ${issue.message}`)
    })
    process.exit(1)
  }
  return result.data
}

async function resolveGithubToken(): Promise<string> {
  // 1. Explicit env var
  if (process.env['GITHUB_TOKEN']) return process.env['GITHUB_TOKEN']

  // 2. gh CLI (installed and authenticated)
  const ghCreds = tryGhCliToken()
  if (ghCreds) {
    console.log(
      chalk.green('  ✔') + ` GitHub account ${chalk.bold(ghCreds.login)} detected (via gh CLI)\n`,
    )

    const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
      {
        type: 'confirm',
        name: 'confirmed',
        message: 'Use these GitHub credentials?',
        default: true,
      },
    ])

    if (confirmed) {
      console.log()
      process.env['GITHUB_TOKEN'] = ghCreds.token
      return ghCreds.token
    }
    console.log()
  }

  // 3. Manual entry
  console.log(
    chalk.yellow('  ℹ  No GitHub credentials found.\n') +
      '     Option A: run `gh auth login` to authenticate via the gh CLI\n' +
      '     Option B: create a classic PAT at https://github.com/settings/tokens\n' +
      '               with scopes: repo, workflow, admin:org (if using an org)\n',
  )

  const { token } = await inquirer.prompt<{ token: string }>([
    {
      type: 'password',
      name: 'token',
      message: 'GitHub Personal Access Token:',
      validate: (v: string) => v.trim().length > 0 || 'Token is required',
    },
  ])

  process.env['GITHUB_TOKEN'] = token
  return token
}

function tryGhCliToken(): { token: string; login: string } | null {
  try {
    const token = execSync('gh auth token', { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString()
      .trim()
    if (!token) return null
    const login = execSync('gh api user --jq .login', { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString()
      .trim()
    return login ? { token, login } : null
  } catch {
    return null
  }
}

async function resolveAwsCredentials(): Promise<{ accountId: string; region: string }> {
  const profile = process.env['AWS_PROFILE'] ?? process.env['AWS_DEFAULT_PROFILE'] ?? 'default'
  const detectedRegion =
    process.env['AWS_DEFAULT_REGION'] ?? process.env['AWS_REGION'] ?? 'us-east-1'

  let detectedAccountId: string | undefined

  try {
    const sts = new STSClient({ region: detectedRegion })
    const identity = await sts.send(new GetCallerIdentityCommand({}))
    detectedAccountId = identity.Account
  } catch {
    // Credentials not configured or invalid — fall through to manual entry
  }

  if (detectedAccountId) {
    console.log(
      chalk.green(`  ✔`) +
        ` AWS account ${chalk.bold(detectedAccountId)} detected` +
        ` (${detectedRegion}, profile: ${profile})\n`,
    )

    const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
      {
        type: 'confirm',
        name: 'confirmed',
        message: 'Use these AWS credentials?',
        default: true,
      },
    ])

    if (confirmed) {
      console.log()
      return { accountId: detectedAccountId, region: detectedRegion }
    }
  } else {
    console.log(
      chalk.yellow('  ⚠  Could not detect AWS credentials.\n') +
        '     Run: aws configure\n' +
        '     Or set AWS_PROFILE to switch profiles.\n',
    )
  }

  // Manual entry (either user declined auto-detected creds, or detection failed)
  const answers = await inquirer.prompt<{ account_id: string; region: string }>([
    {
      type: 'input',
      name: 'account_id',
      message: 'AWS account ID (12 digits):',
      default: detectedAccountId,
      validate: (v: string) => /^\d{12}$/.test(v) || 'Must be 12 digits',
    },
    {
      type: 'input',
      name: 'region',
      message: 'AWS region:',
      default: detectedRegion,
    },
  ])

  console.log()
  return { accountId: answers.account_id, region: answers.region }
}

async function promptForConfig(
  awsAccountId: string,
  awsRegion: string,
): Promise<Partial<BiffoConfig>> {
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'project_name',
      message: 'Project name (lowercase kebab-case):',
      validate: (v: string) => /^[a-z0-9-]+$/.test(v) || 'Must be lowercase kebab-case',
    },
    { type: 'input', name: 'project_description', message: 'Project description:' },
    { type: 'input', name: 'domain', message: 'Primary domain (e.g. myapp.com):' },
    { type: 'input', name: 'github_org', message: 'GitHub org or username:' },
    { type: 'input', name: 'github_repo', message: 'Repository name (will be created):' },
    { type: 'input', name: 'admin_email', message: 'Admin email address:' },
    { type: 'input', name: 'admin_username', message: 'Admin username:' },
    {
      type: 'checkbox',
      name: 'environments',
      message: 'Environments to provision:',
      choices: ['dev', 'staging', 'prod'],
      default: ['dev'],
    },
  ])

  return {
    project: {
      name: answers.project_name as string,
      description: answers.project_description as string,
      domain: answers.domain as string,
    },
    source_control: {
      provider: 'github',
      config: { org: answers.github_org as string, repo: answers.github_repo as string },
    },
    cloud: {
      provider: 'aws',
      config: { account_id: awsAccountId, region: awsRegion },
    },
    environments: answers.environments as ('dev' | 'staging' | 'prod')[],
    admin: { email: answers.admin_email as string, username: answers.admin_username as string },
  }
}
