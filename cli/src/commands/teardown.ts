import { execSync } from 'node:child_process'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import chalk from 'chalk'
import { Command } from 'commander'
import inquirer from 'inquirer'
import { BiffoConfigSchema } from '../config/schema.js'
import { AwsAdapter } from '../adapters/cloud/aws/index.js'
import { GitHubAdapter } from '../adapters/source-control/github/index.js'
import { log } from '../lib/logger.js'
import {
  deleteProjectConfig,
  deleteSession,
  findLatestSession,
  listProjectConfigs,
  loadProjectConfig,
  loadSession,
} from '../lib/session.js'

export const teardownCommand = new Command('teardown')
  .description('Remove everything created by biffo init (repo, IAM role, Terraform state bucket)')
  .option('--project <name>', 'Project name to tear down (reads session if omitted)')
  .action(async (options: { project?: string }) => {
    console.log(chalk.bold('\n  Biffo — Teardown\n'))

    // Resolve credentials
    const githubToken = resolveGithubToken()
    const sts = new STSClient({})
    const { Account: accountId } = await sts.send(new GetCallerIdentityCommand({}))

    // Load config from session or prompt
    let projectName: string
    let org: string
    let repo: string
    let region: string

    // Resolution order: init session → saved project config → interactive prompt
    const session = options.project ? loadSession(options.project) : findLatestSession()
    const savedConfig = session
      ? null
      : options.project
        ? loadProjectConfig(options.project)
        : (listProjectConfigs()[0] ?? null)

    if (session?.config.project?.name) {
      const sc = session.config.source_control as
        { provider: 'github'; config: { org: string; repo: string } } | undefined
      projectName = session.config.project.name
      org = sc?.config.org ?? ''
      repo = sc?.config.repo ?? ''
      region = session.awsRegion
      console.log(chalk.yellow('  Loaded session for: ') + chalk.bold(projectName))
      if (org && repo) console.log(`  Repository: ${org}/${repo}`)
      console.log()
    } else if (savedConfig) {
      const sc = savedConfig.source_control as {
        provider: 'github'
        config: { org: string; repo: string }
      }
      const cloud = savedConfig.cloud as {
        provider: 'aws'
        config: { account_id: string; region: string }
      }
      projectName = savedConfig.project.name
      org = sc.config.org
      repo = sc.config.repo
      region = cloud.config.region
      console.log(chalk.yellow('  Loaded config for: ') + chalk.bold(projectName))
      console.log(`  Repository: ${org}/${repo}`)
      console.log()
    } else {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'project_name',
          message: 'Project name:',
          default: options.project,
          validate: (v: string) => v.trim().length > 0 || 'Required',
        },
        { type: 'input', name: 'org', message: 'GitHub org or username:' },
        { type: 'input', name: 'repo', message: 'Repository name:' },
        {
          type: 'input',
          name: 'region',
          message: 'AWS region:',
          default: process.env['AWS_DEFAULT_REGION'] ?? process.env['AWS_REGION'] ?? 'us-east-1',
        },
      ])
      projectName = answers.project_name as string
      org = answers.org as string
      repo = answers.repo as string
      region = answers.region as string
    }

    // Show exactly what will be deleted
    console.log(chalk.red.bold('  This will permanently delete:\n'))
    console.log(`    ${chalk.red('✗')} GitHub repository  ${chalk.bold(`${org}/${repo}`)}`)
    console.log(
      `    ${chalk.red('✗')} IAM role           ${chalk.bold(`biffo-github-actions-${projectName}`)}`,
    )
    console.log(
      `    ${chalk.red('✗')} S3 bucket          ${chalk.bold(`${projectName}-terraform-state-${accountId}`)} (all versions)`,
    )
    console.log(`    ${chalk.red('✗')} Local session file`)
    console.log()
    console.log(
      chalk.yellow('  Not touched: Terraform-managed infra (VPC, Lambda, RDS, Cognito, etc.)'),
    )
    console.log(
      chalk.yellow(`  Run \`terraform destroy\` in infra/environments/* first if deployed.\n`),
    )

    // Require typing the project name to confirm — extra guard against mis-fires
    const { confirm } = await inquirer.prompt<{ confirm: string }>([
      {
        type: 'input',
        name: 'confirm',
        message: `Type ${chalk.bold(projectName)} to confirm:`,
      },
    ])

    if (confirm !== projectName) {
      log.warn('Teardown cancelled — project name did not match')
      return
    }

    const config = BiffoConfigSchema.safeParse({
      project: { name: projectName, description: '', domain: 'example.com' },
      source_control: { provider: 'github', config: { org, repo } },
      cloud: { provider: 'aws', config: { account_id: accountId!, region } },
      environments: ['dev'],
      admin: { email: 'noop@example.com', username: 'noop' },
    })

    if (!config.success) {
      log.error('Could not build config for teardown — run with --project <name> and retry')
      process.exit(1)
    }

    const github = new GitHubAdapter(githubToken)
    const aws = new AwsAdapter(config.data)

    // Delete in reverse init order
    await github.deleteRepo(org, repo).catch((err) => {
      log.warn(`Could not delete repo (skipping): ${(err as Error).message}`)
    })

    await aws.teardownOidcRole(projectName).catch((err) => {
      log.warn(`Could not delete IAM role (skipping): ${(err as Error).message}`)
    })

    const knownBucket = savedConfig
      ? (savedConfig.cloud as { config: { tf_state_bucket?: string } }).config.tf_state_bucket
      : undefined
    await aws.teardownTerraformBackend(projectName, knownBucket).catch((err) => {
      log.warn(`Could not delete Terraform state bucket (skipping): ${(err as Error).message}`)
    })

    deleteSession(projectName)
    deleteProjectConfig(projectName)

    log.success('\nTeardown complete.')
    console.log('  All biffo init resources have been removed.\n')
  })

function resolveGithubToken(): string {
  if (process.env['GITHUB_TOKEN']) return process.env['GITHUB_TOKEN']
  try {
    const token = execSync('gh auth token', { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString()
      .trim()
    if (token) return token
  } catch {
    /* fall through */
  }
  throw new Error(
    'No GitHub credentials found.\n' + '  Run `gh auth login` or set GITHUB_TOKEN and retry.',
  )
}
