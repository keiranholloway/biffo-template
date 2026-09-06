/**
 * `biffo check api-gateway-integration` (biffo-template#1900's wiring,
 * #1906's satellite fix).
 *
 * `runApiGatewayIntegrationCheck` takes no options — it always resolves its
 * root via `git rev-parse --show-toplevel` — so these tests mock the
 * underlying `execa` package (not `../lib/exec.js`, which just wraps it) to
 * point that resolution at a disposable tmp tree, the same technique
 * `check-branch-protection.test.ts` uses for its own git call. The
 * underlying `auditApiGatewayIntegrations` audit logic (the full M1/N1-N4
 * case matrix) is already exercised directly in
 * `../lib/api-gateway-integration-guard.test.ts`; this file proves the CI
 * entrypoint's own error handling, not the audit itself.
 *
 * The satellite-shaped case (#1906) is the one this file exists to add: a
 * repo with no `.tf` files at all used to be indistinguishable from a real
 * instance whose Terraform scan had broken, and
 * `runApiGatewayIntegrationCheck` hard-failed on every satellite in the
 * shared-sync rehearsal. A genuine mis-qualified integration on a real .tf
 * tree must still fail exactly as before; that is exercised here too (M1
 * from the case matrix), so the fix cannot be read as silencing the real
 * signal along with the false one.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execa } from 'execa'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'
import { runApiGatewayIntegrationCheck } from './check-api-gateway-integration.js'

vi.mock('execa', () => ({
  execa: vi.fn(),
}))

function write(root: string, rel: string, content: string): void {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

function setRoot(root: string): void {
  vi.mocked(execa).mockResolvedValue({ stdout: root } as never)
}

// M1 from api-gateway-integration-guard.test.ts's own case matrix: an
// env-owned integration referencing a protected Lambda's raw,
// alias-unqualified function_arn.
const M1_MODULE = `
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

resource "aws_apigatewayv2_integration" "lambda" {
  api_id           = aws_apigatewayv2_api.main.id
  integration_type = "AWS_PROXY"
  integration_uri  = module.core_api.function_arn
}
`

let exitCode: number | undefined

beforeEach(() => {
  vi.clearAllMocks()
  exitCode = undefined
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code
    throw new Error(`process.exit(${String(code)})`)
  }) as never)
})

describe('runApiGatewayIntegrationCheck', () => {
  it('is not applicable (exit 0, no crash) in a satellite tree with no .tf files at all (#1906)', async () => {
    const root = makeTmpDir('api-gateway-satellite')
    write(root, 'apps/frontend/package.json', '{"name": "satellite-app"}')
    setRoot(root)

    await expect(runApiGatewayIntegrationCheck()).resolves.toBeUndefined()

    expect(process.exit).not.toHaveBeenCalled()
    const logged = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(logged).toContain('no .tf files found under')
    expect(logged.toLowerCase()).toContain('not applicable')
  })

  it('STILL fails (exit 1) on a real mis-qualified integration (case M1)', async () => {
    const root = makeTmpDir('api-gateway-real-violation')
    write(root, 'infra/environments/dev/main.tf', M1_MODULE)
    setRoot(root)

    await expect(runApiGatewayIntegrationCheck()).rejects.toThrow('process.exit(1)')

    expect(exitCode).toBe(1)
    const reported = vi.mocked(console.error).mock.calls.flat().join('\n')
    expect(reported).toContain('MIS-QUALIFIED')
  })
})
