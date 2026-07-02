import { describe, expect, it, vi } from 'vitest'
import { BiffoConfigSchema } from '../config/schema.js'
import { runDataApply } from './data-apply.js'

vi.mock('../lib/logger.js', () => ({
  log: { step: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const CONFIG = BiffoConfigSchema.parse({
  project: { name: 'my-app', description: '', domain: 'example.com' },
  source_control: { provider: 'github', config: { org: 'acme', repo: 'my-app' } },
  cloud: { provider: 'aws', config: { account_id: '123456789012', region: 'eu-west-1' } },
  environments: ['dev'],
  admin: { email: 'a@b.com', username: 'a' },
})

function makeAwsMock(
  overrides: {
    outputs?: Record<string, string>
    invokeResult?: { ok: boolean; body: Record<string, unknown> }
  } = {},
) {
  return {
    readTerraformOutputs: vi
      .fn()
      .mockResolvedValue(overrides.outputs ?? { core_api_lambda_name: 'my-app-dev-core-api' }),
    invokeLambda: vi
      .fn()
      .mockResolvedValue(
        overrides.invokeResult ?? { ok: true, body: { ok: true, applied: [], skipped: [] } },
      ),
  }
}

describe('runDataApply', () => {
  it('resolves the state bucket from config and reads the dev Terraform outputs', async () => {
    const aws = makeAwsMock()

    await runDataApply('tabsii', 'dev', CONFIG, aws as never)

    expect(aws.readTerraformOutputs).toHaveBeenCalledWith(
      'my-app-terraform-state-123456789012',
      'dev/terraform.tfstate',
    )
  })

  it('prefers an explicit tf_state_bucket over the derived name', async () => {
    const configWithBucket = BiffoConfigSchema.parse({
      ...CONFIG,
      cloud: {
        provider: 'aws',
        config: {
          account_id: '123456789012',
          region: 'eu-west-1',
          tf_state_bucket: 'custom-bucket',
        },
      },
    })
    const aws = makeAwsMock()

    await runDataApply('tabsii', 'dev', configWithBucket, aws as never)

    expect(aws.readTerraformOutputs).toHaveBeenCalledWith('custom-bucket', 'dev/terraform.tfstate')
  })

  it('invokes the resolved Lambda with the biffo:ddl-import event', async () => {
    const aws = makeAwsMock()

    await runDataApply('tabsii', 'dev', CONFIG, aws as never)

    expect(aws.invokeLambda).toHaveBeenCalledWith('my-app-dev-core-api', {
      source: 'biffo:ddl-import',
      directory: 'tabsii',
    })
  })

  it('throws a clear error when core_api_lambda_name is missing from Terraform outputs', async () => {
    const aws = makeAwsMock({ outputs: {} })

    await expect(runDataApply('tabsii', 'dev', CONFIG, aws as never)).rejects.toThrow(
      'core_api_lambda_name not found',
    )
    expect(aws.invokeLambda).not.toHaveBeenCalled()
  })

  it('throws with the Lambda error message when the invoke reports FunctionError', async () => {
    const aws = makeAwsMock({
      invokeResult: { ok: false, body: { errorMessage: 'boom', errorType: 'ValueError' } },
    })

    await expect(runDataApply('tabsii', 'dev', CONFIG, aws as never)).rejects.toThrow(
      "DDL import 'tabsii' failed: boom",
    )
  })

  it('does not throw on success, even when nothing needed applying', async () => {
    const aws = makeAwsMock({
      invokeResult: { ok: true, body: { ok: true, applied: [], skipped: ['000_first.sql'] } },
    })

    await expect(runDataApply('tabsii', 'dev', CONFIG, aws as never)).resolves.toBeUndefined()
  })
})
