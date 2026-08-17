import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import inquirer from 'inquirer'
import { BiffoConfigSchema, resolveDnsConfig, type BiffoConfig } from '../config/schema.js'
import { AwsAdapter } from '../adapters/cloud/aws/index.js'
import { GitHubAdapter } from '../adapters/source-control/github/index.js'
import { assertBuildIsFresh } from '../lib/build-freshness.js'
import { reportBranchProtectionSummary } from '../lib/branch-protection-outcome.js'
import { resolveAwsCredentials, resolveGithubToken } from '../lib/credentials.js'
import {
  getLatestCoreVersion,
  serializeInstanceCoreVersion,
  INSTANCE_CORE_FILE,
} from '../lib/core-version.js'
import { assertInteractive, promptOr } from '../lib/interactive.js'
import { log } from '../lib/logger.js'
import { resolveRepoIds } from '../lib/oidc.js'
import {
  bucketRegionalDomain,
  rootSiblingProjectName,
  ROOT_SIBLING_NAME,
  serializeRegistry,
  siteBucketName,
} from '../lib/root-sibling.js'
import {
  deleteSession,
  findLatestSession,
  hasCompleted,
  loadSession,
  markStepComplete,
  saveProjectConfig,
  saveSession,
  type InitSession,
} from '../lib/session.js'
import { SiblingConfigSchema, type SiblingConfig } from '../config/sibling-schema.js'
import { GitAdapter } from '../adapters/git/index.js'
import { deleteSiblingSession } from '../lib/sibling-session.js'
import {
  defaultSiblingTemplateRoot,
  runSiblingCreate,
  type SiblingCreateGit,
} from './sibling-create.js'

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

        session = resolveConfigFileSession(config, accountId, region, options.fresh === true)
      } else {
        // Resolve credentials up-front — before asking any project questions —
        // so the user never fills in a long form only to hit a missing-token error.
        githubToken = await resolveGithubToken(options.yes === true)
        const { accountId, region, profile } = await resolveAwsCredentials(options.yes === true)

        if (!options.fresh) {
          // Offer to resume a saved session
          const saved = findLatestSession()
          if (saved) {
            const { resume } = await promptOr<{ resume: boolean }>(
              {
                question: 'Resume previous init?',
                remedy:
                  'Pass --fresh to ignore the saved session, or --config <path> to init from a file.',
              },
              [
                {
                  type: 'confirm',
                  name: 'resume',
                  message:
                    `Resume previous init for ${chalk.bold(saved.config.project?.name ?? '?')}` +
                    ` (completed: ${saved.completedSteps.join(', ') || 'none'})?`,
                  default: true,
                },
              ],
            )
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
          // See the note on the --config branch: monotonic saves mean a fresh
          // start has to discard the old file explicitly.
          deleteSession(config.project.name)
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

      // Printed BEFORE anything is created, not summarised afterwards: `init`
      // now creates two GitHub repositories, and a second repo is a second
      // thing to leak if the run is abandoned partway. Purely informational —
      // no new prompt, so `--config`/`-y`/non-interactive runs (#274) are
      // unaffected.
      printPlan(config)

      if (options.dryRun) {
        console.log('\n', JSON.stringify(config, null, 2))
        return
      }

      githubToken ??= await resolveGithubToken(options.yes === true || Boolean(options.config))
      const github = new GitHubAdapter(githubToken)
      const aws = new AwsAdapter(config)

      // `finally`, not a plain call after: an init that dies at a later step
      // has still already created and (not) protected a repo, and that is
      // exactly the run whose operator most needs to be told (#715).
      // `reportBranchProtectionSummary` drains, so the copy at the end of
      // `runInit` and this one never double-print.
      try {
        await runInit(github, aws, config, session, {
          git: new GitAdapter(),
          awsFor: (siblingConfig) => new AwsAdapter(siblingConfig),
          skeletonRoot: defaultSiblingTemplateRoot(),
          githubToken,
        })
      } finally {
        reportBranchProtectionSummary()
      }

      const { org, repo } = (
        config.source_control as { provider: 'github'; config: { org: string; repo: string } }
      ).config
      const appRepo = rootSiblingProjectName(config.project.name)

      log.success('\nProject initialised successfully!')
      console.log(`\n  Platform:    https://github.com/${org}/${repo}`)
      console.log(`  Application: https://github.com/${org}/${appRepo}   (serves /)`)
      console.log(
        '\n  Next:\n' +
          '  1. Clone the platform repo and run `biffo deploy dev` — /admin and /login come up, and\n' +
          '     the same deploy wires the application repo (its CORE_* identity, the parent CloudFront\n' +
          '     ARN, and the SIBLING_GITHUB_TOKEN secret) automatically.\n' +
          "  2. Then run the application repo's Deploy workflow — no manual variable/secret setup is\n" +
          '     needed. Until it deploys, / has no content and 404s; that window is expected.\n',
      )
    },
  )

// ─── Exported for testing ────────────────────────────────────────────────────

/**
 * The session a `biffo init --config <path>` run should operate on.
 *
 * `--config` used to build a brand-new zero-step session unconditionally and
 * then save it over whatever was on disk (issue #316). A resume therefore
 * restarted from step 2 and rewrote a five-step session file as a four-step
 * one, losing `github_config` even though that work had demonstrably happened
 * in the repo — then re-attempted it against git state that had moved on,
 * which is what produced `GitRPC::BadObjectState`.
 *
 * `--config` says where the CONFIG comes from. It has never said anything
 * about the session, and non-interactive runs are precisely the ones that most
 * need to resume rather than redo. So it resumes like every other path, and
 * `--fresh` is the one and only way to discard a session.
 *
 * The config file still wins on config: a resumed session takes its `config`,
 * account and region from the file, not from the saved copy. Only the
 * checkpoints and outputs are inherited.
 */
export function resolveConfigFileSession(
  config: BiffoConfig,
  awsAccountId: string,
  awsRegion: string,
  fresh: boolean,
): InitSession {
  const saved = fresh ? null : loadSession(config.project.name)

  const session: InitSession = saved
    ? { ...saved, config, awsAccountId, awsRegion }
    : { version: 1, config, awsAccountId, awsRegion, completedSteps: [], outputs: {} }

  if (saved) {
    console.log(
      chalk.dim(
        `  Resuming previous init for ${config.project.name} ` +
          `(completed: ${saved.completedSteps.join(', ') || 'none'})\n`,
      ),
    )
  } else {
    // Saves are monotonic (see `saveSession`), so a stale file would otherwise
    // merge its old steps into this run. Starting over means saying so on disk.
    deleteSession(config.project.name)
  }

  saveSession(session)
  return session
}

export async function runInit(
  github: GitHubAdapter,
  aws: AwsAdapter,
  config: BiffoConfig,
  session: InitSession,
  /**
   * Supplied by the `init` command itself. Optional only so that unit tests
   * can exercise the five core steps in isolation without a git adapter and a
   * skeleton on disk — note that step 5 registers the app sibling on the CDN
   * either way, because registration is derived from config alone. Omitting
   * these skips creating the sibling's *repo*, never its registration.
   */
  appSibling?: AppSiblingDeps,
): Promise<void> {
  const totalSteps = appSibling ? 7 : 6

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
    const roleArn = await aws.setupOidcTrust(config, await resolveRepoIds(github, config))
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

  // Step 5: Configure GitHub (branches, instance files, protection, environments,
  // secrets, variables).
  //
  // Three checkpoints, not one (issue #316). This step used to guard ~15 side
  // effects behind a single `github_config` marker, so any failure within it
  // replayed all of them on the next run — including the git-object writes,
  // which is how a resume ended up asking GitHub to build a tree on a base it
  // no longer agreed with (GitRPC::BadObjectState). The split is at the two
  // boundaries that matter: branch creation, git writes, and everything else.
  const { org, repo } = (
    config.source_control as { provider: 'github'; config: { org: string; repo: string } }
  ).config

  // Step 5a: branches. `createBranch` already returns early when the branch
  // exists, so the two calls share one checkpoint safely.
  if (!hasCompleted(session, 'github_branches')) {
    log.step(5, totalSteps, 'Creating the staging and main branches...')
    // The repo is generated from the template, whose default (and only) branch
    // is `dev` (#559), so `dev` already exists as the integration branch. Cut
    // `staging` and `main` off it as promotion targets: `dev` → `staging` →
    // `main`. `main` is the production branch — reserved, and unused until a
    // production environment is actually built.
    await github.createBranch(org, repo, 'staging', 'dev')
    await github.createBranch(org, repo, 'main', 'dev')
    markStepComplete(session, 'github_branches')
  } else {
    log.step(5, totalSteps, 'Branches already created — skipping')
  }

  // Step 5b: the repo's instance identity, on every branch, *before* branch
  // protection is configured (issue #269): add biffo.core.json (the instance
  // marker) and drop the template's placeholder biffo.config.json.
  //
  // Its own checkpoint because it is the only part of step 5 that writes git
  // objects, and therefore the only part whose replay depends on the repo's
  // git state not having moved underneath it.
  if (!hasCompleted(session, 'github_instance_files')) {
    log.step(5, totalSteps, 'Writing instance identity files...')
    await writeInstanceFiles(github, org, repo, config)
    markStepComplete(session, 'github_instance_files')
  } else {
    log.step(5, totalSteps, 'Instance identity files already written — skipping')
  }

  // Step 5c: everything else. One checkpoint, deliberately: every call below is
  // an idempotent upsert (repos.update, PUT protection/environments/alerts,
  // PATCH-then-POST variables, `gh secret set`), so replaying a partial run
  // costs a few API calls and changes nothing.
  if (!hasCompleted(session, 'github_settings')) {
    log.step(5, totalSteps, 'Configuring GitHub repository...')
    const dns = resolveDnsConfig(config)
    const domain = dns.domain

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
    markStepComplete(session, 'github_settings')
  } else {
    log.step(5, totalSteps, 'GitHub already configured — skipping')
  }

  // Step 6: Create the root application sibling's own repo (issue #306).
  //
  // Deliberately AFTER step 5, which already registered it on the core's CDN.
  // That ordering is the safety property:
  //
  //   registration without a repo → harmless and self-correcting. The CDN
  //     names an origin whose bucket does not exist yet, so `/` errors until
  //     the first deploy — the accepted window (decision 3) — and teardown
  //     still discovers the entry, finds no repo (`repoState: 'gone'`), and
  //     reclaims the IAM role and state bucket. Re-running `init` resumes and
  //     creates the repo.
  //   a repo without registration → a repo nothing points at and nothing knows
  //     about. `biffo teardown` reads the registry to find siblings, so an
  //     unregistered repo is exactly the silent leak this issue exists to
  //     prevent.
  //
  // So the cheap, reversible, derived half goes first, and the half that
  // creates real resources goes second. A crash anywhere in between leaves the
  // recoverable state, never the leaking one.
  if (appSibling) {
    if (!session.completedSteps.includes('app_sibling')) {
      log.step(6, totalSteps, 'Creating the application sibling repository...')
      await createAppSibling(github, config, session, appSibling)
      markStepComplete(session, 'app_sibling')
    } else {
      log.step(6, totalSteps, 'Application sibling already created — skipping')
    }
  }

  // Step 7: close the scaffold-time admin bypass (#1058).
  //
  // `configureBranchProtection` (step 5c) applies `enforce_admins: false` on
  // purpose, so that a RESUMED run's `writeInstanceFiles` can still commit to
  // branches an earlier attempt already protected. That is right for the
  // duration of the scaffold and wrong for ever after — and "for ever after" is
  // what it used to mean, because nothing closed it. 26 of 27 estate branches
  // ran advisory-only on the strength of it (#1052).
  //
  // **This must stay last, after every git-object write.** That single ordering
  // fact is what preserves resumability, and it is worth stating as an
  // invariant rather than a hope:
  //
  //   - interrupted BEFORE the seal → branches are still unsealed, so a resumed
  //     run's writes succeed exactly as they do today;
  //   - interrupted AFTER the seal → every write step is already checkpointed,
  //     so a resumed run has nothing left to write.
  //
  // The only git-object write in this command is step 5b, which carries its own
  // checkpoint precisely because it is the only one. `init.test.ts` asserts the
  // ordering so a future step inserted after this one cannot quietly break it.
  //
  // Checkpointed like any other step: sealing is idempotent, but a resumed run
  // that has already sealed should say "skipping" rather than re-issuing three
  // API calls and re-reporting a summary for work it did not do.
  if (!hasCompleted(session, 'github_protection_sealed')) {
    log.step(7, totalSteps, 'Binding branch protection to admins...')
    await github.sealBranchProtection(org, repo)
    markStepComplete(session, 'github_protection_sealed')
  } else {
    log.step(7, totalSteps, 'Branch protection already binds admins — skipping')
  }

  // The last thing the run does, and deliberately not a step: a scaffolding run
  // must not be able to finish quietly having left a repo unprotected (#715) or
  // protected-but-advisory (#1058).
  // No-op when the nested `runSiblingCreate` above already drained it.
  reportBranchProtectionSummary()

  deleteSession(config.project.name)
  saveProjectConfig(config)
}

/**
 * Provision the app sibling's repo through the same `runSiblingCreate` path
 * `biffo sibling create` uses — one code path, not a parallel reimplementation
 * that can drift.
 *
 * Two steps of that flow are skipped, and only these two:
 *
 *   - **core identity** — read from the core's *deployed* Terraform outputs,
 *     which do not exist during `init`. Deferred, not faked.
 *   - **registration** — already done, in step 5, directly in the core repo.
 *
 * The sibling's own step checkpoints live inside `session.outputs.appSibling`,
 * so an `init` interrupted midway through this resumes at the sibling step it
 * reached rather than trying to re-create a repo that already exists.
 */
async function createAppSibling(
  github: GitHubAdapter,
  config: BiffoConfig,
  session: InitSession,
  deps: AppSiblingDeps,
): Promise<void> {
  const siblingConfig = appSiblingConfig(config)
  const cloud = config.cloud as { provider: 'aws'; config: { account_id: string; region: string } }

  if (!session.outputs.appSibling) {
    // `runSiblingCreate` also checkpoints to ~/.biffo/sibling-sessions/<name>.json,
    // and those saves are monotonic (issue #316). A leftover file from an
    // earlier, unrelated run of this sibling name would otherwise merge its
    // steps into this brand-new one and skip work that has not happened.
    deleteSiblingSession(siblingConfig.project.name)
  }
  session.outputs.appSibling ??= {
    version: 1,
    config: siblingConfig,
    awsAccountId: cloud.config.account_id,
    awsRegion: cloud.config.region,
    completedSteps: [],
    outputs: {},
  }
  const siblingSession = session.outputs.appSibling
  const siblingAws = deps.awsFor(siblingConfig)

  await runSiblingCreate(github, siblingAws, siblingAws, deps.git, siblingConfig, siblingSession, {
    coreConfig: config,
    skeletonRoot: deps.skeletonRoot,
    githubToken: deps.githubToken,
    skipCoreIdentity: true,
    skipRegistration: true,
  })
}

// ─── The root application sibling (issue #306) ───────────────────────────────

/**
 * `biffo init` always creates TWO GitHub repos: the platform, and the user's
 * application. Not a flag — if you are scaffolding an application you want an
 * application, and making it opt-in would mean the default first run produces
 * a platform with nothing at its front door.
 *
 * The application is an ADR-0007 sibling with an empty path prefix: it serves
 * `/` and takes the core distribution's `default_cache_behavior`. The portal
 * keeps `/admin` and `/login` (phase 1).
 */
export function appSiblingConfig(config: BiffoConfig): SiblingConfig {
  const { org } = (
    config.source_control as { provider: 'github'; config: { org: string; repo: string } }
  ).config
  const cloud = config.cloud as {
    provider: 'aws'
    config: { account_id: string; region: string; profile?: string }
  }
  const name = rootSiblingProjectName(config.project.name)

  return SiblingConfigSchema.parse({
    project: {
      name,
      description: `${config.project.description || config.project.name} — the user-facing application, served at /`,
    },
    // Repo name === project name, deliberately and not incidentally:
    // `resolveSiblingRepos()` (lib/sibling-teardown.ts) resolves a sibling's
    // repo as `<coreOrg>/<projectName>`, recovering the project name from the
    // S3 bucket in the registry. Let the two diverge and `biffo teardown`
    // cannot find the repo it is meant to delete.
    source_control: { provider: 'github', config: { org, repo: name } },
    // Identity only — account, region, profile. Deliberately NOT spread from
    // the core's cloud config, which by this point in `runInit` also carries
    // the CORE's `oidc_role_arn` and `tf_state_bucket`. The sibling gets its
    // own of both (steps 4 and 5 of runSiblingCreate); inheriting the core's
    // would either be silently wrong or, as an empty string mid-run, fail
    // schema validation here and take the whole init down with it.
    cloud: {
      provider: 'aws',
      config: {
        account_id: cloud.config.account_id,
        region: cloud.config.region,
        ...(cloud.config.profile ? { profile: cloud.config.profile } : {}),
      },
    },
    environments: config.environments,
    core: {
      project_name: config.project.name,
      // The empty prefix IS the root mode. It registers under the reserved,
      // non-empty name "app" — see lib/root-sibling.ts on why those two must
      // not be conflated.
      path_prefix: '',
    },
  })
}

/**
 * The registry files that register the app sibling on the core project's CDN,
 * one per environment, ready to commit into the core repo.
 *
 * Every value here is DERIVED, not observed: the sibling's S3 site bucket name
 * is `<project>-<env>-site-<account>` by construction, so registration needs
 * nothing to exist yet. That is what makes it safe to register the sibling
 * *before* creating it (see runInit) rather than after.
 */
export function appSiblingRegistryFiles(config: BiffoConfig): { path: string; content: string }[] {
  const sibling = appSiblingConfig(config)
  const { account_id: accountId, region } = (
    config.cloud as { provider: 'aws'; config: { account_id: string; region: string } }
  ).config

  return config.environments.map((env) => ({
    path: `infra/environments/${env}/siblings.auto.tfvars.json`,
    content: serializeRegistry([
      {
        name: ROOT_SIBLING_NAME,
        bucket_regional_domain: bucketRegionalDomain(
          siteBucketName(sibling.project.name, env, accountId),
          region,
        ),
        description: sibling.project.description,
      },
    ]),
  }))
}

/** What `runInit` needs in order to create the app sibling's own repo. */
export interface AppSiblingDeps {
  git: SiblingCreateGit
  /** Builds an AwsAdapter for the sibling's own (identical) AWS account. */
  awsFor: (config: SiblingConfig) => AwsAdapter
  skeletonRoot: string
  githubToken: string
}

export const INSTANCE_CONFIG_FILE = 'biffo.config.json'

/**
 * The branch the instance commit is created on. `dev` is the repo's default
 * branch (generated from the template, #559) and `staging`/`main` are cut from
 * it, so building the commit here and fast-forwarding the others onto it gives
 * every branch one shared commit rather than look-alikes with unrelated SHAs.
 */
export const INSTANCE_FILE_BASE_BRANCH = 'dev'

/**
 * The remaining branches, fast-forwarded onto the base branch's instance commit
 * so they share its history. `dev` is the base/default/integration branch and
 * `staging`/`main` are the promotion targets (`main` = production, reserved
 * until a prod environment is built, #559); each is protected and can only be
 * updated by PR afterwards.
 */
export const INSTANCE_FILE_FOLLOWER_BRANCHES = ['staging', 'main'] as const

/** Every branch that ends up carrying the instance files. */
export const INSTANCE_FILE_BRANCHES = [
  INSTANCE_FILE_BASE_BRANCH,
  ...INSTANCE_FILE_FOLLOWER_BRANCHES,
]

/**
 * Commit the instance-identity changes onto every branch of the scaffolded repo:
 *
 *   + `biffo.core.json` — the instance marker, recording the core version this
 *     CLI shipped with. Its presence is how the Release Guards job (#242) and
 *     `.github/workflows/core-tag.yml` (#199) tell an instance from the
 *     template; without it every fresh repo is misread as the template and both
 *     of those guards misfire.
 *   - `biffo.config.json` — the template's own placeholder file, deleted. It is
 *     a template artifact with no meaning in an instance: the resolved config
 *     lives in `~/.biffo/projects/<name>.json` (written by `saveProjectConfig`),
 *     and its literal `{{PLACEHOLDER}}` values otherwise make `biffo deploy`
 *     hard-fail on schema validation.
 *
 * The resolved config is deliberately NOT committed here. It carries the AWS
 * account id and admin email, and the template's own `.gitleaks.toml` forbids
 * both in the tree — `biffo-aws-account-id`
 * (`\b(?:[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-)?(\d{12})\b`, `secretGroup = 1`,
 * as of #1628's third attempt) consumes a UUID's two-hex-quad prefix in the
 * rule's own regex and reports only the 12 digits, with a `regexTarget =
 * "match"` allowlist exempting that exact two-quad-preceded shape per match
 * (not per line, which is what #1628 attempt 2 tried and broke — see
 * AGENTS.md §7) so a fixture UUID's last segment is exempt while a real
 * account id — quoted, colon-bounded (ARN), or hyphenated in a resource
 * name, even sharing a line with an unrelated UUID — still fires. And
 * `biffo-placeholder-config` fire on any real value. Committing it would turn
 * the instance's own Secret Scan red on its first run, which is a worse
 * defect than the one being fixed.
 *
 * All branches get ONE shared commit, not look-alikes (issue #329). The commit
 * is built once on `INSTANCE_FILE_BASE_BRANCH` (`dev`) and `staging`/`main` are
 * fast-forwarded onto it. Committing the identical content to each branch
 * independently produced distinct SHAs; git treats those as unrelated, so the
 * instance's first `dev`→`staging`→`main` promotion conflicted on files the user
 * never touched. A single shared commit makes those promotions a clean merge.
 *
 * Idempotent — `commitFiles` no-ops when the base head already matches (a
 * resumed init reuses that head as the shared commit), and `fastForwardBranch`
 * no-ops when a follower is already there, so a resumed `init` neither fails nor
 * duplicates commits.
 */
export async function writeInstanceFiles(
  github: GitHubAdapter,
  org: string,
  repo: string,
  /**
   * When given, the app sibling's CDN registration
   * (`infra/environments/<env>/siblings.auto.tfvars.json`) rides along in the
   * same commit — see the ordering note in the doc comment above.
   */
  config?: BiffoConfig,
): Promise<void> {
  const files: { path: string; content: string | null }[] = [
    { path: INSTANCE_CORE_FILE, content: serializeInstanceCoreVersion(getLatestCoreVersion()) },
    { path: INSTANCE_CONFIG_FILE, content: null },
    ...(config ? appSiblingRegistryFiles(config) : []),
  ]
  const message = config
    ? `chore: record core version, register the ${ROOT_SIBLING_NAME} sibling, and drop the template ${INSTANCE_CONFIG_FILE}`
    : `chore: record core version and drop the template ${INSTANCE_CONFIG_FILE}`

  // Build the commit once on the base branch, then fast-forward the rest onto
  // it so all three branches share it (issue #329). `commitFiles` returns null
  // when the base already carries the content (a resumed init): in that case its
  // current head IS the shared commit the followers must converge on.
  const committed = await github.commitFiles(org, repo, INSTANCE_FILE_BASE_BRANCH, files, message)
  const sharedSha = committed ?? (await github.getBranchSha(org, repo, INSTANCE_FILE_BASE_BRANCH))
  for (const branch of INSTANCE_FILE_FOLLOWER_BRANCHES) {
    await github.fastForwardBranch(org, repo, branch, sharedSha)
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * What this run will create, printed before it creates any of it.
 *
 * The important line is the second repository. Everything else here the user
 * typed themselves; the application sibling is the one thing `init` decides on
 * their behalf, and they should see it named before it exists rather than
 * discover it in their org afterwards.
 */
export function printPlan(config: BiffoConfig): void {
  const { org, repo } = (
    config.source_control as { provider: 'github'; config: { org: string; repo: string } }
  ).config
  const appRepo = rootSiblingProjectName(config.project.name)

  console.log(chalk.bold('\n  This will create TWO GitHub repositories:\n'))
  console.log(`    1. ${chalk.bold(`${org}/${repo}`)}`)
  console.log('       The platform — Core API, admin portal (/admin, /login), infrastructure.')
  console.log(`    2. ${chalk.bold(`${org}/${appRepo}`)}`)
  console.log('       Your application — served at / (ADR-0007 sibling, issue #306).')
  console.log(
    '\n  Plus, in your AWS account: an OIDC role and a Terraform state bucket for each,\n' +
      `  across ${config.environments.join(', ')}. \`biffo teardown\` removes both repositories\n` +
      '  and everything they provision.\n',
  )
}

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
  assertInteractive(
    'Project configuration',
    'Pass --config <path> with a pre-filled biffo.config.json (it implies -y).',
  )

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
