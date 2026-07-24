import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  registerUserFacingPlugin,
  serializePluginApiRegistry,
  unregisterUserFacingPlugin,
  upsertPluginApiOrigin,
  wireUserFacingPluginFromOutputs,
} from './plugin-origin.js'

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'biffo-plugin-origin-'))
  mkdirSync(join(cwd, 'infra', 'environments', 'dev'), { recursive: true })
})
afterEach(() => rmSync(cwd, { recursive: true, force: true }))

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(join(cwd, rel), 'utf8'))
}

describe('upsertPluginApiOrigin', () => {
  it('adds, replaces by name, and preserves others', () => {
    const one = upsertPluginApiOrigin([], { name: 'ideation', function_url_domain: 'a' })
    expect(one).toEqual([{ name: 'ideation', function_url_domain: 'a' }])
    const replaced = upsertPluginApiOrigin(one, { name: 'ideation', function_url_domain: 'b' })
    expect(replaced).toEqual([{ name: 'ideation', function_url_domain: 'b' }])
    const withOther = upsertPluginApiOrigin(replaced, { name: 'other', function_url_domain: 'c' })
    expect(withOther).toHaveLength(2)
  })
})

describe('serializePluginApiRegistry', () => {
  it('wraps in plugin_api_origins with a trailing newline', () => {
    expect(serializePluginApiRegistry([{ name: 'x', function_url_domain: 'd' }])).toBe(
      JSON.stringify({ plugin_api_origins: [{ name: 'x', function_url_domain: 'd' }] }, null, 2) +
        '\n',
    )
  })
})

describe('registerUserFacingPlugin', () => {
  it('writes the api ingress and the frontend into their tfvars', () => {
    const paths = registerUserFacingPlugin(cwd, 'dev', {
      name: 'ideation',
      functionUrlDomain: 'abc.lambda-url.eu-west-1.on.aws',
      bucketRegionalDomain: 'proj-dev-plugin-ideation-web.s3.eu-west-1.amazonaws.com',
    })

    expect(paths).toEqual([
      'infra/environments/dev/plugin-apis.auto.tfvars.json',
      'infra/environments/dev/siblings.auto.tfvars.json',
    ])
    expect(readJson('infra/environments/dev/plugin-apis.auto.tfvars.json')).toEqual({
      plugin_api_origins: [
        { name: 'ideation', function_url_domain: 'abc.lambda-url.eu-west-1.on.aws' },
      ],
    })
    // the frontend is an ordinary sibling S3 origin
    expect(readJson('infra/environments/dev/siblings.auto.tfvars.json')).toEqual({
      sibling_origins: [
        {
          name: 'ideation',
          bucket_regional_domain: 'proj-dev-plugin-ideation-web.s3.eu-west-1.amazonaws.com',
        },
      ],
    })
  })

  it('is idempotent and preserves an existing sibling', () => {
    writeFileSync(
      join(cwd, 'infra', 'environments', 'dev', 'siblings.auto.tfvars.json'),
      JSON.stringify({ sibling_origins: [{ name: 'crm', bucket_regional_domain: 'crm-host' }] }),
    )

    registerUserFacingPlugin(cwd, 'dev', {
      name: 'ideation',
      functionUrlDomain: 'a',
      bucketRegionalDomain: 'ideation-host',
    })
    registerUserFacingPlugin(cwd, 'dev', {
      name: 'ideation',
      functionUrlDomain: 'a2',
      bucketRegionalDomain: 'ideation-host-2',
    })

    const siblings = readJson('infra/environments/dev/siblings.auto.tfvars.json') as {
      sibling_origins: Array<{ name: string; bucket_regional_domain: string }>
    }
    // crm preserved; ideation upserted once (not duplicated)
    expect(siblings.sibling_origins).toHaveLength(2)
    expect(
      siblings.sibling_origins.find((s) => s.name === 'ideation')?.bucket_regional_domain,
    ).toBe('ideation-host-2')
    const apis = readJson('infra/environments/dev/plugin-apis.auto.tfvars.json') as {
      plugin_api_origins: Array<{ name: string; function_url_domain: string }>
    }
    expect(apis.plugin_api_origins).toEqual([{ name: 'ideation', function_url_domain: 'a2' }])
  })
})

describe('wireUserFacingPluginFromOutputs', () => {
  const outputs = {
    function_url_domain: 'abc.lambda-url.eu-west-1.on.aws',
    frontend_bucket_regional_domain: 'proj-dev-plugin-ideation-web.s3.eu-west-1.amazonaws.com',
    frontend_bucket_name: 'proj-dev-plugin-ideation-web',
  }

  it('registers both origins from the outputs and returns the deploy target', () => {
    const targets = wireUserFacingPluginFromOutputs(cwd, 'dev', 'ideation', outputs)

    expect(targets.frontendBucketName).toBe('proj-dev-plugin-ideation-web')
    expect(targets.registeredPaths).toEqual([
      'infra/environments/dev/plugin-apis.auto.tfvars.json',
      'infra/environments/dev/siblings.auto.tfvars.json',
    ])
    expect(readJson('infra/environments/dev/plugin-apis.auto.tfvars.json')).toEqual({
      plugin_api_origins: [
        { name: 'ideation', function_url_domain: 'abc.lambda-url.eu-west-1.on.aws' },
      ],
    })
    expect(readJson('infra/environments/dev/siblings.auto.tfvars.json')).toEqual({
      sibling_origins: [
        {
          name: 'ideation',
          bucket_regional_domain: 'proj-dev-plugin-ideation-web.s3.eu-west-1.amazonaws.com',
        },
      ],
    })
  })

  it('fails closed if the apply did not expose an origin, writing nothing', () => {
    for (const missing of [
      'function_url_domain',
      'frontend_bucket_regional_domain',
      'frontend_bucket_name',
    ]) {
      const partial = { ...outputs, [missing]: '  ' }
      expect(() => wireUserFacingPluginFromOutputs(cwd, 'dev', 'ideation', partial)).toThrow(
        missing,
      )
    }
  })
})

describe('unregisterUserFacingPlugin', () => {
  it('removes the plugin from both files, preserving others', () => {
    registerUserFacingPlugin(cwd, 'dev', {
      name: 'ideation',
      functionUrlDomain: 'a',
      bucketRegionalDomain: 'h',
    })
    writeFileSync(
      join(cwd, 'infra', 'environments', 'dev', 'siblings.auto.tfvars.json'),
      JSON.stringify({
        sibling_origins: [
          { name: 'crm', bucket_regional_domain: 'crm' },
          { name: 'ideation', bucket_regional_domain: 'h' },
        ],
      }),
    )

    unregisterUserFacingPlugin(cwd, 'dev', 'ideation')

    expect(readJson('infra/environments/dev/plugin-apis.auto.tfvars.json')).toEqual({
      plugin_api_origins: [],
    })
    expect(readJson('infra/environments/dev/siblings.auto.tfvars.json')).toEqual({
      sibling_origins: [{ name: 'crm', bucket_regional_domain: 'crm' }],
    })
  })
})
