import { execSync } from 'node:child_process'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import chalk from 'chalk'
import { Command } from 'commander'
import inquirer from 'inquirer'
import { BiffoConfigSchema, resolveDnsConfig } from '../config/schema.js'
import { AwsAdapter } from '../adapters/cloud/aws/index.js'
import { GitHubAdapter } from '../adapters/source-control/github/index.js'
import { NonInteractiveError, isNonInteractive, promptOr } from '../lib/interactive.js'
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
    'Destroy all infrastructure then remove the repo, IAM role, and state bucket — single command',
  )
  .option('--project <name>', 'Project name to tear down (reads session if omitted)')
  .option('--skip-destroy', 'Skip terraform destroy (only use if infrastructure is already gone)')
  .option(
    '--confirm <name>',
    'Pre-confirm by supplying the project name (the scriptable form of the typed confirmation)',
  )
  .option('-y, --yes', 'Skip the typed project-name confirmation entirely')
  .action(
    async (options: {
      project?: string
      skipDestroy?: boolean
      confirm?: string
      yes?: boolean
    }) => {
      console.log(chalk.bold('\n  Biffo — Teardown\n'))

      const githubToken = resolveGithubToken()
      const sts = new STSClient({})
      const { Account: accountId } = await sts.send(new GetCallerIdentityCommand({}))

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
          : (pickSoleProjectConfig() ?? null)

      if (session?.config.project?.name) {
        const sc = session.config.source_control as
          { provider: 'github'; config: { org: string; repo: string } } | undefined
        projectName = session.config.project.name
        org = sc?.config.org ?? ''
        repo = sc?.config.repo ?? ''
        region = session.awsRegion
        adminEmail =
          (session.config.admin as { email: string } | undefined)?.email ?? 'noop@example.com'
        adminUsername =
          (session.config.admin as { username: string } | undefined)?.username ?? 'noop'
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
        domain = resolveDnsConfig(savedConfig).domain
        console.log(chalk.yellow('  Loaded config for: ') + chalk.bold(projectName))
        console.log(`  Repository: ${org}/${repo}`)
        console.log()
      } else {
        const answers = await promptOr<Record<string, string>>(
          {
            question: 'Project details for teardown',
            remedy:
              'Pass --project <name> to tear down a project saved in ~/.biffo/projects/, ' +
              'or run biffo init first.',
          },
          [
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
              default:
                process.env['AWS_DEFAULT_REGION'] ?? process.env['AWS_REGION'] ?? 'us-east-1',
            },
            { type: 'input', name: 'admin_email', message: 'Admin email (for TF vars):' },
            { type: 'input', name: 'admin_username', message: 'Admin username (for TF vars):' },
          ],
        )
        projectName = answers.project_name as string
        org = answers.org as string
        repo = answers.repo as string
        region = answers.region as string
        adminEmail = answers.admin_email as string
        adminUsername = answers.admin_username as string
        domain = ''
      }

      const config = BiffoConfigSchema.safeParse({
        project: { name: projectName, description: '', domain: domain || undefined },
        dns: { mode: domain ? 'managed-route53' : 'none', domain: domain || undefined },
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

      const allDeployed = options.skipDestroy
        ? []
        : await aws.listDeployedEnvironments(stateBucket).catch(() => [])
      const deployedEnvs = allDeployed.filter((e) => e !== 'global')
      const hasGlobal = allDeployed.includes('global')

      // Show everything that will be deleted in one confirmation
      console.log(chalk.red.bold('  This will permanently delete:\n'))
      if (deployedEnvs.length > 0 || hasGlobal) {
        console.log(chalk.red('  Infrastructure (via GitHub Actions terraform destroy):'))
        for (const env of deployedEnvs) {
          console.log(
            `    ${chalk.red('✗')} ${env} — VPC, RDS, Lambda, Cognito, CloudFront, EventBridge`,
          )
        }
        if (hasGlobal) {
          console.log(`    ${chalk.red('✗')} global — Route 53 hosted zone, ACM certificate`)
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

      if (!(await confirmTeardown(projectName, options))) {
        log.warn('Teardown cancelled — project name did not match')
        return
      }

      // Trigger destroy workflows before deleting the repo — the repo must still exist
      // to run the workflow. Each env is destroyed sequentially so we can detect failures.
      if (deployedEnvs.length > 0) {
        const actionsUrl = `https://github.com/${org}/${repo}/actions`
        for (const env of deployedEnvs) {
          const envBranch: Record<string, string> = { dev: 'dev', staging: 'staging', prod: 'main' }
          const branch = envBranch[env] ?? 'dev'

          log.info(`\nDestroying ${env} infrastructure (20–30 min for first run)...`)
          log.info(`  Watch live: ${actionsUrl}`)

          let baselineId: number | undefined
          try {
            baselineId = await github.getLatestWorkflowRunId(org, repo, 'destroy-infra.yml')
          } catch {
            log.error(`destroy-infra.yml workflow not found in ${org}/${repo}.`)
            log.error(
              '  Merge the PR at https://github.com/keiranholloway/biffo-core/pull/1 first,',
            )
            log.error('  or re-run with --skip-destroy if infrastructure is already gone.')
            process.exit(1)
          }

          await github.triggerWorkflow(org, repo, 'destroy-infra.yml', { environment: env }, branch)

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
            log.error(`Destroy workflow ${result.conclusion ?? 'failed'} for ${env}.`)
            log.error(`  Run details: ${actionsUrl}/runs/${result.id}`)
            log.error('  Fix the issue and re-run biffo teardown, or use --skip-destroy.')
            process.exit(1)
          }

          log.success(`${env} infrastructure destroyed`)
        }
      }

      // Destroy global infrastructure (Route 53 zone + ACM cert) if deployed and domain is set
      if (!options.skipDestroy && hasGlobal && domain && domain !== 'example.com') {
        log.info('\nDestroying global infrastructure (Route 53 + ACM)...')
        try {
          const baselineGlobal = await github.getLatestWorkflowRunId(
            org,
            repo,
            'destroy-global.yml',
          )
          await github.triggerWorkflow(org, repo, 'destroy-global.yml', {}, 'main')
          const globalResult = await github.waitForWorkflowRun(
            org,
            repo,
            'destroy-global.yml',
            baselineGlobal,
            600_000,
            20_000,
            'main',
          )
          if (globalResult.conclusion !== 'success') {
            log.warn(
              `Global infrastructure destroy ${globalResult.conclusion ?? 'failed'} — continuing teardown anyway`,
            )
          } else {
            log.success('Global infrastructure destroyed')
          }
        } catch {
          log.warn('destroy-global.yml not found — skipping global infrastructure teardown')
        }
      }

      // All infrastructure gone — now safe to delete the repo and supporting resources
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
    },
  )

/**
 * Pick the saved project config when no `--project` was given.
 *
 * Interactively this keeps the historical behaviour of taking the first saved
 * config (the typed confirmation still shows which project it landed on, so a
 * wrong guess is caught before anything is deleted). Non-interactively there is
 * no such backstop and silently tearing down "whichever came first" is not an
 * acceptable default, so an ambiguous store is an error naming the candidates.
 */
function pickSoleProjectConfig(): ReturnType<typeof listProjectConfigs>[number] | undefined {
  const configs = listProjectConfigs()
  if (configs.length > 1 && isNonInteractive()) {
    throw new NonInteractiveError(
      'Refusing to guess which project to tear down — --non-interactive is set and ' +
        `${configs.length} projects are saved in ~/.biffo/projects/.\n` +
        '  Pass --project <name>. Available:\n' +
        configs.map((c) => `    ${c.project.name}`).join('\n'),
    )
  }
  return configs[0]
}

export interface TeardownConfirmOptions {
  confirm?: string
  yes?: boolean
}

/**
 * Decide whether teardown is confirmed (issue #274).
 *
 * The typed project-name confirmation is deliberate friction on a destructive
 * command and stays the **default**: a bare `biffo teardown` still demands it.
 * Two explicit opt-outs make it scriptable without weakening that default:
 *
 *   --confirm <name>  keeps the friction — the caller must still name the exact
 *                     project, and a mismatch aborts just as a mistyped prompt
 *                     would. This is the preferred form for automation.
 *   --yes             skips the confirmation outright, for callers that have
 *                     already gated the operation themselves.
 *
 * Under `--non-interactive` with neither flag, this throws rather than hanging
 * on a prompt no one is there to answer.
 *
 * Exported for testing.
 */
export async function confirmTeardown(
  projectName: string,
  options: TeardownConfirmOptions,
): Promise<boolean> {
  if (options.confirm !== undefined) {
    if (options.confirm !== projectName) return false
    log.info(`Confirmed via --confirm ${projectName}`)
    return true
  }

  if (options.yes) {
    log.warn(`Skipping typed confirmation for ${projectName} — --yes was passed`)
    return true
  }

  if (isNonInteractive()) {
    throw new NonInteractiveError(
      `Refusing to prompt for the teardown confirmation of "${projectName}" — ` +
        '--non-interactive is set.\n' +
        `  Pass --confirm ${projectName} to confirm, or --yes to skip the check.`,
    )
  }

  const { confirm } = await inquirer.prompt<{ confirm: string }>([
    {
      type: 'input',
      name: 'confirm',
      message: `Type ${chalk.bold(projectName)} to confirm:`,
    },
  ])

  return confirm === projectName
}

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
