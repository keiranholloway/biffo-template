import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import inquirer from 'inquirer'
import ora from 'ora'
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

    let rawConfig: unknown

    if (options.config) {
      rawConfig = JSON.parse(readFileSync(resolve(options.config), 'utf8'))
    } else {
      rawConfig = await promptForConfig()
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

    const githubToken = process.env['GITHUB_TOKEN']
    if (!githubToken) {
      log.error('GITHUB_TOKEN environment variable required')
      process.exit(1)
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
    config.cloud.config = { ...config.cloud.config, oidc_role_arn: roleArn } as typeof config.cloud.config

    // Step 4: Bootstrap Terraform backend
    log.step(4, totalSteps, 'Bootstrapping Terraform state backend...')
    await aws.bootstrapTerraformBackend(config.project.name)

    // Step 5: Configure GitHub (branch protection, environments, secrets)
    log.step(5, totalSteps, 'Configuring GitHub repository...')
    await github.configureBranchProtection(config)
    await github.createEnvironments(config)

    const { org, repo } = (config.source_control as { provider: 'github'; config: { org: string; repo: string } }).config
    await github.setRepoSecret(org, repo, 'BIFFO_OIDC_ROLE_ARN', roleArn)

    log.success('\nProject initialised successfully!')
    console.log(`\n  Repository: https://github.com/${org}/${repo}`)
    console.log('  Next: clone your repo and run the first deploy\n')
  })

async function promptForConfig(): Promise<Partial<BiffoConfig>> {
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
    { type: 'input', name: 'aws_account_id', message: 'AWS account ID (12 digits):' },
    { type: 'input', name: 'aws_region', message: 'AWS region:', default: 'us-east-1' },
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
    project: { name: answers.project_name as string, description: answers.project_description as string, domain: answers.domain as string },
    source_control: { provider: 'github', config: { org: answers.github_org as string, repo: answers.github_repo as string } },
    cloud: { provider: 'aws', config: { account_id: answers.aws_account_id as string, region: answers.aws_region as string } },
    environments: answers.environments as ('dev' | 'staging' | 'prod')[],
    admin: { email: answers.admin_email as string, username: answers.admin_username as string },
  }
}
