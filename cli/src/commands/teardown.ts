import { execSync, spawnSync } from 'node:child_process'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
  .description(
    'Destroy all infrastructure and remove everything created by biffo init — single command',
  )
  .option('--project <name>', 'Project name to tear down (reads session if omitted)')
  .option('--skip-destroy', 'Skip terraform destroy (only use if infrastructure is already gone)')
  .action(async (options: { project?: string; skipDestroy?: boolean }) => {
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
    let adminEmail: string
    let adminUsername: string
    let domain: string

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
      adminEmail =
        (session.config.admin as { email: string } | undefined)?.email ?? 'noop@example.com'
      adminUsername = (session.config.admin as { username: string } | undefined)?.username ?? 'noop'
      domain = (session.config.project as { domain?: string }).domain ?? ''
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
      adminEmail = savedConfig.admin.email
      adminUsername = savedConfig.admin.username
      domain = savedConfig.project.domain
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
        { type: 'input', name: 'admin_email', message: 'Admin email (for TF vars):' },
        { type: 'input', name: 'admin_username', message: 'Admin username (for TF vars):' },
      ])
      projectName = answers.project_name as string
      org = answers.org as string
      repo = answers.repo as string
      region = answers.region as string
      adminEmail = answers.admin_email as string
      adminUsername = answers.admin_username as string
      domain = ''
    }

    const config = BiffoConfigSchema.safeParse({
      project: { name: projectName, description: '', domain: domain || 'example.com' },
      source_control: { provider: 'github', config: { org, repo } },
      cloud: { provider: 'aws', config: { account_id: accountId!, region } },
      environments: ['dev'],
      admin: { email: adminEmail, username: adminUsername },
    })

    if (!config.success) {
      log.error('Could not build config for teardown — run with --project <name> and retry')
      process.exit(1)
    }

    const github = new GitHubAdapter(githubToken)
    const aws = new AwsAdapter(config.data)

    const knownBucket = savedConfig
      ? (savedConfig.cloud as { config: { tf_state_bucket?: string } }).config.tf_state_bucket
      : undefined
    const stateBucket = knownBucket ?? `${projectName}-terraform-state-${accountId}`

    const deployed = options.skipDestroy
      ? []
      : await aws.listDeployedEnvironments(stateBucket).catch(() => [])

    // Show everything that will be deleted in one place
    console.log(chalk.red.bold('  This will permanently delete:\n'))
    if (deployed.length > 0) {
      console.log(chalk.red('  Infrastructure (terraform destroy):'))
      for (const env of deployed) {
        console.log(
          `    ${chalk.red('✗')} ${env} — VPC, RDS, Lambda, Cognito, CloudFront, EventBridge`,
        )
      }
      console.log()
    }
    console.log(chalk.red('  Biffo resources:'))
    console.log(`    ${chalk.red('✗')} GitHub repository  ${chalk.bold(`${org}/${repo}`)}`)
    console.log(
      `    ${chalk.red('✗')} IAM role           ${chalk.bold(`biffo-github-actions-${projectName}`)}`,
    )
    console.log(
      `    ${chalk.red('✗')} S3 bucket          ${chalk.bold(stateBucket)} (all versions)`,
    )
    console.log(`    ${chalk.red('✗')} Local session file`)
    console.log()

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

    // Destroy infrastructure first (repo must still exist for any in-flight workflows)
    if (deployed.length > 0) {
      const tfCheck = spawnSync('terraform', ['version'], { stdio: 'pipe' })
      if (tfCheck.status !== 0) {
        log.error('terraform is not installed or not in PATH.')
        log.error('  Install from: https://developer.hashicorp.com/terraform/downloads')
        log.error('  Or re-run with --skip-destroy if infrastructure is already gone.')
        process.exit(1)
      }

      for (const env of deployed) {
        const infraDir = join(process.cwd(), 'infra', 'environments', env)
        if (!existsSync(infraDir)) {
          log.error(`Infra directory not found: ${infraDir}`)
          log.error('  Run biffo teardown from the project root directory,')
          log.error('  or use --skip-destroy if infrastructure is already gone.')
          process.exit(1)
        }

        log.info(`\nDestroying ${env} infrastructure (this takes ~20 min for first run)...`)

        const backendFile = join(infraDir, '.teardown-backend.hcl')
        writeFileSync(
          backendFile,
          `bucket = "${stateBucket}"\nkey    = "${env}/terraform.tfstate"\nregion = "${region}"\n`,
        )

        try {
          const tfEnv = {
            ...process.env,
            TF_VAR_project_name: projectName,
            TF_VAR_aws_region: region,
            TF_VAR_admin_email: adminEmail,
            TF_VAR_admin_username: adminUsername,
            TF_VAR_domain: domain,
          }

          const init = spawnSync(
            'terraform',
            ['init', '-backend-config=.teardown-backend.hcl', '-reconfigure'],
            { cwd: infraDir, stdio: 'inherit', env: tfEnv },
          )
          if (init.status !== 0) {
            log.error(`terraform init failed for ${env}`)
            process.exit(1)
          }

          const destroy = spawnSync('terraform', ['destroy', '-auto-approve'], {
            cwd: infraDir,
            stdio: 'inherit',
            env: tfEnv,
          })
          if (destroy.status !== 0) {
            log.error(`terraform destroy failed for ${env}`)
            process.exit(1)
          }
        } finally {
          unlinkSync(backendFile)
        }

        log.success(`${env} infrastructure destroyed`)
      }
    }

    // Delete biffo init resources
    await github.deleteRepo(org, repo).catch((err) => {
      log.warn(`Could not delete repo (skipping): ${(err as Error).message}`)
    })

    await aws.teardownOidcRole(projectName).catch((err) => {
      log.warn(`Could not delete IAM role (skipping): ${(err as Error).message}`)
    })

    await aws.teardownTerraformBackend(projectName, knownBucket).catch((err) => {
      log.warn(`Could not delete Terraform state bucket (skipping): ${(err as Error).message}`)
    })

    deleteSession(projectName)
    deleteProjectConfig(projectName)

    log.success('\nTeardown complete.')
    console.log('  All biffo resources have been removed.\n')
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
