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

export const initCommand = new Command('init')
  .description('Scaffold a new project from the Biffo template')
  .option('-c, --config <path>', 'Path to a pre-filled biffo.config.json')
  .option('--dry-run', 'Validate config without making any changes')
  .action(async (options: { config?: string; dryRun?: boolean }) => {
    console.log(chalk.bold('\n  Biffo — Project Initialiser\n'))

    // Resolve credentials up-front — before asking any project questions —
    // so the user never fills in a long form only to hit a missing-token error.
    const githubToken = await resolveGithubToken()
    const { accountId, region } = await resolveAwsCredentials()

    let rawConfig: unknown

    if (options.config) {
      rawConfig = JSON.parse(readFileSync(resolve(options.config), 'utf8'))
    } else {
      rawConfig = await promptForConfig(accountId, region)
    }

    const result = BiffoConfigSchema.safeParse(rawConfig)
    if (!result.success) {
      log.error('Invalid configuration:')
      result.error.issues.forEach((issue) => {
        log.error(`  ${issue.path.join('.')} — ${issue.message}`)
      })
      process.exit(1)
    }

    const config = result.data
    log.success('Configuration valid')

    if (options.dryRun) {
      console.log('\n', JSON.stringify(config, null, 2))
      return
    }

    const totalSteps = 5
    const github = new GitHubAdapter(githubToken)
    const aws = new AwsAdapter(config)

    // Step 1: Verify AWS credentials
    log.step(1, totalSteps, 'Verifying AWS credentials...')
    await aws.verifyCredentials()

    // Step 2: Create GitHub repo from template
    log.step(2, totalSteps, 'Creating GitHub repository...')
    await github.createRepoFromTemplate(config)

    // Step 3: Set up OIDC trust between GitHub Actions and AWS
    log.step(3, totalSteps, 'Configuring OIDC trust...')
    const roleArn = await aws.setupOidcTrust(config)
    config.cloud.config = {
      ...config.cloud.config,
      oidc_role_arn: roleArn,
    } as typeof config.cloud.config

    // Step 4: Bootstrap Terraform backend
    log.step(4, totalSteps, 'Bootstrapping Terraform state backend...')
    await aws.bootstrapTerraformBackend(config.project.name)

    // Step 5: Configure GitHub (branch protection, environments, secrets)
    log.step(5, totalSteps, 'Configuring GitHub repository...')
    await github.configureBranchProtection(config)
    await github.createEnvironments(config)

    const { org, repo } = (
      config.source_control as { provider: 'github'; config: { org: string; repo: string } }
    ).config
    await github.setRepoSecret(org, repo, 'BIFFO_OIDC_ROLE_ARN', roleArn)

    log.success('\nProject initialised successfully!')
    console.log(`\n  Repository: https://github.com/${org}/${repo}`)
    console.log('  Next: clone your repo and run the first deploy\n')
  })

async function resolveGithubToken(): Promise<string> {
  const fromEnv = process.env['GITHUB_TOKEN']
  if (fromEnv) return fromEnv

  console.log(
    chalk.yellow('  ℹ  GITHUB_TOKEN is not set.\n') +
      '     Create a classic PAT at https://github.com/settings/tokens\n' +
      '     with scopes: repo, workflow, admin:org (if using an org)\n',
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
