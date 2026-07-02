import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import inquirer from 'inquirer'
import { AwsAdapter } from '../adapters/cloud/aws/index.js'
import { BiffoConfigSchema, type BiffoConfig } from '../config/schema.js'
import { log } from '../lib/logger.js'
import { listProjectConfigs, loadProjectConfig } from '../lib/session.js'

const VALID_ENVIRONMENTS = ['dev', 'staging', 'prod']

export const dataApplyCommand = new Command('apply')
  .description(
    "Apply a vendored DDL import against a deployed environment's database: biffo data apply <name> --env <environment>",
  )
  .argument('<name>', 'DDL import name, e.g. tabsii')
  .requiredOption('--env <environment>', 'Target environment: dev | staging | prod')
  .option('-p, --project <name>', 'Project name (overrides biffo.config.json in current directory)')
  .option('-c, --config <path>', 'Path to biffo.config.json')
  .action(async (name: string, options: { env: string; project?: string; config?: string }) => {
    if (!VALID_ENVIRONMENTS.includes(options.env)) {
      log.error(
        `Unknown environment: ${options.env}. Must be one of: ${VALID_ENVIRONMENTS.join(', ')}`,
      )
      process.exit(1)
    }

    const config = await resolveConfig(options)
    const aws = new AwsAdapter(config)

    try {
      await runDataApply(name, options.env, config, aws)
    } catch (err) {
      log.error((err as Error).message)
      process.exit(1)
    }
  })

/**
 * Invokes the deployed Core API Lambda's `"biffo:ddl-import"` event handler
 * for `name` (`main.py`'s `_run_ddl_import`, ADR-0005). Idempotent by
 * design on the handler side — already-applied, unchanged files are
 * reported back as skipped rather than reapplied, so re-running this
 * command is always safe.
 *
 * Resolves the Terraform state bucket the same inline fallback chain
 * deploy.ts/teardown.ts already duplicate (there is no shared exported
 * helper for this in the codebase today — matching the existing
 * convention rather than introducing a new one), and reads the
 * `core_api_lambda_name` Terraform output via the same
 * AwsAdapter.readTerraformOutputs() deploy.ts already uses for
 * portal_url/api_gateway_url.
 */
export async function runDataApply(
  name: string,
  environment: string,
  config: BiffoConfig,
  aws: AwsAdapter,
): Promise<void> {
  const awsConfig = (
    config.cloud as { provider: 'aws'; config: { account_id: string; region: string } }
  ).config
  const stateBucket =
    (awsConfig as { tf_state_bucket?: string }).tf_state_bucket ??
    `${config.project.name}-terraform-state-${awsConfig.account_id}`
  const stateKey = `${environment}/terraform.tfstate`

  log.info(`Reading Terraform outputs from s3://${stateBucket}/${stateKey}...`)
  const outputs = await aws.readTerraformOutputs(stateBucket, stateKey)
  const functionName = outputs['core_api_lambda_name']
  if (!functionName) {
    throw new Error(
      `core_api_lambda_name not found in Terraform outputs for ${environment}. ` +
        `Has infrastructure been deployed to this environment? Run: biffo deploy ${environment}`,
    )
  }

  log.info(`Invoking ${functionName} to apply DDL import '${name}'...`)
  const result = await aws.invokeLambda(functionName, {
    source: 'biffo:ddl-import',
    directory: name,
  })

  if (!result.ok) {
    const message =
      typeof result.body['errorMessage'] === 'string'
        ? result.body['errorMessage']
        : JSON.stringify(result.body)
    throw new Error(`DDL import '${name}' failed: ${message}`)
  }

  const applied = Array.isArray(result.body['applied']) ? (result.body['applied'] as string[]) : []
  const skipped = Array.isArray(result.body['skipped']) ? (result.body['skipped'] as string[]) : []

  console.log(chalk.bold(`\n  DDL import '${name}' applied to ${environment}\n`))
  if (applied.length > 0) {
    console.log(`  Applied (${String(applied.length)}):`)
    for (const file of applied) console.log(`    ${chalk.green('+')} ${file}`)
  }
  if (skipped.length > 0) {
    console.log(`  Already applied, unchanged — skipped (${String(skipped.length)}):`)
    for (const file of skipped) console.log(`    ${chalk.dim('=')} ${file}`)
  }
  if (applied.length === 0 && skipped.length === 0) {
    console.log(chalk.dim('  Nothing to apply.'))
  }
  console.log()
}

// Mirrors deploy.ts's resolveConfig() exactly — see that file for why this
// isn't a shared helper (each command resolves config independently today).
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

  const localConfigPath = resolve(process.cwd(), 'biffo.config.json')
  if (existsSync(localConfigPath)) {
    const raw = JSON.parse(readFileSync(localConfigPath, 'utf8'))
    const result = BiffoConfigSchema.safeParse(raw)
    if (result.success) return result.data
    log.error(`Invalid config at ${localConfigPath}:`)
    result.error.issues.forEach((i) => log.error(`  ${i.path.join('.')} — ${i.message}`))
    log.error('Refusing to fall back to a saved project while a local config file is present.')
    log.error('Fix biffo.config.json, or pass --project <name> / --config <path> explicitly.')
    process.exit(1)
  }

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

  const { chosen } = await inquirer.prompt<{ chosen: string }>([
    {
      type: 'list',
      name: 'chosen',
      message: 'Which project do you want to apply this DDL import to?',
      choices: projects.map((p) => ({
        name: `${p.project.name} (${(p.source_control as { config: { org: string; repo: string } }).config.org}/${(p.source_control as { config: { org: string; repo: string } }).config.repo})`,
        value: p.project.name,
      })),
    },
  ])

  return projects.find((p) => p.project.name === chosen)!
}
