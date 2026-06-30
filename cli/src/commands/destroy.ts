import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import inquirer from 'inquirer'
import { BiffoConfigSchema, type BiffoConfig } from '../config/schema.js'
import { GitHubAdapter } from '../adapters/source-control/github/index.js'
import { log } from '../lib/logger.js'
import { listProjectConfigs, loadProjectConfig } from '../lib/session.js'

export const destroyCommand = new Command('destroy')
  .description('Destroy infrastructure for an environment — run before biffo teardown')
  .argument('<environment>', 'Target environment: dev | staging | prod')
  .option('-p, --project <name>', 'Project name')
  .option('-c, --config <path>', 'Path to biffo.config.json')
  .action(async (environment: string, options: { project?: string; config?: string }) => {
    const validEnvs = ['dev', 'staging', 'prod']
    if (!validEnvs.includes(environment)) {
      log.error(`Unknown environment: ${environment}. Must be one of: ${validEnvs.join(', ')}`)
      process.exit(1)
    }

    const config = await resolveConfig(options)
    const { org, repo } = (
      config.source_control as { provider: 'github'; config: { org: string; repo: string } }
    ).config
    const actionsUrl = `https://github.com/${org}/${repo}/actions`

    console.log(chalk.bold(`\n  Biffo — Destroy ${environment}\n`))
    console.log(chalk.red.bold('  WARNING: This permanently destroys all infrastructure:\n'))
    console.log(chalk.red(`    VPC, subnets, NAT gateway, RDS instance`))
    console.log(chalk.red(`    Lambda function, API Gateway`))
    console.log(chalk.red(`    Cognito user pool (all user accounts deleted)`))
    console.log(chalk.red(`    CloudFront distribution, S3 portal bucket`))
    console.log(chalk.red(`    EventBridge bus, CloudWatch log groups\n`))

    if (environment === 'prod') {
      const { typed } = await inquirer.prompt<{ typed: string }>([
        {
          type: 'input',
          name: 'typed',
          message: `Type ${chalk.bold(repo)} to confirm destruction of PRODUCTION:`,
        },
      ])
      if (typed !== repo) {
        log.warn('Destroy cancelled — repo name did not match')
        return
      }
    } else {
      const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
        {
          type: 'confirm',
          name: 'confirmed',
          message: `Destroy ${chalk.bold(environment)} in ${chalk.bold(`${org}/${repo}`)}?`,
          default: false,
        },
      ])
      if (!confirmed) {
        log.warn('Destroy cancelled')
        return
      }
    }

    const token = resolveGithubToken()
    const github = new GitHubAdapter(token)

    // dev → dev branch, staging → staging branch, prod → main branch
    const envBranch: Record<string, string> = { dev: 'dev', staging: 'staging', prod: 'main' }
    const branch = envBranch[environment] ?? 'dev'

    log.step(1, 1, `Triggering terraform destroy for ${environment}...`)
    const baselineId = await github.getLatestWorkflowRunId(org, repo, 'destroy-infra.yml')
    await github.triggerWorkflow(org, repo, 'destroy-infra.yml', { environment }, branch)
    log.info(`  Watch live: ${actionsUrl}`)

    const result = await github.waitForWorkflowRun(
      org,
      repo,
      'destroy-infra.yml',
      baselineId,
      3_600_000,
      30_000,
      branch,
    )

    if (result.conclusion !== 'success') {
      log.error(`Destroy ${result.conclusion ?? 'failed'}.`)
      log.error(`  Run details: ${actionsUrl}/runs/${result.id}`)
      process.exit(1)
    }

    log.success(`${environment} infrastructure destroyed.`)
    console.log(chalk.dim(`\n  You can now run: biffo teardown\n`))
  })

async function resolveConfig(options: { project?: string; config?: string }): Promise<BiffoConfig> {
  if (options.config) {
    const raw = JSON.parse(readFileSync(resolve(options.config), 'utf8'))
    const result = BiffoConfigSchema.safeParse(raw)
    if (!result.success) {
      log.error(`Invalid config at ${options.config}:`)
      result.error.issues.forEach((i) => log.error(`  ${i.path.join('.')} — ${i.message}`))
      process.exit(1)
    }
    return result.data
  }

  if (options.project) {
    const cfg = loadProjectConfig(options.project)
    if (!cfg) {
      log.error(
        `Project "${options.project}" not found in ~/.biffo/projects/. ` +
          `Run biffo init first or pass --config <path>.`,
      )
      process.exit(1)
    }
    return cfg
  }

  try {
    const raw = JSON.parse(readFileSync(resolve(process.cwd(), 'biffo.config.json'), 'utf8'))
    const result = BiffoConfigSchema.safeParse(raw)
    if (result.success) return result.data
  } catch {
    /* not found or not parseable — fall through to project store */
  }

  const projects = listProjectConfigs()
  if (projects.length === 0) {
    log.error(
      'No biffo.config.json in the current directory and no projects in ~/.biffo/projects/.',
    )
    log.error('Run biffo init first, or pass --project <name> or --config <path>.')
    process.exit(1)
  }

  if (projects.length === 1) {
    log.info(`Using project: ${projects[0]!.project.name}`)
    return projects[0]!
  }

  const { chosen } = await inquirer.prompt<{ chosen: string }>([
    {
      type: 'list',
      name: 'chosen',
      message: 'Which project do you want to destroy?',
      choices: projects.map((p) => ({
        name: `${p.project.name} (${(p.source_control as { config: { org: string; repo: string } }).config.org}/${(p.source_control as { config: { org: string; repo: string } }).config.repo})`,
        value: p.project.name,
      })),
    },
  ])

  return projects.find((p) => p.project.name === chosen)!
}

function resolveGithubToken(): string {
  if (process.env['GITHUB_TOKEN']) return process.env['GITHUB_TOKEN']
  try {
    const token = execSync('gh auth token', { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString()
      .trim()
    if (token) return token
  } catch {
    /* gh not installed or not authenticated */
  }
  log.error('No GitHub credentials found.')
  log.error('  Run: gh auth login')
  log.error('  Or set the GITHUB_TOKEN environment variable.')
  process.exit(1)
}
