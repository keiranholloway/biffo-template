import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BiffoConfigSchema } from '../config/schema.js'
import { runPluginWire } from './plugin-wire.js'

const CONFIG = BiffoConfigSchema.parse({
  project: { name: 'my-app', description: '', domain: 'example.com' },
  source_control: { provider: 'github', config: { org: 'acme', repo: 'my-app' } },
  cloud: { provider: 'aws', config: { account_id: '123456789012', region: 'eu-west-1' } },
  environments: ['dev'],
  admin: { email: 'a@b.com', username: 'a' },
})

const OUTPUTS = {
  plugin_ideation_function_url_domain: 'abc.lambda-url.eu-west-1.on.aws',
  plugin_ideation_frontend_bucket_regional_domain:
    'my-app-dev-ideation-web.s3.eu-west-1.amazonaws.com',
  plugin_ideation_frontend_bucket_name: 'my-app-dev-ideation-web',
  plugin_ideation_function_arn: 'arn:aws:lambda:eu-west-1:123456789012:function:x',
}

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'biffo-plugin-wire-'))
  mkdirSync(join(cwd, 'infra', 'environments', 'dev'), { recursive: true })
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(cwd, { recursive: true, force: true })
})

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(join(cwd, rel), 'utf8'))
}

describe('runPluginWire', () => {
  it('reads the deployed outputs from the derived state bucket and registers the origins', async () => {
    const readOutputs = vi.fn().mockResolvedValue(OUTPUTS)

    const targets = await runPluginWire('ideation', 'dev', CONFIG, { readOutputs }, cwd)

    // derives <project>-terraform-state-<account> / <env>/terraform.tfstate
    expect(readOutputs).toHaveBeenCalledWith(
      'my-app-terraform-state-123456789012',
      'dev/terraform.tfstate',
    )
    expect(targets.frontendBucketName).toBe('my-app-dev-ideation-web')
    expect(readJson('infra/environments/dev/plugin-apis.auto.tfvars.json')).toEqual({
      plugin_api_origins: [
        { name: 'ideation', function_url_domain: 'abc.lambda-url.eu-west-1.on.aws' },
      ],
    })
    expect(readJson('infra/environments/dev/siblings.auto.tfvars.json')).toEqual({
      sibling_origins: [
        {
          name: 'ideation',
          bucket_regional_domain: 'my-app-dev-ideation-web.s3.eu-west-1.amazonaws.com',
        },
      ],
    })
  })

  it('fails closed when the plugin module has not applied (its outputs are absent)', async () => {
    const readOutputs = vi.fn().mockResolvedValue({ some_core_output: 'x' })

    await expect(runPluginWire('ideation', 'dev', CONFIG, { readOutputs }, cwd)).rejects.toThrow(
      /did not expose/,
    )
  })
})
