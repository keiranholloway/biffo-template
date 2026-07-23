import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import { AwsAdapter } from '../adapters/cloud/aws/index.js'
import { GitHubAdapter } from '../adapters/source-control/github/index.js'
import { BiffoConfigSchema, type BiffoConfig } from '../config/schema.js'
import { resolveGithubToken } from '../lib/credentials.js'
import { isTemplatePlaceholderConfig } from '../lib/local-config.js'
import { log } from '../lib/logger.js'
import { listProjectConfigs, loadProjectConfig } from '../lib/session.js'
import {
  discoverSiblings,
  SiblingResolutionError,
  type SiblingDiscoveryGithub,
} from '../lib/sibling-teardown.js'
import {
  checkSiblingIdentity,
  type IdentityCheckEnvInput,
  type IdentityFinding,
} from '../lib/sibling-identity-check.js'

const VALID_ENVIRONMENTS = ['dev', 'staging', 'prod']

/**
 * The GitHub environment variable a sibling's backend bakes the core pool id
 * into at deploy time (used as `TF_VAR_core_cognito_user_pool_id` for its JWKS
 * URL — #496). This is the value we compare against the core's live pool.
 */
const SIBLING_CORE_POOL_VAR = 'CORE_COGNITO_USER_POOL_ID'

export const siblingCheckIdentityCommand = new Command('check-identity')
  .description(
    "Detect when a core's Cognito pool has drifted from its published identity document or " +
      "any sibling's baked-in CORE_COGNITO_USER_POOL_ID (#400). Run from the core repo; exits " +
      'non-zero on drift so a scheduled/CI run goes red.',
  )
  .option('--env <environment>', 'Only check this environment (default: dev, staging, prod)')
  .option('-p, --project <name>', 'Project name (overrides biffo.config.json in current directory)')
  .option('-c, --config <path>', 'Path to biffo.config.json')
  .action(async (options: { env?: string; project?: string; config?: string }) => {
    if (options.env && !VALID_ENVIRONMENTS.includes(options.env)) {
      log.error(
        `Unknown environment: ${options.env}. Must be one of: ${VALID_ENVIRONMENTS.join(', ')}`,
      )
      process.exit(1)
    }

    const environments = options.env ? [options.env] : [...VALID_ENVIRONMENTS]

    const config = await resolveConfig(options)
    const { org, repo } = (
      config.source_control as { provider: 'github'; config: { org: string; repo: string } }
    ).config
    const awsConfig = (
      config.cloud as { provider: 'aws'; config: { account_id: string; region: string } }
    ).config
    // Same inline state-bucket fallback deploy.ts/data-apply.ts/teardown.ts
    // duplicate — there is no shared helper for it in the codebase today, so we
    // match the existing convention rather than introduce one.
    const stateBucket =
      (awsConfig as { tf_state_bucket?: string }).tf_state_bucket ??
      `${config.project.name}-terraform-state-${awsConfig.account_id}`

    const token = await resolveGithubToken(true)
    const deps: CheckIdentityDeps = {
      aws: new AwsAdapter(config),
      github: new GitHubAdapter(token),
      fetchIdentityDoc: fetchPublishedIdentity,
    }

    console.log(chalk.bold(`\n  Biffo — Sibling identity check (${config.project.name})\n`))

    let result: CheckIdentityResult
    try {
      result = await runCheckIdentity(deps, {
        coreOrg: org,
        coreRepo: repo,
        coreProjectName: config.project.name,
        stateBucket,
        environments,
      })
    } catch (err) {
      if (err instanceof SiblingResolutionError) {
        log.error(`Could not enumerate siblings: ${err.message}`)
      } else {
        log.error(`Identity check failed: ${(err as Error).message}`)
      }
      process.exit(1)
    }

    printIdentityReport(result)
    if (!result.ok) process.exit(1)
  })

// ─── Exported for testing ────────────────────────────────────────────────────

/**
 * The dependencies `runCheckIdentity` needs, narrowed so it can be driven with
 * fakes — no AWS, GitHub, or network required in a unit test.
 */
export interface CheckIdentityDeps {
  aws: Pick<AwsAdapter, 'readTerraformOutputs'>
  github: SiblingDiscoveryGithub & Pick<GitHubAdapter, 'getEnvVariable'>
  /** Fetch + parse the core's published identity document; `null` on any error. */
  fetchIdentityDoc: (portalUrl: string) => Promise<{ userPoolId?: string | null } | null>
}

export interface CheckIdentityParams {
  coreOrg: string
  coreRepo: string
  coreProjectName: string
  stateBucket: string
  environments: string[]
}

export interface CheckIdentityResult {
  ok: boolean
  findings: IdentityFinding[]
  /** Environments skipped because the core isn't deployed there (nothing to check). */
  skipped: { environment: string; reason: string }[]
}

/**
 * Gather the live pool id, published document, and each registered sibling's
 * baked-in pool id per environment, then hand them to the pure
 * `checkSiblingIdentity` comparison (#400).
 *
 * Siblings are discovered ONCE (discovery spans all environments and reports
 * which environments each sibling provisions), then filtered per environment.
 * An environment the core hasn't been deployed to is SKIPPED, not failed: it has
 * no live pool, so there is nothing to be stale against.
 */
export async function runCheckIdentity(
  deps: CheckIdentityDeps,
  params: CheckIdentityParams,
): Promise<CheckIdentityResult> {
  const siblings = await discoverSiblings(
    deps.github,
    params.coreOrg,
    params.coreRepo,
    params.coreProjectName,
  )

  const envInputs: IdentityCheckEnvInput[] = []
  const skipped: { environment: string; reason: string }[] = []

  for (const environment of params.environments) {
    let outputs: Record<string, string>
    try {
      outputs = await deps.aws.readTerraformOutputs(
        params.stateBucket,
        `${environment}/terraform.tfstate`,
      )
    } catch {
      // No readable state for this env — the core was never deployed here, so
      // there is no live pool to compare against. Skip, don't fail (an undeployed
      // env is a normal state, not drift).
      skipped.push({
        environment,
        reason: 'no Terraform state (core not deployed to this environment)',
      })
      continue
    }

    const livePoolId = outputs['cognito_user_pool_id']
    const portalUrl = outputs['portal_url']
    if (!livePoolId || !portalUrl) {
      skipped.push({
        environment,
        reason: 'Terraform outputs missing cognito_user_pool_id or portal_url',
      })
      continue
    }

    const publishedDoc = await deps.fetchIdentityDoc(portalUrl)

    // Only siblings that are actually registered against the core AND provision
    // this environment can be stale for it. A sibling whose repo was deleted
    // (`repoState: 'gone'`) has no backend to be wrong — skip it.
    const envSiblings = siblings.filter(
      (s) => s.registered && s.repoState !== 'gone' && s.environments.includes(environment),
    )
    const siblingInputs = await Promise.all(
      envSiblings.map(async (s) => ({
        projectName: s.projectName,
        coreCognitoUserPoolId: await deps.github.getEnvVariable(
          s.org,
          s.repo,
          environment,
          SIBLING_CORE_POOL_VAR,
        ),
      })),
    )

    envInputs.push({ environment, livePoolId, publishedDoc, siblings: siblingInputs })
  }

  const { ok, findings } = checkSiblingIdentity(envInputs)
  return { ok, findings, skipped }
}

/** Human-readable label for each finding kind, used in the report. */
const FINDING_LABEL: Record<IdentityFinding['kind'], string> = {
  'published-doc-unreachable': 'published identity document unreachable',
  'published-doc-stale': 'published identity document is stale',
  'sibling-var-missing': `sibling backend has no ${SIBLING_CORE_POOL_VAR}`,
  'sibling-backend-stale': `sibling backend ${SIBLING_CORE_POOL_VAR} is stale`,
}

export function printIdentityReport(result: CheckIdentityResult): void {
  for (const s of result.skipped) {
    log.warn(`${s.environment}: skipped — ${s.reason}`)
  }

  if (result.ok) {
    log.success(
      chalk.green(
        '✓ identity consistent — every published document and sibling backend matches the live pool',
      ),
    )
    return
  }

  log.error(chalk.red(`✘ ${String(result.findings.length)} identity drift finding(s):`))
  for (const f of result.findings) {
    console.error(
      chalk.red(
        `  [${f.environment}] ${f.subject}: ${FINDING_LABEL[f.kind]}\n` +
          `      expected (live pool): ${f.expected}\n` +
          `      found:                ${f.actual ?? '(unset)'}`,
      ),
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch and parse the core's published identity document (#403). Any failure —
 * network, non-2xx, or unparseable JSON — collapses to `null`, which the pure
 * check reports as `published-doc-unreachable`. `no-store` so a scheduled run
 * always sees the live document, never a cached copy.
 */
async function fetchPublishedIdentity(
  portalUrl: string,
): Promise<{ userPoolId?: string | null } | null> {
  try {
    const base = portalUrl.replace(/\/+$/, '')
    // `cache: 'no-store'` so a scheduled run always sees the live document. Cast
    // because the CLI's TS lib types RequestInit without `cache`, though the
    // Node/undici runtime honours it.
    const res = await fetch(`${base}/.well-known/biffo-identity.json`, {
      cache: 'no-store',
    } as RequestInit)
    if (!res.ok) return null
    const data = (await res.json()) as { userPoolId?: string | null }
    return { userPoolId: data?.userPoolId ?? null }
  } catch {
    return null
  }
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

  log.error('Multiple projects found in ~/.biffo/projects/. Pass --project <name> to choose one:')
  for (const p of projects) log.error(`  ${p.project.name}`)
  process.exit(1)
}
