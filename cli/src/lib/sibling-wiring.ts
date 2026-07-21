/**
 * Wiring a deployed core to its registered sibling apps (issue #337).
 *
 * `biffo init` creates the root application sibling **before** the core has
 * ever been deployed (init step 6), so at that moment none of the core's
 * deployed identity exists yet: no Cognito pool, no API Gateway URL, no
 * CloudFront distribution. `sibling create` handles that by *deferring* — it
 * leaves the sibling's `CORE_*` variables unset — but nothing ever came back to
 * fill them in. The sibling's own deploy therefore built a frontend pointed at
 * nothing and, worse, skipped its S3 bucket policy (which is `count = 0` until
 * `PARENT_CLOUDFRONT_DISTRIBUTION_ARN` is set), so `/` returned 403 AccessDenied.
 *
 * The claiming step lives here and runs from `biffo deploy` (the CORE deploy),
 * which is the first moment every value exists at once. After a successful core
 * deploy for an environment, we resolve six values from that environment's
 * Terraform outputs + the core's own credentials, and push them to every
 * sibling registered against the core:
 *
 *   1. CORE_COGNITO_USER_POOL_ID          (env variable)
 *   2. CORE_COGNITO_CLIENT_ID             (env variable)
 *   3. CORE_API_URL                       (env variable)
 *   4. CORE_PORTAL_URL                    (env variable)
 *   5. SIBLING_GITHUB_TOKEN               (repo secret — a PAT; the default
 *                                          GITHUB_TOKEN cannot manage Actions
 *                                          variables, mirroring how the core
 *                                          repo gets BIFFO_GITHUB_TOKEN)
 *   6. PARENT_CLOUDFRONT_DISTRIBUTION_ARN (env variable — without it the
 *                                          sibling's aws_s3_bucket_policy.site
 *                                          is skipped and CloudFront's
 *                                          OAC-signed reads are denied)
 *
 * We also set PARENT_CLOUDFRONT_DISTRIBUTION_ID (env variable) — the same core
 * output in its raw form — because the sibling's deploy workflow uses it to
 * invalidate the parent CDN cache on every redeploy. Without it the first
 * deploy still works but later redeploys serve stale assets.
 *
 * Everything is set at ENVIRONMENT scope (dev/staging/prod each have their own
 * Cognito pool and their own CloudFront distribution), except the repo-level
 * SIBLING_GITHUB_TOKEN secret. That matches how the sibling skeleton's
 * deploy.yml reads them: its jobs declare `environment:`, so `${{ vars.X }}`
 * resolves the environment-scoped value.
 */

import type { CoreIdentity } from './sibling-session.js'
import { discoverSiblings, type SiblingDiscoveryGithub } from './sibling-teardown.js'

/** The core's CloudFront distribution, in the two forms the sibling consumes. */
export interface CoreCdnWiring {
  /** Raw distribution id — the sibling uses it to invalidate the parent CDN. */
  distributionId: string
  /** `arn:aws:cloudfront::<account>:distribution/<id>` — the sibling's bucket policy `AWS:SourceArn`. */
  distributionArn: string
}

/** Everything one environment's core deploy contributes to a sibling. */
export interface CoreWiring {
  identity: CoreIdentity
  cdn: CoreCdnWiring
}

/**
 * CloudFront distribution ARNs are partitionless and regionless:
 * `arn:aws:cloudfront::<account-id>:distribution/<id>`. The account is the
 * CORE's account (that is where the distribution lives), not the sibling's.
 */
export function cloudfrontDistributionArn(accountId: string, distributionId: string): string {
  return `arn:aws:cloudfront::${accountId}:distribution/${distributionId}`
}

/**
 * The core Terraform outputs a sibling needs. Names match the env-level
 * `output` blocks in `infra/environments/<env>/main.tf`.
 */
const REQUIRED_CORE_OUTPUTS = [
  'cognito_user_pool_id',
  'cognito_client_id',
  'api_gateway_url',
  'portal_url',
  'cloudfront_distribution_id',
] as const

/**
 * Turn one environment's core Terraform outputs into the values every sibling
 * needs — failing LOUDLY if any is empty rather than shipping a frontend wired
 * to nothing / a bucket with no policy (issue #337, the failure that reached a
 * live 403). This is the guard the old deferral path never had.
 */
export function coreWiringFromOutputs(
  outputs: Record<string, string>,
  coreAccountId: string,
  environment: string,
): CoreWiring {
  const missing = REQUIRED_CORE_OUTPUTS.filter((k) => !outputs[k]?.trim())
  if (missing.length > 0) {
    throw new Error(
      `Cannot wire siblings for ${environment}: the core deploy did not expose ` +
        `${missing.join(', ')} in its Terraform outputs. A sibling wired without these would ` +
        `build a frontend pointing at no API/Cognito and skip its S3 bucket policy (so / returns ` +
        `403). Confirm the core actually deployed ${environment} before wiring.`,
    )
  }

  const distributionId = outputs['cloudfront_distribution_id']!
  return {
    identity: {
      cognitoUserPoolId: outputs['cognito_user_pool_id']!,
      cognitoClientId: outputs['cognito_client_id']!,
      apiUrl: outputs['api_gateway_url']!,
      portalUrl: outputs['portal_url']!,
    },
    cdn: {
      distributionId,
      distributionArn: cloudfrontDistributionArn(coreAccountId, distributionId),
    },
  }
}

/** The narrow GitHub surface for setting a sibling env variable. */
export interface SiblingEnvVarSink {
  setEnvVariable(org: string, repo: string, env: string, name: string, value: string): Promise<void>
}

/**
 * Set the CORE_* identity (+ CORS_ORIGINS_JSON) on one sibling environment.
 *
 * Shared by `biffo sibling create` (the manual path, where the core is already
 * up at create time) and the core-deploy wiring below, so both write the exact
 * same variables. CORS is the portal's own origin: the sibling's frontend is
 * served from the same origin as the core portal (ADR-0007 shared-origin SSO),
 * so that is the only origin that will ever call the sibling's API. Without it
 * the sibling's TF_VAR_cors_origins falls back to localhost and every real
 * browser call is blocked.
 */
export async function setSiblingCoreIdentity(
  github: SiblingEnvVarSink,
  org: string,
  repo: string,
  env: string,
  identity: CoreIdentity,
): Promise<void> {
  await github.setEnvVariable(
    org,
    repo,
    env,
    'CORE_COGNITO_USER_POOL_ID',
    identity.cognitoUserPoolId,
  )
  await github.setEnvVariable(org, repo, env, 'CORE_COGNITO_CLIENT_ID', identity.cognitoClientId)
  await github.setEnvVariable(org, repo, env, 'CORE_API_URL', identity.apiUrl)
  await github.setEnvVariable(org, repo, env, 'CORE_PORTAL_URL', identity.portalUrl)
  await github.setEnvVariable(
    org,
    repo,
    env,
    'CORS_ORIGINS_JSON',
    JSON.stringify([identity.portalUrl]),
  )
}

/**
 * Set every core-derived value on one sibling environment: identity + CORS
 * (above) plus the parent CloudFront distribution ARN and id.
 */
export async function wireSiblingEnvironment(
  github: SiblingEnvVarSink,
  org: string,
  repo: string,
  env: string,
  wiring: CoreWiring,
): Promise<void> {
  await setSiblingCoreIdentity(github, org, repo, env, wiring.identity)
  await github.setEnvVariable(
    org,
    repo,
    env,
    'PARENT_CLOUDFRONT_DISTRIBUTION_ARN',
    wiring.cdn.distributionArn,
  )
  await github.setEnvVariable(
    org,
    repo,
    env,
    'PARENT_CLOUDFRONT_DISTRIBUTION_ID',
    wiring.cdn.distributionId,
  )
}

/** The full GitHub surface the core-deploy wiring needs. */
export interface SiblingWiringGithub extends SiblingDiscoveryGithub, SiblingEnvVarSink {
  setRepoSecret(org: string, repo: string, name: string, value: string): Promise<void>
}

export interface WireSiblingsResult {
  /** `org/repo` of siblings whose environment was fully wired. */
  wired: string[]
  /** `org/repo` of registered siblings whose repo no longer exists. */
  gone: string[]
  /** `org/repo` of siblings not registered for the environment just deployed. */
  skippedEnv: string[]
}

/**
 * After a successful CORE deploy to `environment`, push that environment's
 * identity + CDN wiring (and the SIBLING_GITHUB_TOKEN secret) to every sibling
 * registered against the core.
 *
 * Siblings are discovered from the core repo's registry on GitHub — the same
 * source of truth `biffo teardown` uses — so this needs no local session and
 * covers arbitrary siblings, not just the root one. A sibling is wired for
 * `environment` only if the registry lists it there; the token secret is set on
 * every present sibling regardless (any environment's deploy needs it).
 *
 * A `SiblingResolutionError` from discovery propagates: a registry that names a
 * sibling we cannot positively identify is exactly the silent gap #337 is about,
 * so it must surface, not be swallowed.
 */
export async function wireSiblingsAfterCoreDeploy(
  github: SiblingWiringGithub,
  coreOrg: string,
  coreRepo: string,
  coreProjectName: string,
  environment: string,
  wiring: CoreWiring,
  siblingGithubToken: string,
): Promise<WireSiblingsResult> {
  const siblings = await discoverSiblings(github, coreOrg, coreRepo, coreProjectName)
  const result: WireSiblingsResult = { wired: [], gone: [], skippedEnv: [] }

  for (const sibling of siblings) {
    const slug = `${sibling.org}/${sibling.repo}`
    if (sibling.repoState === 'gone') {
      result.gone.push(slug)
      continue
    }

    // The PAT the deploy workflow needs to export its own Terraform outputs as
    // Actions variables — the default GITHUB_TOKEN cannot. Repo-level, and set
    // regardless of which environment we just deployed.
    await github.setRepoSecret(
      sibling.org,
      sibling.repo,
      'SIBLING_GITHUB_TOKEN',
      siblingGithubToken,
    )

    if (!sibling.environments.includes(environment)) {
      result.skippedEnv.push(slug)
      continue
    }

    await wireSiblingEnvironment(github, sibling.org, sibling.repo, environment, wiring)
    result.wired.push(slug)
  }

  return result
}

/** Human-readable summary of a wiring run, for the deploy epilogue. */
export function formatWiringResult(environment: string, result: WireSiblingsResult): string[] {
  const lines: string[] = []
  for (const slug of result.wired) {
    lines.push(`  Wired sibling ${slug} (${environment}): CORE_*, CORS, PARENT_CLOUDFRONT_*, token`)
  }
  for (const slug of result.skippedEnv) {
    lines.push(`  Sibling ${slug}: token set; not registered for ${environment}, env vars skipped`)
  }
  for (const slug of result.gone) {
    lines.push(`  Sibling ${slug}: registered but repo not found — skipped`)
  }
  return lines
}

// Re-export so `biffo deploy`'s glue can catch resolution failures without a
// second import of the teardown lib.
export { SiblingResolutionError } from './sibling-teardown.js'
