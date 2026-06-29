import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import inquirer from 'inquirer'
import { BiffoConfigSchema, type BiffoConfig } from '../config/schema.js'
import { AwsAdapter } from '../adapters/cloud/aws/index.js'
import { GitHubAdapter } from '../adapters/source-control/github/index.js'
import { log } from '../lib/logger.js'
import { listProjectConfigs, loadProjectConfig } from '../lib/session.js'

export const deployCommand = new Command('deploy')
  .description('Deploy infrastructure and application to an environment')
  .argument('<environment>', 'Target environment: dev | staging | prod')
  .option('--infra-only', 'Deploy infrastructure only, skip application build')
  .option('--app-only', 'Deploy application only, skip Terraform')
  .option('-p, --project <name>', 'Project name (overrides biffo.config.json in current directory)')
  .option('-c, --config <path>', 'Path to biffo.config.json')
  .action(
    async (
      environment: string,
      options: { infraOnly?: boolean; appOnly?: boolean; project?: string; config?: string },
    ) => {
      const validEnvs = ['dev', 'staging', 'prod']
      if (!validEnvs.includes(environment)) {
        log.error(`Unknown environment: ${environment}. Must be one of: ${validEnvs.join(', ')}`)
        process.exit(1)
      }

      const config = await resolveConfig(options)

      console.log(chalk.bold(`\n  Biffo — Deploy to ${environment}\n`))

      const token = resolveGithubToken()
      const github = new GitHubAdapter(token)
      const aws = new AwsAdapter(config)

      await runDeploy(github, aws, config, environment, options)
    },
  )

async function resolveConfig(options: { project?: string; config?: string }): Promise<BiffoConfig> {
  // Explicit --config flag: parse and validate, no fallback
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

  // Explicit --project flag: read from ~/.biffo/projects/<name>.json
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

  // Try ./biffo.config.json — but only if it parses successfully (not a template placeholder)
  try {
    const raw = JSON.parse(readFileSync(resolve(process.cwd(), 'biffo.config.json'), 'utf8'))
    const result = BiffoConfigSchema.safeParse(raw)
    if (result.success) return result.data
  } catch {
    /* not found or not parseable — fall through to project store */
  }

  // Fall back to ~/.biffo/projects/
  const projects = listProjectConfigs()
  if (projects.length === 0) {
    log.error(
      'No biffo.config.json found in the current directory and no projects in ~/.biffo/projects/.',
    )
    log.error('Run biffo init first, or pass --project <name> or --config <path>.')
    process.exit(1)
  }

  if (projects.length === 1) {
    log.info(`Using project: ${projects[0]!.project.name}`)
    return projects[0]!
  }

  // Multiple projects — ask which one
  const { chosen } = await inquirer.prompt<{ chosen: string }>([
    {
      type: 'list',
      name: 'chosen',
      message: 'Which project do you want to deploy?',
      choices: projects.map((p) => ({
        name: `${p.project.name} (${(p.source_control as { config: { org: string; repo: string } }).config.org}/${(p.source_control as { config: { org: string; repo: string } }).config.repo})`,
        value: p.project.name,
      })),
    },
  ])

  return projects.find((p) => p.project.name === chosen)!
}

// ─── Exported for testing ────────────────────────────────────────────────────

export async function runDeploy(
  github: GitHubAdapter,
  aws: AwsAdapter,
  config: BiffoConfig,
  environment: string,
  options: { infraOnly?: boolean; appOnly?: boolean } = {},
): Promise<void> {
  const { org, repo } = (
    config.source_control as { provider: 'github'; config: { org: string; repo: string } }
  ).config
  const awsConfig = (
    config.cloud as { provider: 'aws'; config: { account_id: string; region: string } }
  ).config

  const stateBucket = `${config.project.name}-terraform-state-${awsConfig.account_id}`
  const stateKey = `${environment}/terraform.tfstate`

  const skipInfra = options.appOnly === true
  const skipApp = options.infraOnly === true
  const totalSteps = skipInfra || skipApp ? 2 : 4

  // Step 1: Set GitHub repository variables (skip when --app-only)
  if (!skipInfra) {
    log.step(1, totalSteps, 'Setting GitHub repository variables...')
    await github.setRepoVariable(org, repo, 'BIFFO_DEPLOY_ENABLED', 'true')
    await github.setRepoVariable(org, repo, 'AWS_REGION', awsConfig.region)
    await github.setRepoVariable(org, repo, 'PROJECT_NAME', config.project.name)
    await github.setRepoVariable(org, repo, 'TF_STATE_BUCKET', stateBucket)
    await github.setRepoVariable(org, repo, 'BIFFO_ADMIN_EMAIL', config.admin.email)
    await github.setRepoVariable(org, repo, 'BIFFO_ADMIN_USERNAME', config.admin.username)
  }

  // Step 2: Trigger and wait for infrastructure deploy (skip when --app-only)
  if (!skipInfra) {
    log.step(2, totalSteps, `Triggering infrastructure deploy to ${environment}...`)
    const infraTriggeredAt = new Date()
    await github.triggerWorkflow(org, repo, 'deploy-infra.yml', {
      environment,
      action: 'apply',
    })
    log.info('  Waiting for infrastructure deploy (20–40 minutes is normal for a first run)...')
    const infraResult = await github.waitForWorkflowRun(
      org,
      repo,
      'deploy-infra.yml',
      infraTriggeredAt,
    )
    if (infraResult.conclusion !== 'success') {
      log.error(
        `Infrastructure deploy ended with: ${infraResult.conclusion ?? 'unknown'}. ` +
          `Run ID: ${infraResult.id}`,
      )
      log.error(`  https://github.com/${org}/${repo}/actions/runs/${infraResult.id}`)
      process.exit(1)
    }
    log.success(`Infrastructure deployed (run #${infraResult.id})`)
  }

  // Step 3: Trigger and wait for application deploy (skip when --infra-only)
  if (!skipApp) {
    const step = skipInfra ? 1 : 3
    log.step(step, totalSteps, `Triggering application deploy to ${environment}...`)
    const appTriggeredAt = new Date()
    await github.triggerWorkflow(org, repo, 'deploy-app.yml', { environment })
    log.info('  Waiting for application deploy...')
    const appResult = await github.waitForWorkflowRun(org, repo, 'deploy-app.yml', appTriggeredAt)
    if (appResult.conclusion !== 'success') {
      log.error(
        `Application deploy ended with: ${appResult.conclusion ?? 'unknown'}. ` +
          `Run ID: ${appResult.id}`,
      )
      log.error(`  https://github.com/${org}/${repo}/actions/runs/${appResult.id}`)
      process.exit(1)
    }
    log.success(`Application deployed (run #${appResult.id})`)
  }

  // Step 4: Report outputs
  const reportStep = totalSteps
  log.step(reportStep, totalSteps, 'Reading deployment outputs...')
  try {
    const outputs = await aws.readTerraformOutputs(stateBucket, stateKey)
    console.log(chalk.bold('\n  Deploy complete!\n'))
    if (outputs.portal_url) console.log(`  Portal:  ${chalk.cyan(outputs.portal_url)}`)
    if (outputs.api_gateway_url) console.log(`  API:     ${chalk.cyan(outputs.api_gateway_url)}`)
    console.log(`  Repo:    https://github.com/${org}/${repo}\n`)
  } catch {
    // State may not be readable if --app-only was used (infra wasn't applied this run)
    console.log(chalk.bold('\n  Deploy complete!'))
    console.log(`  View your repo at: https://github.com/${org}/${repo}/actions\n`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────

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
