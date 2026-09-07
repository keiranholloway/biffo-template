import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertApiGatewayIntegrations,
  auditApiGatewayIntegrations,
  countRawResourceDeclarations,
  findModuleBlocks,
  findResourceBlocks,
} from './api-gateway-integration-guard.js'
import { makeTmpDir } from '../test-utils/tmp.js'

function writeTf(dir: string, name: string, content: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), content, 'utf8')
}

/**
 * The wiring that makes `core_api` a PROTECTED Lambda — captured live from
 * `infra/environments/dev/main.tf` on `origin/dev` today
 * (`grep -n "lambda_function_arn" infra/environments/dev/main.tf` -> line
 * 328: `lambda_function_arn   = module.core_api.function_arn`). Every case
 * below shares this establishing block; only the integration differs.
 */
const ESTABLISHING_MODULE = `
module "api_gateway" {
  source = "../../../modules/cloud/aws/api-gateway"

  project_name          = var.project_name
  environment           = local.environment
  lambda_function_arn   = module.core_api.function_arn
  lambda_function_name  = module.core_api.function_name
  cognito_user_pool_id  = module.auth.user_pool_id
  cognito_client_id     = module.auth.client_id
  aws_region            = var.aws_region
  cors_origins          = local.cors_origins_list
  cloudwatch_kms_key_id = aws_kms_key.logs.arn
  tags                  = local.tags
}
`

/**
 * ── Case matrix (AGENTS.md "case matrix before design") ────────────────────
 *
 * Every MUST-NOT-CATCH row is either a real line captured live from this
 * repo's own `origin/dev` tree (command noted), or a direct quote from
 * biffo-template#1900's own issue text describing tabsii-platform#1354's
 * actual fix — the two lines that are NOT independently greppable here are
 * marked as such rather than presented as captured.
 *
 * MUST-CATCH
 *   M1  `integration_uri = module.core_api.function_arn`
 *       The exact shape #1900 reports: an env-owned integration on the same
 *       Lambda `ESTABLISHING_MODULE` marks protected, via the raw
 *       function_arn. Reconstructed from the issue's own description (the
 *       real broken line lived in tabsii-platform, a separate repo this
 *       session has no read access to) — never independently captured live,
 *       stated here rather than silently presented as such.
 *
 * MUST-NOT-CATCH
 *   N1  `integration_uri = module.plugin_host.function_arn`
 *       Real line, captured live:
 *       `grep -n "integration_uri" infra/environments/dev/plugin-host.core.tf`
 *       -> line 80. `plugin_host` is never fed into an api-gateway module's
 *       `lambda_function_arn`, so it is not protected — same unqualified
 *       shape as M1, correctly NOT flagged.
 *   N2  `integration_uri = local.lambda_alias_arn`
 *       Real line, captured live:
 *       `grep -n "integration_uri" modules/cloud/aws/api-gateway/main.tf`
 *       -> line 90. The module's OWN integration; not a `module.x.function_arn`
 *       reference at all, so the pattern never matches it.
 *   N3  `integration_uri = module.core_api.live_alias_arn`
 *       tabsii-platform#1354's actual fix, quoted directly from #1900's own
 *       issue text ("repointed 8 env-owned .tf files at
 *       module.core_api.live_alias_arn"). Correctly qualified — not flagged.
 *   N4  `integration_uri = module.api_gateway.lambda_integration_uri`
 *       The contract this PR adds (`outputs.tf`). Correctly qualified — not
 *       flagged.
 */
describe('auditApiGatewayIntegrations — case matrix', () => {
  it('M1: catches the raw, unqualified function_arn on a protected Lambda', () => {
    const dir = makeTmpDir('api-gw-guard-m1-')
    writeTf(
      dir,
      'main.tf',
      `${ESTABLISHING_MODULE}
resource "aws_apigatewayv2_integration" "lambda" {
  api_id           = aws_apigatewayv2_api.main.id
  integration_type = "AWS_PROXY"
  integration_uri  = module.core_api.function_arn
}
`,
    )

    const report = auditApiGatewayIntegrations(dir)
    expect(report.violations).toHaveLength(1)
    expect(report.violations[0]?.integrationName).toBe('lambda')
    expect(report.violations[0]?.targetModuleName).toBe('core_api')
    expect(report.ok).toBe(false)
    expect(() => assertApiGatewayIntegrations(dir)).toThrow(/MIS-QUALIFIED/)
  })

  it('N1: does not catch an integration on an UNPROTECTED Lambda (plugin_host)', () => {
    const dir = makeTmpDir('api-gw-guard-n1-')
    writeTf(
      dir,
      'main.tf',
      `${ESTABLISHING_MODULE}
resource "aws_apigatewayv2_integration" "plugin_host" {
  api_id                 = module.api_gateway.api_id
  integration_type       = "AWS_PROXY"
  integration_uri        = module.plugin_host.function_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}
`,
    )

    const report = auditApiGatewayIntegrations(dir)
    expect(report.violations).toHaveLength(0)
    expect(report.ok).toBe(true)
  })

  it("N2: does not catch the module's own integration (local.lambda_alias_arn)", () => {
    const dir = makeTmpDir('api-gw-guard-n2-')
    writeTf(
      dir,
      'module.tf',
      `
resource "aws_apigatewayv2_integration" "lambda" {
  api_id                  = aws_apigatewayv2_api.main.id
  integration_type        = "AWS_PROXY"
  integration_uri         = local.lambda_alias_arn
  payload_format_version  = "2.0"
  timeout_milliseconds    = 29000
}
`,
    )

    const report = auditApiGatewayIntegrations(dir)
    expect(report.violations).toHaveLength(0)
    expect(report.ok).toBe(true)
  })

  it('N3: does not catch the actual tabsii-platform fix shape (live_alias_arn)', () => {
    const dir = makeTmpDir('api-gw-guard-n3-')
    writeTf(
      dir,
      'main.tf',
      `${ESTABLISHING_MODULE}
resource "aws_apigatewayv2_integration" "lambda" {
  api_id           = aws_apigatewayv2_api.main.id
  integration_type = "AWS_PROXY"
  integration_uri  = module.core_api.live_alias_arn
}
`,
    )

    const report = auditApiGatewayIntegrations(dir)
    expect(report.violations).toHaveLength(0)
    expect(report.ok).toBe(true)
  })

  it('N4: does not catch the new blessed contract (lambda_integration_uri)', () => {
    const dir = makeTmpDir('api-gw-guard-n4-')
    writeTf(
      dir,
      'main.tf',
      `${ESTABLISHING_MODULE}
resource "aws_apigatewayv2_integration" "lambda" {
  api_id           = aws_apigatewayv2_api.main.id
  integration_type = "AWS_PROXY"
  integration_uri  = module.api_gateway.lambda_integration_uri
}
`,
    )

    const report = auditApiGatewayIntegrations(dir)
    expect(report.violations).toHaveLength(0)
    expect(report.ok).toBe(true)
  })
})

describe('auditApiGatewayIntegrations — skeleton lineage exclusion', () => {
  /**
   * Constructed edge case, not a corpus line: _skeletons/sibling-template's
   * own api-gateway module is a different, non-aliased lineage (confirmed by
   * reading both its compute and api-gateway modules live at origin/dev for
   * #1900 — neither provisions an alias or a qualifier). No integration
   * referencing `module.api.function_arn` actually exists in that skeleton
   * today, so this constructs one to prove the exclusion does what it claims
   * rather than merely happening to see zero real instances.
   */
  it('does not protect a Lambda established under _skeletons/', () => {
    const dir = makeTmpDir('api-gw-guard-skeleton-')
    writeTf(
      join(dir, '_skeletons', 'sibling-template', 'infra'),
      'main.tf',
      `
module "api_gateway" {
  source = "../modules/cloud/aws/api-gateway"

  lambda_function_arn  = module.api.function_arn
  lambda_function_name = module.api.function_name
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id           = aws_apigatewayv2_api.main.id
  integration_type = "AWS_PROXY"
  integration_uri  = module.api.function_arn
}
`,
    )

    const report = auditApiGatewayIntegrations(dir)
    expect(report.protectedLambdas).toHaveLength(0)
    expect(report.violations).toHaveLength(0)
    expect(report.ok).toBe(true)
  })
})

describe('auditApiGatewayIntegrations — real tree', () => {
  it("this repo's own infra/environments + modules pass clean today", () => {
    const repoRoot = join(__dirname, '..', '..', '..')
    const report = auditApiGatewayIntegrations(repoRoot)
    expect(report.moduleBlocksFound).toBeGreaterThan(0)
    expect(report.integrationBlocksFound).toBeGreaterThan(0)
    expect(report.protectedLambdas.some((p) => p.functionModuleName === 'core_api')).toBe(true)
    expect(report.violations).toEqual([])
    expect(report.ok).toBe(true)
  })
})

describe('auditApiGatewayIntegrations — blindness backstops', () => {
  it('throws when the root has no .tf files at all', () => {
    const dir = makeTmpDir('api-gw-guard-empty-')
    expect(() => auditApiGatewayIntegrations(dir)).toThrow(/no \.tf files found/)
  })

  it('records an unterminated integration block rather than dropping it', () => {
    const dir = makeTmpDir('api-gw-guard-unterminated-')
    writeTf(
      dir,
      'main.tf',
      `${ESTABLISHING_MODULE}
resource "aws_apigatewayv2_integration" "broken" {
  api_id = aws_apigatewayv2_api.main.id
`, // deliberately never closes
    )

    const report = auditApiGatewayIntegrations(dir)
    expect(report.unterminatedBlocks).toHaveLength(1)
    expect(report.ok).toBe(false)
    expect(() => assertApiGatewayIntegrations(dir)).toThrow(/UNTERMINATED/)
  })
})

describe('findModuleBlocks / findResourceBlocks / countRawResourceDeclarations', () => {
  it('extracts a module block body and its raw-count backstop agrees', () => {
    const text = ESTABLISHING_MODULE
    const blocks = findModuleBlocks(text, 'main.tf')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.name).toBe('api_gateway')
    expect(countRawResourceDeclarations(text, 'module')).toBe(1)
  })

  it('extracts an integration resource block body', () => {
    const text = `
resource "aws_apigatewayv2_integration" "lambda" {
  integration_uri = module.core_api.function_arn
}
`
    const blocks = findResourceBlocks(text, 'main.tf', 'aws_apigatewayv2_integration')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.body).toContain('module.core_api.function_arn')
  })
})
