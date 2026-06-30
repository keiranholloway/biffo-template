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

      await runDeploy(github, aws, config, environment, { ...options, token })
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
  options: { infraOnly?: boolean; appOnly?: boolean; token?: string } = {},
): Promise<void> {
  const { org, repo } = (
    config.source_control as { provider: 'github'; config: { org: string; repo: string } }
  ).config
  const awsConfig = (
    config.cloud as { provider: 'aws'; config: { account_id: string; region: string } }
  ).config

  // Prefer the bucket name stored during biffo init — it may differ from the derived name
  // if the primary name was held by S3 after a teardown and a variant was used instead.
  const stateBucket =
    (awsConfig as { tf_state_bucket?: string }).tf_state_bucket ??
    `${config.project.name}-terraform-state-${awsConfig.account_id}`
  const stateKey = `${environment}/terraform.tfstate`

  // dev → dev branch, staging → staging branch, prod → main branch
  const envBranch: Record<string, string> = { dev: 'dev', staging: 'staging', prod: 'main' }
  const branch = envBranch[environment] ?? 'main'

  const skipInfra = options.appOnly === true
  const skipApp = options.infraOnly === true
  const hasDomain = Boolean(config.project.domain)
  const totalSteps = skipInfra || skipApp ? 2 : hasDomain ? 5 : 4

  const actionsUrl = `https://github.com/${org}/${repo}/actions`

  // Step 1: Set GitHub repository variables and store token as secret (skip when --app-only)
  if (!skipInfra) {
    log.step(1, totalSteps, 'Setting GitHub repository variables...')
    try {
      await github.setRepoVariable(org, repo, 'BIFFO_DEPLOY_ENABLED', 'true')
      await github.setRepoVariable(org, repo, 'AWS_REGION', awsConfig.region)
      await github.setRepoVariable(org, repo, 'PROJECT_NAME', config.project.name)
      await github.setRepoVariable(org, repo, 'TF_STATE_BUCKET', stateBucket)
      await github.setRepoVariable(org, repo, 'BIFFO_ADMIN_EMAIL', config.admin.email)
      await github.setRepoVariable(org, repo, 'BIFFO_ADMIN_USERNAME', config.admin.username)
      if (config.project.domain) {
        await github.setRepoVariable(org, repo, 'DOMAIN', config.project.domain)
      }
      // Store the caller's token so the workflow can write environment-scoped variables
      // after Terraform apply — GITHUB_TOKEN cannot write environment variables.
      if (options.token) {
        await github.setRepoSecret(org, repo, 'BIFFO_GITHUB_TOKEN', options.token)
      }
    } catch (err: unknown) {
      log.error(`Failed to set GitHub repository variables: ${(err as Error).message}`)
      log.error(
        `  Make sure your GitHub token has the "repo" scope: https://github.com/settings/tokens`,
      )
      process.exit(1)
    }
    log.success('Repository variables set')
  }

  // Step 2: Deploy global infrastructure (Route 53 + ACM cert) — only when domain configured
  if (!skipInfra && hasDomain) {
    log.step(2, totalSteps, 'Deploying global infrastructure (DNS + SSL certificate)...')
    const globalBaselineId = await github.getLatestWorkflowRunId(org, repo, 'deploy-global.yml')
    await github.triggerWorkflow(org, repo, 'deploy-global.yml', {}, 'main')
    log.info('  Provisioning Route 53 hosted zone and ACM wildcard certificate...')
    log.info(`  Watch live: ${actionsUrl}`)
    const globalResult = await github.waitForWorkflowRun(
      org,
      repo,
      'deploy-global.yml',
      globalBaselineId,
      3_600_000,
      30_000,
      'main',
    )
    if (globalResult.conclusion !== 'success') {
      log.error(`Global infrastructure deploy ${globalResult.conclusion ?? 'failed'}.`)
      log.error(`  Run details: ${actionsUrl}/runs/${globalResult.id}`)
      process.exit(1)
    }
    log.success(`Global infrastructure deployed (run #${globalResult.id})`)
  }

  // Step 3 (or 2 without domain): Trigger and wait for infrastructure deploy (skip when --app-only)
  if (!skipInfra) {
    const infraStep = hasDomain ? 3 : 2
    log.step(infraStep, totalSteps, `Triggering infrastructure deploy to ${environment}...`)
    const infraBaselineId = await github.getLatestWorkflowRunId(org, repo, 'deploy-infra.yml')
    await github.triggerWorkflow(
      org,
      repo,
      'deploy-infra.yml',
      { environment, action: 'apply' },
      branch,
    )
    log.info('  First run takes 20–40 minutes (VPC, RDS, Cognito, CloudFront all provisioning)...')
    log.info(`  Watch live: ${actionsUrl}`)
    const infraResult = await github.waitForWorkflowRun(
      org,
      repo,
      'deploy-infra.yml',
      infraBaselineId,
      3_600_000,
      30_000,
      branch,
    )
    if (infraResult.conclusion !== 'success') {
      log.error(`Infrastructure deploy ${infraResult.conclusion ?? 'failed'}.`)
      log.error(`  Run details: ${actionsUrl}/runs/${infraResult.id}`)
      log.error(`  Fix the issue and re-run: biffo deploy ${environment} --infra-only`)
      process.exit(1)
    }
    log.success(`Infrastructure deployed (run #${infraResult.id})`)
  }

  // Step 4 (or 3/1): Trigger and wait for application deploy (skip when --infra-only)
  if (!skipApp) {
    const step = skipInfra ? 1 : hasDomain ? 4 : 3
    log.step(step, totalSteps, `Triggering application deploy to ${environment}...`)
    const appBaselineId = await github.getLatestWorkflowRunId(org, repo, 'deploy-app.yml')
    await github.triggerWorkflow(org, repo, 'deploy-app.yml', { environment }, branch)
    log.info('  Waiting for application deploy...')
    const appResult = await github.waitForWorkflowRun(
      org,
      repo,
      'deploy-app.yml',
      appBaselineId,
      3_600_000,
      30_000,
      branch,
    )
    if (appResult.conclusion !== 'success') {
      log.error(`Application deploy ${appResult.conclusion ?? 'failed'}.`)
      log.error(`  Run details: ${actionsUrl}/runs/${appResult.id}`)
      log.error(`  Fix the issue and re-run: biffo deploy ${environment} --app-only`)
      process.exit(1)
    }
    log.success(`Application deployed (run #${appResult.id})`)
  }

  // Final step: Report outputs
  const reportStep = totalSteps
  log.step(reportStep, totalSteps, 'Reading deployment outputs...')
  try {
    const outputs = await aws.readTerraformOutputs(stateBucket, stateKey)
    console.log(chalk.bold('\n  Deploy complete!\n'))
    if (outputs.portal_url) console.log(`  Portal:      ${chalk.cyan(outputs.portal_url)}`)
    if (outputs.api_gateway_url)
      console.log(`  API:         ${chalk.cyan(outputs.api_gateway_url)}`)
    console.log(`  Actions:     ${actionsUrl}`)
    console.log()
    console.log(chalk.dim('  Next steps:'))
    console.log(
      chalk.dim(
        `    git clone ${config.source_control.provider === 'github' ? `https://github.com/${org}/${repo}.git` : ''}`,
      ),
    )
    console.log(
      chalk.dim(`    biffo deploy ${environment} --app-only   # to redeploy after code changes`),
    )
    console.log()
  } catch {
    // State may not be readable if --app-only was used (infra wasn't applied this run)
    console.log(chalk.bold('\n  Deploy complete!'))
    console.log(`  Actions: ${actionsUrl}\n`)
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
