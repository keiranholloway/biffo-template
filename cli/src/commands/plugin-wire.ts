/**
 * `biffo plugin wire <name> <environment>` — the register step of a user-facing
 * plugin's two-apply install (ADR-0018).
 *
 * A user-facing plugin is an authenticated sibling: its Lambda Function URL host
 * and frontend bucket domain only exist *after* its own Terraform module applies,
 * so the shared-CloudFront behaviours that route `<name>/api/*` and `<name>/*` at
 * them cannot be written by `biffo plugin install` up front. The flow is:
 *
 *   install  →  generates the plugin module block (+ surfaces its user-facing
 *               outputs at the environment root as `plugin_<name>_<output>`)
 *   apply 1  →  the pipeline applies; the Lambda + Function URL + bucket exist
 *   THIS     →  read those outputs from the deployed state, upsert the CDN origins
 *               into `plugin-apis.auto.tfvars.json` + `siblings.auto.tfvars.json`
 *   apply 2  →  the pipeline applies; the cdn module gains the two behaviours
 *
 * This command only reads state and writes tfvars — it never applies (apply is
 * pipeline-only). Commit the written files and redeploy to run apply 2. It reads
 * the outputs straight from the S3 remote state (like `biffo data apply`), so no
 * local `terraform init` is needed and it runs the same in CI as on a laptop.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import chalk from 'chalk'
import { Command } from 'commander'

import { AwsAdapter } from '../adapters/cloud/aws/index.js'
import { BiffoConfigSchema, type BiffoConfig } from '../config/schema.js'
import { isTemplatePlaceholderConfig } from '../lib/local-config.js'
import { log } from '../lib/logger.js'
import { wireUserFacingPluginFromOutputs, type PluginDeployTargets } from '../lib/plugin-origin.js'
import { pluginOutputsFromRoot } from '../lib/plugin-terraform-wiring.js'
import { loadProjectConfig } from '../lib/session.js'

const VALID_ENVIRONMENTS = ['dev', 'staging', 'prod']

/** The narrow dependency `runPluginWire` needs — reading a deployed env's outputs. */
export interface PluginWireDeps {
  readOutputs: (stateBucket: string, stateKey: string) => Promise<Record<string, string>>
}

/**
 * Read a deployed environment's Terraform outputs, extract the user-facing
 * plugin's origins, and register them into the environment's tfvars. Returns the
 * paths written and the frontend bucket the built `web/dist` is synced to. The
 * fail-closed check lives in `wireUserFacingPluginFromOutputs`: if the plugin
 * module has not applied (so its outputs are absent), it throws rather than
 * writing a registration that routes the CDN at nothing.
 */
export async function runPluginWire(
  pluginName: string,
  environment: string,
  config: BiffoConfig,
  deps: PluginWireDeps,
  cwd: string = process.cwd(),
): Promise<PluginDeployTargets> {
  const awsConfig = (
    config.cloud as { provider: 'aws'; config: { account_id: string; region: string } }
  ).config
  const stateBucket =
    (awsConfig as { tf_state_bucket?: string }).tf_state_bucket ??
    `${config.project.name}-terraform-state-${awsConfig.account_id}`
  const stateKey = `${environment}/terraform.tfstate`

  log.info(`Reading Terraform outputs from s3://${stateBucket}/${stateKey}...`)
  const outputs = await deps.readOutputs(stateBucket, stateKey)
  const pluginOutputs = pluginOutputsFromRoot(pluginName, outputs)

  const targets = wireUserFacingPluginFromOutputs(cwd, environment, pluginName, pluginOutputs)

  console.log(chalk.bold(`\n  Registered "${pluginName}" CDN origins for ${environment}\n`))
  for (const path of targets.registeredPaths) console.log(`    ${chalk.green('~')} ${path}`)
  console.log(
    '\n  Commit these and redeploy so the CDN gains its behaviours (apply is pipeline-only):',
  )
  console.log(chalk.dim(`    git add ${targets.registeredPaths.join(' ')}`))
  console.log(chalk.dim(`    git commit -m "infra(cdn): route ${pluginName} (${environment})"`))
  console.log(chalk.dim(`    git push  &&  biffo deploy ${environment}\n`))
  console.log(
    `  Then build and sync the frontend to its bucket: ${chalk.bold(targets.frontendBucketName)}`,
  )
  console.log(
    chalk.dim(
      "  (the plugin's own deploy workflow does this — it reads the bucket from the same outputs.)\n",
    ),
  )
  return targets
}

export const pluginWireCommand = new Command('wire')
  .description(
    "Register a user-facing plugin's CDN origins from its deployed outputs (ADR-0018 register step): biffo plugin wire <name> <environment>",
  )
  .argument('<name>', 'Plugin name, e.g. ideation')
  .argument('<environment>', 'Target environment: dev | staging | prod')
  .option('-p, --project <name>', 'Project name (overrides biffo.config.json in current directory)')
  .option('-c, --config <path>', 'Path to biffo.config.json')
  .action(
    async (name: string, environment: string, options: { project?: string; config?: string }) => {
      if (!VALID_ENVIRONMENTS.includes(environment)) {
        log.error(
          `Unknown environment: ${environment}. Must be one of: ${VALID_ENVIRONMENTS.join(', ')}`,
        )
        process.exit(1)
      }

      const config = await resolveConfig(options)
      const aws = new AwsAdapter(config)

      try {
        await runPluginWire(name, environment, config, {
          readOutputs: (bucket, key) => aws.readTerraformOutputs(bucket, key),
        })
      } catch (err) {
        log.error((err as Error).message)
        process.exit(1)
      }
    },
  )

// Mirrors data-apply.ts / deploy.ts's resolveConfig() — see data-apply.ts for
// why this isn't a shared helper (each command resolves config independently).
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
    if (isTemplatePlaceholderConfig(raw)) {
      log.warn(
        `Ignoring ${localConfigPath} — it is the unsubstituted Biffo template placeholder, ` +
          "not this project's config.",
      )
    } else {
      log.error(`Invalid config at ${localConfigPath}:`)
      result.error.issues.forEach((i) => log.error(`  ${i.path.join('.')} — ${i.message}`))
      log.error('Refusing to fall back to a saved project while a local config file is present.')
      process.exit(1)
    }
  }

  log.error(
    'No config found. Run inside a Biffo project, or pass --project <name> / --config <path>.',
  )
  return process.exit(1)
}
