import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import { BiffoConfigSchema, resolveDnsConfig, type BiffoConfig } from '../config/schema.js'
import { AwsAdapter } from '../adapters/cloud/aws/index.js'
import { GitHubAdapter } from '../adapters/source-control/github/index.js'
import {
  NonInteractiveError,
  isNonInteractive,
  nonInteractiveMessage,
  promptOr,
} from '../lib/interactive.js'
import { isTemplatePlaceholderConfig } from '../lib/local-config.js'
import { log } from '../lib/logger.js'
import { listProjectConfigs, loadProjectConfig } from '../lib/session.js'
import { GLOBAL_DISPATCH_REF } from '../lib/global-workflows.js'
import {
  CORE_VERSION_FILE,
  INSTANCE_CORE_FILE,
  compareCoreVersions,
  parseCoreVersion,
} from '../lib/core-version.js'
import {
  coreWiringFromOutputs,
  formatWiringResult,
  SiblingResolutionError,
  wireSiblingsAfterCoreDeploy,
} from '../lib/sibling-wiring.js'

export const deployCommand = new Command('deploy')
  .description('Deploy infrastructure and application to an environment')
  .argument('<environment>', 'Target environment: dev | staging | prod')
  .option('--infra-only', 'Deploy infrastructure only, skip application build')
  .option('--app-only', 'Deploy application only, skip Terraform')
  .option('-p, --project <name>', 'Project name (overrides biffo.config.json in current directory)')
  .option('-c, --config <path>', 'Path to biffo.config.json')
  .option('-y, --yes', 'Skip deployment target confirmation')
  .action(
    async (
      environment: string,
      options: {
        infraOnly?: boolean
        appOnly?: boolean
        project?: string
        config?: string
        yes?: boolean
      },
    ) => {
      // Defensive default (issue #1066). Some failures on this path never reach
      // any catch — not this action's, not the top-level one in index.ts. When
      // inquirer's picker prompt has its stdin torn out from under it (closed /
      // non-TTY stdin, e.g. a script or cron job), it rejects with
      // `ExitPromptError` from *inside Node's own process-exit sequence*
      // (`signal-exit`'s `onExit`, fired as the event loop drains). Node does not
      // run further microtasks after that point, so that rejection never reaches
      // any `.catch` — proven by instrumenting this exact path — and the process
      // exits 0 despite having failed. Arming a non-zero exit code up front, and
      // clearing it only on a confirmed outcome below, is the one thing that
      // survives that path: it needs no callback to run at exit time.
      process.exitCode = 1

      const validEnvs = ['dev', 'staging', 'prod']
      if (!validEnvs.includes(environment)) {
        log.error(`Unknown environment: ${environment}. Must be one of: ${validEnvs.join(', ')}`)
        process.exit(1)
      }

      const config = await resolveConfig(options)

      console.log(chalk.bold(`\n  Biffo — Deploy to ${environment}\n`))
      if (!options.yes && !(await confirmDeployTarget(config, environment))) {
        log.warn('Deploy cancelled')
        process.exitCode = 0 // an intentional cancel is not a failure
        return
      }

      const token = resolveGithubToken()
      const github = new GitHubAdapter(token)
      const aws = new AwsAdapter(config)

      await runDeploy(github, aws, config, environment, { ...options, token })
      process.exitCode = 0
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

  // Try ./biffo.config.json. If it exists but is invalid, stop rather than silently
  // falling back to another saved project.
  const localConfigPath = resolve(process.cwd(), 'biffo.config.json')
  if (existsSync(localConfigPath)) {
    const raw = JSON.parse(readFileSync(localConfigPath, 'utf8'))
    const result = BiffoConfigSchema.safeParse(raw)
    if (result.success) return result.data
    // The template's own unsubstituted placeholder file is not a config at all
    // — it is a template artifact GitHub copied in verbatim. Treat it as absent
    // and fall through to the saved project, which is where the resolved config
    // actually lives (issue #269).
    if (isTemplatePlaceholderConfig(raw)) {
      log.warn(
        `Ignoring ${localConfigPath} — it is the unsubstituted Biffo template placeholder, ` +
          "not this project's config.",
      )
    } else {
      log.error(`Invalid config at ${localConfigPath}:`)
      result.error.issues.forEach((i) => log.error(`  ${i.path.join('.')} — ${i.message}`))
      log.error('Refusing to fall back to a saved project while a local config file is present.')
      log.error('Fix biffo.config.json, or pass --project <name> / --config <path> explicitly.')
      process.exit(1)
    }
  }

  // Fall back to ~/.biffo/projects/
  const projects = listProjectConfigs()
  if (projects.length === 0) {
    log.error(
      'No biffo.config.json found in the current directory and no projects in ~/.biffo/projects/.',
    )
    log.error('Run biffo init first, or pass --project <name> or --config <path>.')
    log.error(
      "A Biffo instance's resolved config is not committed to its repo — it lives in " +
        '~/.biffo/projects/ on the machine that ran biffo init. On a second machine, copy it ' +
        'there or pass it with --config <path>.',
    )
    process.exit(1)
  }

  if (projects.length === 1) {
    log.info(`Using project: ${projects[0]!.project.name}`)
    return projects[0]!
  }

  // Multiple projects — ask which one (or, non-interactively, refuse and list them)
  return chooseProject(projects)
}

/** `<name> (<org>/<repo>)` — the label used in both the picker and the refusal. */
export function describeProject(config: BiffoConfig): string {
  const { org, repo } = (
    config.source_control as { provider: 'github'; config: { org: string; repo: string } }
  ).config
  return `${config.project.name} (${org}/${repo})`
}

/**
 * Disambiguate between saved projects.
 *
 * With `--non-interactive` this throws with the candidate list rather than
 * prompting (issue #274). The old behaviour was a latent trap: with exactly one
 * saved project it auto-selects, so a script that worked on a one-project
 * machine hung on a two-project machine, at deploy time.
 *
 * `--non-interactive` is one way to ask for that; the absence of a real
 * terminal is another, and `promptOr`'s own guard (`assertInteractive`) cannot
 * see it — it only reads the flag/env, not stdin. Without a check here, a
 * script or cron job that never passed the flag still reaches
 * `inquirer.prompt`, whose stdin then hits immediate EOF. That does not fail
 * like a normal rejection: inquirer's `create-prompt` rejects with
 * `ExitPromptError` from *inside Node's own process-exit sequence*
 * (`signal-exit`'s `onExit`), a point after which Node runs no further
 * microtasks — so neither this function's caller nor `index.ts`'s top-level
 * `.catch` ever observes it, and the process exits 0 despite failing (issue
 * #1066). The fix is to never create that prompt in the first place when
 * nothing could answer it.
 *
 * `isTTY` defaults to the real terminal state and exists as a parameter only
 * so tests can drive both branches deterministically.
 *
 * Exported for testing.
 */
export async function chooseProject(
  projects: BiffoConfig[],
  isTTY: boolean = Boolean(process.stdin.isTTY),
): Promise<BiffoConfig> {
  const question = 'Which project do you want to deploy?'
  const remedy =
    'Pass --project <name> to choose one. Available:\n' +
    projects.map((p) => `    ${describeProject(p)}`).join('\n')

  if (isNonInteractive()) {
    throw new NonInteractiveError(nonInteractiveMessage(question, remedy))
  }
  if (!isTTY) {
    throw new NonInteractiveError(
      `Refusing to prompt for "${question}" — no interactive terminal is attached.\n  ${remedy}`,
    )
  }

  const { chosen } = await promptOr<{ chosen: string }>(
    {
      question,
      remedy,
    },
    [
      {
        type: 'list',
        name: 'chosen',
        message: question,
        choices: projects.map((p) => ({ name: describeProject(p), value: p.project.name })),
      },
    ],
  )

  return projects.find((p) => p.project.name === chosen)!
}

async function confirmDeployTarget(config: BiffoConfig, environment: string): Promise<boolean> {
  const { org, repo } = (
    config.source_control as { provider: 'github'; config: { org: string; repo: string } }
  ).config
  const awsConfig = (
    config.cloud as { provider: 'aws'; config: { account_id: string; region: string } }
  ).config
  const dns = resolveDnsConfig(config)

  console.log(chalk.bold('  Deployment target\n'))
  console.log(`  Project:     ${chalk.cyan(config.project.name)}`)
  console.log(`  Repository:  ${chalk.cyan(`${org}/${repo}`)}`)
  console.log(`  Environment: ${chalk.cyan(environment)}`)
  console.log(`  AWS account: ${chalk.cyan(awsConfig.account_id)}`)
  console.log(`  AWS region:  ${chalk.cyan(awsConfig.region)}`)
  console.log(`  DNS mode:    ${chalk.cyan(dns.mode)}`)
  if (dns.domain) console.log(`  Domain:      ${chalk.cyan(dns.domain)}`)
  console.log()

  const { confirmed } = await promptOr<{ confirmed: boolean }>(
    {
      question: 'Deploy to this target?',
      remedy: 'Pass -y / --yes to pre-confirm the deployment target.',
    },
    [
      {
        type: 'confirm',
        name: 'confirmed',
        message: 'Deploy to this target?',
        default: false,
      },
    ],
  )

  return confirmed
}

// ─── Exported for testing ────────────────────────────────────────────────────

/**
 * When a deploy run failed at `sts:AssumeRoleWithWebIdentity`, say so plainly.
 *
 * `configure-aws-credentials` reports only "Not authorized to perform
 * sts:AssumeRoleWithWebIdentity" and CloudTrail logs "An unknown error
 * occurred" — neither names the `sub` the token presented, which is the one
 * fact that identifies a trust-policy mismatch. Issue #271 was exactly this and
 * cost a long investigation; roles written by an older CLI trust only the
 * legacy subject format and are repaired by re-running `biffo init`.
 *
 * Exported for testing. Never throws — a diagnostic must not mask the real
 * failure it is annotating.
 */
export async function reportOidcHint(
  github: GitHubAdapter,
  org: string,
  repo: string,
  runId: number,
): Promise<void> {
  if (!(await github.hasOidcAssumeRoleFailure(org, repo, runId))) return
  log.error('')
  log.error('  This run failed to assume the AWS OIDC role (sts:AssumeRoleWithWebIdentity).')
  log.error('  The usual cause is a trust policy that does not match the OIDC subject')
  log.error("  GitHub presents. Compare the role's trusted subjects against the run's:")
  log.error(`    aws iam get-role --role-name biffo-github-actions-${'${PROJECT_NAME}'}`)
  log.error('  A role created by an older biffo trusts only repo:<org>/<repo>:*, which')
  log.error('  cannot match GitHub\'s ID-qualified "repo:<org>@<id>/<repo>@<id>:*" form.')
  log.error('  Re-run `biffo init` to rewrite the trust policy with both patterns.')
  log.error('')
}

/**
 * The core version an instance repo records at a git `ref`, read over the API.
 *
 * Mirrors `readInstanceCoreVersion` (the local-filesystem reader) but sources
 * the bytes from GitHub at a specific ref, so `biffo deploy` can compare the
 * version on the branch it dispatches from against the branch it deploys.
 *
 * `biffo.core.json` is the authority. The inherited `core.version` is consulted
 * **only when that record is absent** — never when it is present and unreadable
 * (#788).
 *
 * ## Why a malformed record must not fall back
 *
 * `core.version` is a fossil. It was written once at `biffo init` and never
 * maintained; the template stopped shipping it entirely at #423. In
 * `biffo-platform` it still reads `0.41.17` against a real version of `0.155.0`
 * — **114 minor versions wrong**, in a top-level file whose entire content is a
 * version number, with nothing about it signalling that it is dead. It has
 * already misled a reader who had the code in front of them.
 *
 * Falling back to it on a *malformed* record turns a bug that should be loud
 * into a plausible wrong answer: the caller compares two versions and warns
 * about a mismatch that is an artefact of reading a fossil. A garbled record is
 * a defect to surface, not a cue to trust something older. So a present record
 * that cannot be read yields `null` — which the caller already treats as "cannot
 * compare", the behaviour this docstring always claimed.
 *
 * Returns null when the version cannot be established at that ref — a
 * missing/garbled version must never fabricate a mismatch.
 *
 * Exported for testing.
 */
export async function readRemoteCoreVersion(
  github: GitHubAdapter,
  org: string,
  repo: string,
  ref: string,
): Promise<string | null> {
  const record = await github.getFileContent(org, repo, INSTANCE_CORE_FILE, ref)
  if (record) {
    try {
      const parsed = JSON.parse(record) as { version?: unknown }
      if (typeof parsed.version === 'string') {
        parseCoreVersion(parsed.version) // validate
        return parsed.version
      }
    } catch {
      /* fall through to the null below — see the header on why NOT to the fossil */
    }
    // The record exists and could not be read. That is a defect worth
    // surfacing, not a reason to believe a file nobody has maintained since
    // `biffo init` (#788).
    return null
  }
  const inherited = await github.getFileContent(org, repo, CORE_VERSION_FILE, ref)
  if (inherited) {
    try {
      const version = inherited.trim()
      parseCoreVersion(version) // validate
      return version
    } catch {
      return null
    }
  }
  return null
}

/**
 * Guard for issue #328.
 *
 * `biffo deploy` dispatches some workflows (`deploy-global.yml`) from a FIXED
 * branch (`GLOBAL_DISPATCH_REF`, i.e. `main`) regardless of the environment,
 * while `biffo core upgrade` lands its PR on the instance's default branch
 * (often `dev`). A template fix to such a workflow therefore reaches `dev` but
 * is executed from `main`, so the OLD workflow keeps running — silently,
 * because the upgrade PR was green and merged clean. This bit the #322
 * terraform-hang validation: the fix was on `dev`, the deploy ran the unfixed
 * copy from `main`, and it looked like the fix hadn't worked.
 *
 * The mismatch is mechanically detectable at dispatch time: compare the core
 * version recorded on the fixed dispatch ref against the branch being deployed.
 * If the dispatch ref is behind, an upgrade has not been promoted and this
 * deploy will run stale code — say so, loudly, before dispatching.
 *
 * Never throws: a diagnostic must not abort or mask the deploy it annotates.
 * Exported for testing.
 */
export async function warnIfDispatchRefStale(
  github: GitHubAdapter,
  org: string,
  repo: string,
  workflowFile: string,
  dispatchRef: string,
  deployBranch: string,
): Promise<void> {
  if (dispatchRef === deployBranch) return
  let refVersion: string | null
  let branchVersion: string | null
  try {
    ;[refVersion, branchVersion] = await Promise.all([
      readRemoteCoreVersion(github, org, repo, dispatchRef),
      readRemoteCoreVersion(github, org, repo, deployBranch),
    ])
  } catch {
    return // can't compare — never block or mislead the deploy over a diagnostic
  }
  if (!refVersion || !branchVersion) return
  if (compareCoreVersions(refVersion, branchVersion) >= 0) return

  log.warn('')
  log.warn(
    `  ${workflowFile} is dispatched from '${dispatchRef}', but '${dispatchRef}' is on core ` +
      `${refVersion} while '${deployBranch}' (deploying now) is on core ${branchVersion}.`,
  )
  log.warn(
    `  A core upgrade landed on '${deployBranch}' that has not reached '${dispatchRef}'. This deploy`,
  )
  log.warn(
    `  will run the OLDER ${workflowFile} from '${dispatchRef}', so template fixes to it will NOT`,
  )
  log.warn(
    `  take effect. Promote '${deployBranch}' → '${dispatchRef}' (open a PR from '${deployBranch}'`,
  )
  log.warn(`  into '${dispatchRef}' and merge it), then re-run this deploy. (issue #328)`)
  log.warn('')
}

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
  const dns = resolveDnsConfig(config)
  const hasGlobalInfra = dns.mode !== 'none' && Boolean(dns.domain)
  const totalSteps = skipInfra || skipApp ? 2 : hasGlobalInfra ? 5 : 4

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
      await github.setRepoVariable(org, repo, 'DNS_MODE', dns.mode)
      if (dns.domain) {
        await github.setRepoVariable(org, repo, 'DOMAIN', dns.domain)
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

  // Step 2: Deploy global infrastructure — only when a custom domain is configured.
  if (!skipInfra && hasGlobalInfra) {
    const globalLabel =
      dns.mode === 'external'
        ? 'Requesting SSL certificate for external DNS...'
        : 'Deploying global infrastructure (DNS + SSL certificate)...'
    log.step(2, totalSteps, globalLabel)
    // deploy-global runs from a FIXED branch (GLOBAL_DISPATCH_REF), not the
    // environment's branch. If a core upgrade landed on the branch we are
    // deploying but has not been promoted to that fixed branch, the dispatch
    // below runs the STALE workflow — silently (issue #328). Warn first.
    await warnIfDispatchRefStale(
      github,
      org,
      repo,
      'deploy-global.yml',
      GLOBAL_DISPATCH_REF,
      branch,
    )
    const globalBaselineId = await github.getLatestWorkflowRunId(org, repo, 'deploy-global.yml')
    await github.triggerWorkflow(org, repo, 'deploy-global.yml', {}, GLOBAL_DISPATCH_REF)
    if (dns.mode === 'external') {
      log.info('  DNS will not be changed automatically.')
      log.info('  The workflow summary will list ACM validation CNAMEs to add manually.')
    } else {
      log.info('  Provisioning Route 53 hosted zone and ACM wildcard certificate...')
    }
    log.info(`  Watch live: ${actionsUrl}`)
    const globalResult = await github.waitForWorkflowRun(
      org,
      repo,
      'deploy-global.yml',
      globalBaselineId,
      3_600_000,
      30_000,
      GLOBAL_DISPATCH_REF,
    )
    if (globalResult.conclusion !== 'success') {
      log.error(`Global infrastructure deploy ${globalResult.conclusion ?? 'failed'}.`)
      log.error(`  Run details: ${actionsUrl}/runs/${globalResult.id}`)
      await reportOidcHint(github, org, repo, globalResult.id)
      process.exit(1)
    }
    log.success(`Global infrastructure deployed (run #${globalResult.id})`)
    if (dns.mode === 'external') {
      log.info('  If the certificate is still pending, add the validation CNAMEs and rerun:')
      log.info(`  biffo deploy ${environment} --infra-only`)
    }
  }

  // Step 3 (or 2 without domain): Trigger and wait for infrastructure deploy (skip when --app-only)
  if (!skipInfra) {
    const infraStep = hasGlobalInfra ? 3 : 2
    log.step(infraStep, totalSteps, `Triggering infrastructure deploy to ${environment}...`)
    const infraBaselineId = await github.getLatestWorkflowRunId(org, repo, 'deploy-infra.yml')
    // biffo-template#1582: deploy-infra.yml's workflow_dispatch no longer
    // takes an `action` input — dispatching it always applies, exactly like
    // a push. Passing an undeclared input here would risk the API rejecting
    // the dispatch outright rather than silently ignoring it.
    await github.triggerWorkflow(org, repo, 'deploy-infra.yml', { environment }, branch)
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
      await reportOidcHint(github, org, repo, infraResult.id)
      log.error(`  Fix the issue and re-run: biffo deploy ${environment} --infra-only`)
      process.exit(1)
    }
    log.success(`Infrastructure deployed (run #${infraResult.id})`)
  }

  // Step 4 (or 3/1): Trigger and wait for application deploy (skip when --infra-only)
  if (!skipApp) {
    const step = skipInfra ? 1 : hasGlobalInfra ? 4 : 3
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
      await reportOidcHint(github, org, repo, appResult.id)
      log.error(`  Fix the issue and re-run: biffo deploy ${environment} --app-only`)
      process.exit(1)
    }
    log.success(`Application deployed (run #${appResult.id})`)
  }

  // Final step: Report outputs
  const reportStep = totalSteps
  log.step(reportStep, totalSteps, 'Reading deployment outputs...')
  let outputs: Record<string, string> | undefined
  try {
    outputs = await aws.readTerraformOutputs(stateBucket, stateKey)
    console.log(chalk.bold('\n  Deploy complete!\n'))
    if (outputs.portal_url) console.log(`  Portal:      ${chalk.cyan(outputs.portal_url)}`)
    if (outputs.api_gateway_url)
      console.log(`  API:         ${chalk.cyan(outputs.api_gateway_url)}`)
    if (dns.mode === 'external' && outputs.cloudfront_distribution_domain) {
      console.log(`  DNS target:  ${chalk.cyan(outputs.cloudfront_distribution_domain)}`)
      console.log()
      console.log(chalk.dim('  External DNS:'))
      console.log(
        chalk.dim(
          `    Add ACM validation CNAMEs from the deploy-global workflow summary if the cert is pending.`,
        ),
      )
      console.log(
        chalk.dim(
          `    After ACM is issued, point your DNS record at ${outputs.cloudfront_distribution_domain}.`,
        ),
      )
    }
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

  // Wire every registered sibling to this freshly-deployed core (issue #337).
  //
  // This is the claiming step the old init deferral never had: `biffo init`
  // creates the app sibling BEFORE any deploy, leaving its CORE_* /
  // PARENT_CLOUDFRONT_* unset, and nothing came back to fill them in — so `/`
  // shipped a frontend wired to nothing and a bucket with no policy (403).
  // Done here, outside the outputs try/catch above, so a wiring failure is
  // loud (non-zero exit) rather than swallowed as "state not readable".
  await wireSiblingsIfAny(github, config, environment, awsConfig.account_id, outputs, options.token)
}

/**
 * Resolve this environment's core identity + CDN wiring and push it to every
 * sibling registered against the core (issue #337). No-op when there are no
 * siblings. Exits non-zero — never silently — when it cannot (missing outputs,
 * an unidentifiable registry entry, or a GitHub write failure), because a
 * sibling left unwired is precisely the silent gap this closes.
 */
async function wireSiblingsIfAny(
  github: GitHubAdapter,
  config: BiffoConfig,
  environment: string,
  coreAccountId: string,
  outputs: Record<string, string> | undefined,
  token: string | undefined,
): Promise<void> {
  const { org, repo } = (
    config.source_control as { provider: 'github'; config: { org: string; repo: string } }
  ).config

  if (!outputs) {
    log.warn(
      'Skipped wiring siblings: this run produced no readable Terraform outputs ' +
        `(e.g. --app-only without a prior infra apply). Re-run \`biffo deploy ${environment}\` ` +
        'once the core infrastructure is applied so its siblings can be wired.',
    )
    return
  }
  if (!token) {
    log.warn(
      'Skipped wiring siblings: no GitHub token available to set the SIBLING_GITHUB_TOKEN secret.',
    )
    return
  }

  try {
    const wiring = coreWiringFromOutputs(outputs, coreAccountId, environment)
    const result = await wireSiblingsAfterCoreDeploy(
      github,
      org,
      repo,
      config.project.name,
      environment,
      wiring,
      token,
    )
    const lines = formatWiringResult(environment, result)
    if (lines.length > 0) {
      console.log(chalk.dim('\n  Siblings:'))
      for (const line of lines) console.log(chalk.dim(line))
      console.log()
    }
  } catch (err) {
    if (err instanceof SiblingResolutionError) {
      log.error(`Could not wire siblings: ${err.message}`)
    } else {
      log.error(`Failed to wire siblings to the deployed core: ${(err as Error).message}`)
    }
    log.error(
      `  The core deployed, but at least one sibling was not wired. Fix the cause and re-run ` +
        `\`biffo deploy ${environment}\` — wiring is idempotent.`,
    )
    process.exit(1)
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
