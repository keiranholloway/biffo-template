import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'
import {
  type AdoptionPair,
  REGISTERED_ADOPTION_PAIRS,
  checkInstanceAdoption,
  isAdopted,
} from './instance-adoption.js'

/**
 * FAIL-FIRST fixtures: the real `infra/environments/dev/main.tf` from
 * `keiranholloway/biffo-platform`, at the two commits either side of PR #174
 * (`infra(core-api): adopt core_api_environment carve-out in main.tf`,
 * squash-merged 2026-08-16T13:34:20Z as `b810c7c`).
 *
 * - `BEFORE` is `a5c81e7:infra/environments/dev/main.tf` — the genuine
 *   defect state this issue reports: `core-api-environment.core.tf` had
 *   already distributed (#1579), but this file's `module "core_api"` still
 *   read a plain literal, so `BIFFO_PLUGIN_MEDIA_BUCKET` was absent from the
 *   deployed Lambda.
 * - `AFTER` is `b810c7c:infra/environments/dev/main.tf` — PR #174's fix,
 *   read back from the merge commit itself, not retyped.
 *
 * Both are the `module "core_api"` block verbatim (trimmed to the
 * surrounding module for context; the rest of `main.tf` is irrelevant to
 * this check). A check that only ever sees synthetic fixtures can pass
 * against a bug it was never actually pointed at — this is the real one.
 */
const BIFFO_PLATFORM_MAIN_TF_BEFORE_PR174 = `module "core_api" {
  source = "../../../modules/cloud/aws/compute"

  project_name  = var.project_name
  environment   = local.environment
  function_name = "core-api"
  handler       = "src.api.main.lambda_handler"
  # Bumped from the compute module's 30s default: a DDL import batch
  # (biffo:ddl-import, ADR-0005) runs one or more .sql files on a single
  # connection and is expected to comfortably finish well under this, but a
  # file expected to run longer than this is explicitly out of scope for v1
  # (split it or apply manually) rather than raised further.
  timeout                   = 300
  enable_vpc_access         = true
  vpc_id                    = module.networking.vpc_id
  private_subnet_ids        = module.networking.private_subnet_ids
  db_credentials_secret_arn = module.database.credentials_secret_arn
  # Least-privilege application role (#253). Granted for IAM completeness; this
  # NAT-less environment reaches Secrets Manager only via the interface VPC
  # endpoint, and the URL is baked in below regardless.
  app_db_credentials_secret_arn = module.database.app_credentials_secret_arn
  event_bus_name                = module.events.event_bus_name
  # Lets the Core API administer Cognito users (add/assign-group/suspend/remove).
  # Runtime reachability is provided by the cognito-idp interface VPC endpoint
  # the networking module creates in this NAT-less environment.
  cognito_user_pool_arn = module.auth.user_pool_arn
  # Lets the Core API invoke the isolated PR-signer over IAM (ADR-0008). The
  # signer, not the Core API, holds the GitHub App credential. Empty (no grant)
  # unless enable_pr_signer is set.
  invoke_function_arns = var.enable_pr_signer ? [module.pr_signer[0].function_arn] : []
  environment_variables = {
    BIFFO_ENVIRONMENT = local.environment
    # Name of the PR-signer Lambda to invoke for endpoint permission changes
    # (ADR-0008). Empty when the signer isn't provisioned; the Core API treats
    # an empty value as "endpoint control plane not configured".
    BIFFO_PR_SIGNER_FUNCTION_NAME = var.enable_pr_signer ? module.pr_signer[0].function_name : ""
    # Full DB URLs baked in — Lambda has no outbound internet so it can't call
    # Secrets Manager. Both are sensitive and stored in Terraform state.
    #
    # BIFFO_DATABASE_URL is the MASTER/owner credential: migrations,
    # biffo:db-init and biffo:ddl-import connect with it because they create
    # and alter objects. BIFFO_APP_DATABASE_URL is the non-owner biffo_app role
    # the HTTP request path connects with instead (#253) — db-init creates that
    # role in Postgres and grants it, since Terraform has no DB connection.
    BIFFO_DATABASE_URL         = module.database.db_url
    BIFFO_APP_DATABASE_URL     = module.database.app_db_url
    BIFFO_APP_ROLE_NAME        = module.database.app_db_user
    BIFFO_COGNITO_JWKS_JSON    = data.http.cognito_jwks.response_body
    BIFFO_COGNITO_USER_POOL_ID = module.auth.user_pool_id
    BIFFO_COGNITO_CLIENT_ID    = module.auth.client_id
    BIFFO_COGNITO_REGION       = var.aws_region
    BIFFO_EVENT_BUS_NAME       = module.events.event_bus_name
    BIFFO_CORS_ORIGINS         = local.cors_origins
    # ADR-0009 — IAM principals allowed on /api/v1/internal/*. Maintained
    # automatically: \`biffo plugin install\` adds the plugin to enabled_plugins
    # (plugins.auto.tfvars.json) and the glob above follows. Fails closed when
    # no plugin is enabled.
    BIFFO_SERVICE_PRINCIPAL_ARN_ALLOWLIST = jsonencode(module.plugin_allowlist.arns)
    # Set so discover_plugin_manifests() finds bundled plugin manifests at
    # runtime — deploy-app.yml's packaging step copies services/*/biffo.plugin.json
    # into the Lambda zip under services/, which AWS extracts to /var/task/.
    BIFFO_PLUGIN_SERVICES_ROOT = "/var/task/services"
    # Set so discover_ddl_import_dirs() finds bundled DDL imports at runtime —
    # deploy-app.yml's packaging step copies db/imports/<name>/*.sql into the
    # Lambda zip under db/imports/, which AWS extracts to /var/task/ (ADR-0005).
    BIFFO_DDL_IMPORT_ROOT = "/var/task/db/imports"
  }
  tags = local.tags
}
`

const BIFFO_PLATFORM_MAIN_TF_AFTER_PR174 = `module "core_api" {
  source = "../../../modules/cloud/aws/compute"

  project_name  = var.project_name
  environment   = local.environment
  function_name = "core-api"
  handler       = "src.api.main.lambda_handler"
  # Bumped from the compute module's 30s default: a DDL import batch
  # (biffo:ddl-import, ADR-0005) runs one or more .sql files on a single
  # connection and is expected to comfortably finish well under this, but a
  # file expected to run longer than this is explicitly out of scope for v1
  # (split it or apply manually) rather than raised further.
  timeout                   = 300
  enable_vpc_access         = true
  vpc_id                    = module.networking.vpc_id
  private_subnet_ids        = module.networking.private_subnet_ids
  db_credentials_secret_arn = module.database.credentials_secret_arn
  # Least-privilege application role (#253). Granted for IAM completeness; this
  # NAT-less environment reaches Secrets Manager only via the interface VPC
  # endpoint, and the URL is baked in below regardless.
  app_db_credentials_secret_arn = module.database.app_credentials_secret_arn
  event_bus_name                = module.events.event_bus_name
  # Lets the Core API administer Cognito users (add/assign-group/suspend/remove).
  # Runtime reachability is provided by the cognito-idp interface VPC endpoint
  # the networking module creates in this NAT-less environment.
  cognito_user_pool_arn = module.auth.user_pool_arn
  # Lets the Core API invoke the isolated PR-signer over IAM (ADR-0008). The
  # signer, not the Core API, holds the GitHub App credential. Empty (no grant)
  # unless enable_pr_signer is set.
  invoke_function_arns = var.enable_pr_signer ? [module.pr_signer[0].function_arn] : []
  environment_variables = merge(local.core_api_environment, {
    BIFFO_ENVIRONMENT = local.environment
    # BIFFO_PR_SIGNER_FUNCTION_NAME and BIFFO_PLUGIN_MEDIA_BUCKET now arrive
    # from local.core_api_environment (core-api-environment.core.tf,
    # biffo-template#1579/#1538/#1540) — left out of this literal
    # deliberately, so this instance actually depends on the channel rather
    # than shadowing it with an identical hand-written copy. Before this
    # adoption, BIFFO_PLUGIN_MEDIA_BUCKET was never set here at all — plugin
    # object storage never worked, because plugin-storage.core.tf's IAM grant
    # had nothing to name.
    # Full DB URLs baked in — Lambda has no outbound internet so it can't call
    # Secrets Manager. Both are sensitive and stored in Terraform state.
    #
    # BIFFO_DATABASE_URL is the MASTER/owner credential: migrations,
    # biffo:db-init and biffo:ddl-import connect with it because they create
    # and alter objects. BIFFO_APP_DATABASE_URL is the non-owner biffo_app role
    # the HTTP request path connects with instead (#253) — db-init creates that
    # role in Postgres and grants it, since Terraform has no DB connection.
    BIFFO_DATABASE_URL         = module.database.db_url
    BIFFO_APP_DATABASE_URL     = module.database.app_db_url
    BIFFO_APP_ROLE_NAME        = module.database.app_db_user
    BIFFO_COGNITO_JWKS_JSON    = data.http.cognito_jwks.response_body
    BIFFO_COGNITO_USER_POOL_ID = module.auth.user_pool_id
    BIFFO_COGNITO_CLIENT_ID    = module.auth.client_id
    BIFFO_COGNITO_REGION       = var.aws_region
    BIFFO_EVENT_BUS_NAME       = module.events.event_bus_name
    BIFFO_CORS_ORIGINS         = local.cors_origins
    # ADR-0009 — IAM principals allowed on /api/v1/internal/*. Maintained
    # automatically: \`biffo plugin install\` adds the plugin to enabled_plugins
    # (plugins.auto.tfvars.json) and the glob above follows. Fails closed when
    # no plugin is enabled.
    BIFFO_SERVICE_PRINCIPAL_ARN_ALLOWLIST = jsonencode(module.plugin_allowlist.arns)
    # Set so discover_plugin_manifests() finds bundled plugin manifests at
    # runtime — deploy-app.yml's packaging step copies services/*/biffo.plugin.json
    # into the Lambda zip under services/, which AWS extracts to /var/task/.
    BIFFO_PLUGIN_SERVICES_ROOT = "/var/task/services"
    # Set so discover_ddl_import_dirs() finds bundled DDL imports at runtime —
    # deploy-app.yml's packaging step copies db/imports/<name>/*.sql into the
    # Lambda zip under db/imports/, which AWS extracts to /var/task/ (ADR-0005).
    BIFFO_DDL_IMPORT_ROOT = "/var/task/db/imports"
  })
  tags = local.tags
}
`

const corePair = REGISTERED_ADOPTION_PAIRS.find((p) => p.id === 'core-api-environment')
if (!corePair) throw new Error('core-api-environment pair missing from the registry')

describe('isAdopted — fail-first against the real biffo-platform defect (#1538)', () => {
  it('FAILS to see adoption in the genuine pre-PR#174 defect state', () => {
    // This is the exact regression: core-api-environment.core.tf had already
    // shipped, and this is what the deployed BIFFO_PLUGIN_MEDIA_BUCKET-less
    // Lambda's source actually looked like.
    expect(isAdopted(corePair, BIFFO_PLATFORM_MAIN_TF_BEFORE_PR174)).toBe(false)
  })

  it('sees adoption in the genuine post-PR#174 fixed state', () => {
    expect(isAdopted(corePair, BIFFO_PLATFORM_MAIN_TF_AFTER_PR174)).toBe(true)
  })

  it('is not fooled by an unrelated assignment of the same env var name onto a different module', () => {
    // The exact false-positive #1538's own investigation recorded: a first
    // draft grepped for the env var name anywhere in *.core.tf and matched
    // plugin-host.core.tf's unrelated assignment onto module.plugin_host.
    // This fixture proves the CURRENT pattern (which anchors on
    // `environment_variables = merge(local.core_api_environment,`, not the
    // env var name) does not repeat that mistake.
    const decoy = `
module "plugin_host" {
  environment_variables = {
    BIFFO_PLUGIN_MEDIA_BUCKET = module.storage.plugin_media_bucket_name
  }
}
`
    expect(isAdopted(corePair, decoy)).toBe(false)
  })

  it('treats a missing file as unadopted, not an error', () => {
    expect(isAdopted(corePair, null)).toBe(false)
  })
})

describe('checkInstanceAdoption — real filesystem trees', () => {
  let root: string
  let theirsDir: string
  let oursDir: string

  beforeEach(() => {
    root = makeTmpDir('instance-adoption')
    theirsDir = join(root, 'theirs')
    oursDir = join(root, 'ours')
    mkdirSync(join(theirsDir, 'infra/environments/dev'), { recursive: true })
    mkdirSync(join(oursDir, 'infra/environments/dev'), { recursive: true })
    // The target ships the channel — true of every template version at or
    // after #1579 (core-v0.287.0).
    writeFileSync(
      join(theirsDir, 'infra/environments/dev/core-api-environment.core.tf'),
      'core_api_environment = merge(...)\n',
    )
  })

  it('FAILS (reports unadopted) against the real pre-PR#174 biffo-platform main.tf', () => {
    writeFileSync(
      join(oursDir, 'infra/environments/dev/main.tf'),
      BIFFO_PLATFORM_MAIN_TF_BEFORE_PR174,
    )

    const report = checkInstanceAdoption(theirsDir, oursDir)

    expect(report.examinedInstances).toBe(1)
    expect(report.applicablePairs).toBe(1)
    const finding = report.findings.find((f) => f.pair.id === 'core-api-environment')
    expect(finding?.status).toBe('unadopted')
  })

  it('PASSES against the real post-PR#174 biffo-platform main.tf', () => {
    writeFileSync(
      join(oursDir, 'infra/environments/dev/main.tf'),
      BIFFO_PLATFORM_MAIN_TF_AFTER_PR174,
    )

    const report = checkInstanceAdoption(theirsDir, oursDir)

    const finding = report.findings.find((f) => f.pair.id === 'core-api-environment')
    expect(finding?.status).toBe('adopted')
  })

  it('reports not-applicable when the target tree does not ship the channel yet', () => {
    rmSync(join(theirsDir, 'infra/environments/dev/core-api-environment.core.tf'))
    writeFileSync(
      join(oursDir, 'infra/environments/dev/main.tf'),
      BIFFO_PLATFORM_MAIN_TF_BEFORE_PR174,
    )

    const report = checkInstanceAdoption(theirsDir, oursDir)

    expect(report.applicablePairs).toBe(0)
    const finding = report.findings.find((f) => f.pair.id === 'core-api-environment')
    expect(finding?.status).toBe('not-applicable')
  })

  it('reports unadopted when the channel is applicable but the instance has no main.tf at all', () => {
    const report = checkInstanceAdoption(theirsDir, oursDir)

    const finding = report.findings.find((f) => f.pair.id === 'core-api-environment')
    expect(finding?.status).toBe('unadopted')
  })

  it('always states the denominator: exactly 1 real instance tree examined', () => {
    writeFileSync(
      join(oursDir, 'infra/environments/dev/main.tf'),
      BIFFO_PLATFORM_MAIN_TF_AFTER_PR174,
    )
    const report = checkInstanceAdoption(theirsDir, oursDir)
    expect(report.examinedInstances).toBe(1)
    expect(report.registeredPairs).toBe(REGISTERED_ADOPTION_PAIRS.length)
  })
})

describe('REGISTERED_ADOPTION_PAIRS — extensible without touching checkInstanceAdoption', () => {
  it('a caller-supplied second pair is checked independently of the first', () => {
    const root = makeTmpDir('instance-adoption-registry')
    const theirsDir = join(root, 'theirs')
    const oursDir = join(root, 'ours')
    mkdirSync(theirsDir, { recursive: true })
    mkdirSync(oursDir, { recursive: true })
    writeFileSync(join(theirsDir, 'some-channel.core.tf'), 'x\n')
    writeFileSync(join(oursDir, 'consumer.tf'), 'does not consume anything\n')

    const extraPair: AdoptionPair = {
      id: 'example-second-pair',
      description: 'a hypothetical second adoption pair, registered rather than hardcoded',
      templateFile: 'some-channel.core.tf',
      userFile: 'consumer.tf',
      adoptedPattern: /local\.some_channel/,
      remedy: 'consume local.some_channel',
    }

    const report = checkInstanceAdoption(theirsDir, oursDir, [extraPair])

    expect(report.registeredPairs).toBe(1)
    expect(report.applicablePairs).toBe(1)
    expect(report.findings).toEqual([{ pair: extraPair, status: 'unadopted' }])
  })
})
