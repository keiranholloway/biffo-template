import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import inquirer from 'inquirer'
import { BiffoConfigSchema, resolveDnsConfig, type BiffoConfig } from '../config/schema.js'
import { AwsAdapter } from '../adapters/cloud/aws/index.js'
import { GitHubAdapter } from '../adapters/source-control/github/index.js'
import { assertBuildIsFresh } from '../lib/build-freshness.js'
import { resolveAwsCredentials, resolveGithubToken } from '../lib/credentials.js'
import { log } from '../lib/logger.js'
import {
  deleteSession,
  findLatestSession,
  markStepComplete,
  saveProjectConfig,
  saveSession,
  type InitSession,
} from '../lib/session.js'

export const initCommand = new Command('init')
  .description('Scaffold a new project from the Biffo template')
  .option('-c, --config <path>', 'Path to a pre-filled biffo.config.json')
  .option('--dry-run', 'Validate config without making any changes')
  .option('--fresh', 'Ignore any saved session and start from scratch')
  .option('-y, --yes', 'Auto-accept detected credentials without prompting (implied by --config)')
  .action(
    async (options: { config?: string; dryRun?: boolean; fresh?: boolean; yes?: boolean }) => {
      // This command creates real GitHub repos and AWS resources; never let it
      // run from a stale cli/dist (issue #190).
      try {
        assertBuildIsFresh()
      } catch (err) {
        log.error((err as Error).message)
        process.exit(1)
      }

      console.log(chalk.bold('\n  Biffo — Project Initialiser\n'))

      let session: InitSession | null = null
      let config: BiffoConfig
      let githubToken: string | undefined

      if (options.config) {
        const rawConfig = JSON.parse(readFileSync(resolve(options.config), 'utf8'))
        config = parseConfig(rawConfig)
        const { account_id: accountId, region } = (
          config.cloud as { provider: 'aws'; config: { account_id: string; region: string } }
        ).config
        session = {
          version: 1,
          config,
          awsAccountId: accountId,
          awsRegion: region,
          completedSteps: [],
          outputs: {},
        }
      } else {
        // Resolve credentials up-front — before asking any project questions —
        // so the user never fills in a long form only to hit a missing-token error.
        githubToken = await resolveGithubToken(options.yes === true)
        const { accountId, region, profile } = await resolveAwsCredentials(options.yes === true)

        if (!options.fresh) {
          // Offer to resume a saved session
          const saved = findLatestSession()
          if (saved) {
            const { resume } = await inquirer.prompt<{ resume: boolean }>([
              {
                type: 'confirm',
                name: 'resume',
                message:
                  `Resume previous init for ${chalk.bold(saved.config.project?.name ?? '?')}` +
                  ` (completed: ${saved.completedSteps.join(', ') || 'none'})?`,
                default: true,
              },
            ])
            if (resume) {
              session = saved
              session.awsAccountId = accountId
              session.awsRegion = region
              config = applyResolvedAwsCredentials(parseConfig(session.config), {
                accountId,
                region,
                profile,
              })
              session.config = config
              saveSession(session)
              console.log()
            }
          }
        }

        if (!session) {
          const rawConfig = await promptForConfig(accountId, region, profile)
          config = parseConfig(rawConfig)
          session = {
            version: 1,
            config,
            awsAccountId: accountId,
            awsRegion: region,
            completedSteps: [],
            outputs: {},
          }
          saveSession(session)
        }
      }

      config = config!

      log.success('Configuration valid')

      if (options.dryRun) {
        console.log('\n', JSON.stringify(config, null, 2))
        return
      }

      githubToken ??= await resolveGithubToken(options.yes === true || Boolean(options.config))
      const github = new GitHubAdapter(githubToken)
      const aws = new AwsAdapter(config)

      await runInit(github, aws, config, session)

      const { org, repo } = (
        config.source_control as { provider: 'github'; config: { org: string; repo: string } }
      ).config

      log.success('\nProject initialised successfully!')
      console.log(`\n  Repository: https://github.com/${org}/${repo}`)
      console.log('  Next: clone your repo and run the first deploy\n')
    },
  )

// ─── Exported for testing ────────────────────────────────────────────────────

export async function runInit(
  github: GitHubAdapter,
  aws: AwsAdapter,
  config: BiffoConfig,
  session: InitSession,
): Promise<void> {
  const totalSteps = 5

  // Step 1: Verify AWS credentials
  if (!session.completedSteps.includes('verify_credentials')) {
    log.step(1, totalSteps, 'Verifying AWS credentials...')
    await aws.verifyCredentials()
    markStepComplete(session, 'verify_credentials')
  } else {
    log.step(1, totalSteps, 'AWS credentials already verified — skipping')
  }

  // Step 2: Create GitHub repo from template
  if (!session.completedSteps.includes('create_repo')) {
    log.step(2, totalSteps, 'Creating GitHub repository...')
    const cloneUrl = await github.createRepoFromTemplate(config)
    session.outputs.cloneUrl = cloneUrl
    markStepComplete(session, 'create_repo')
  } else {
    log.step(2, totalSteps, 'GitHub repository already created — skipping')
  }

  // Step 3: Set up OIDC trust between GitHub Actions and AWS
  if (!session.completedSteps.includes('oidc_trust')) {
    log.step(3, totalSteps, 'Configuring OIDC trust...')
    const roleArn = await aws.setupOidcTrust(config)
    session.outputs.oidcRoleArn = roleArn
    config.cloud.config = {
      ...config.cloud.config,
      oidc_role_arn: roleArn,
    } as typeof config.cloud.config
    markStepComplete(session, 'oidc_trust')
  } else {
    log.step(3, totalSteps, 'OIDC trust already configured — skipping')
    if (session.outputs.oidcRoleArn) {
      config.cloud.config = {
        ...config.cloud.config,
        oidc_role_arn: session.outputs.oidcRoleArn,
      } as typeof config.cloud.config
    }
  }

  // Step 4: Bootstrap Terraform backend
  if (!session.completedSteps.includes('terraform_backend')) {
    log.step(4, totalSteps, 'Bootstrapping Terraform state backend...')
    const tfStateBucket = await aws.bootstrapTerraformBackend(config.project.name)
    session.outputs.tfStateBucket = tfStateBucket
    config.cloud.config = {
      ...config.cloud.config,
      tf_state_bucket: tfStateBucket,
    } as typeof config.cloud.config
    markStepComplete(session, 'terraform_backend')
  } else {
    log.step(4, totalSteps, 'Terraform backend already bootstrapped — skipping')
    if (session.outputs.tfStateBucket) {
      config.cloud.config = {
        ...config.cloud.config,
        tf_state_bucket: session.outputs.tfStateBucket,
      } as typeof config.cloud.config
    }
  }

  // Step 5: Configure GitHub (branches, branch protection, environments, secrets, variables)
  if (!session.completedSteps.includes('github_config')) {
    log.step(5, totalSteps, 'Configuring GitHub repository...')
    const { org, repo } = (
      config.source_control as { provider: 'github'; config: { org: string; repo: string } }
    ).config
    const dns = resolveDnsConfig(config)
    const domain = dns.domain

    // Create dev and staging branches from main, then set dev as the default
    await github.createBranch(org, repo, 'dev', 'main')
    await github.createBranch(org, repo, 'staging', 'main')
    await github.setDefaultBranch(org, repo, 'dev')

    // Branch protection must come after all three branches exist
    await github.configureBranchProtection(config)
    await github.createEnvironments(config)

    // Native GitHub security: Dependabot vulnerability alerts (free; the CI
    // gitleaks/bandit/checkov jobs and the CodeQL workflow cover the rest).
    await github.enableVulnerabilityAlerts(org, repo)

    await github.setRepoVariable(org, repo, 'DNS_MODE', dns.mode)
    if (domain) {
      await github.setRepoVariable(org, repo, 'DOMAIN', domain)
    }

    if (domain) {
      // Per-environment CUSTOM_DOMAIN so each env's infra job gets the right subdomain
      // dev → dev.domain.com, staging → staging.domain.com, prod → domain.com
      const envDomains: Record<string, string> = {
        dev: `dev.${domain}`,
        staging: `staging.${domain}`,
        prod: domain,
      }
      for (const env of config.environments) {
        const customDomain = envDomains[env] ?? ''
        if (customDomain) {
          await github.setEnvVariable(org, repo, env, 'CUSTOM_DOMAIN', customDomain)
        }
      }
    }

    if (session.outputs.oidcRoleArn) {
      await github.setRepoSecret(org, repo, 'BIFFO_OIDC_ROLE_ARN', session.outputs.oidcRoleArn)
    }
    markStepComplete(session, 'github_config')
  } else {
    log.step(5, totalSteps, 'GitHub already configured — skipping')
  }

  deleteSession(config.project.name)
  saveProjectConfig(config)
}

// ─────────────────────────────────────────────────────────────────────────────

function parseConfig(raw: unknown): BiffoConfig {
  const result = BiffoConfigSchema.safeParse(raw)
  if (!result.success) {
    log.error('Invalid configuration:')
    result.error.issues.forEach((issue) => {
      log.error(`  ${issue.path.join('.')} — ${issue.message}`)
    })
    process.exit(1)
  }
  return result.data
}

export function applyResolvedAwsCredentials(
  config: BiffoConfig,
  credentials: { accountId: string; region: string; profile?: string | undefined },
): BiffoConfig {
  return {
    ...config,
    cloud: {
      provider: 'aws',
      config: {
        ...config.cloud.config,
        account_id: credentials.accountId,
        region: credentials.region,
        ...(credentials.profile ? { profile: credentials.profile } : {}),
      },
    },
  }
}

async function promptForConfig(
  awsAccountId: string,
  awsRegion: string,
  awsProfile?: string,
): Promise<Partial<BiffoConfig>> {
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'project_name',
      message: 'Project name (lowercase kebab-case):',
      validate: (v: string) => /^[a-z0-9-]+$/.test(v) || 'Must be lowercase kebab-case',
    },
    { type: 'input', name: 'project_description', message: 'Project description:' },
    {
      type: 'list',
      name: 'dns_mode',
      message: 'DNS / custom domain mode:',
      choices: [
        {
          name: 'Managed Route53 — create DNS zone, certificate, and records automatically',
          value: 'managed-route53',
        },
        {
          name: 'External DNS — request SSL certificate and print records for manual DNS changes',
          value: 'external',
        },
        {
          name: 'None — use the default CloudFront domain only',
          value: 'none',
        },
      ],
      default: 'managed-route53',
    },
    {
      type: 'input',
      name: 'domain',
      message: 'Primary domain (e.g. myapp.com):',
      when: (a: { dns_mode?: string }) => a.dns_mode !== 'none',
      validate: (v: string) => v.trim().length > 0 || 'Domain is required for this DNS mode',
    },
    { type: 'input', name: 'github_org', message: 'GitHub org or username:' },
    { type: 'input', name: 'github_repo', message: 'Repository name (will be created):' },
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
    project: {
      name: answers.project_name as string,
      description: answers.project_description as string,
    },
    dns: {
      mode: answers.dns_mode as 'managed-route53' | 'external' | 'none',
      domain: answers.domain as string | undefined,
    },
    source_control: {
      provider: 'github',
      config: { org: answers.github_org as string, repo: answers.github_repo as string },
    },
    cloud: {
      provider: 'aws',
      config: {
        account_id: awsAccountId,
        region: awsRegion,
        ...(awsProfile ? { profile: awsProfile } : {}),
      },
    },
    environments: answers.environments as ('dev' | 'staging' | 'prod')[],
    admin: { email: answers.admin_email as string, username: answers.admin_username as string },
  }
}
