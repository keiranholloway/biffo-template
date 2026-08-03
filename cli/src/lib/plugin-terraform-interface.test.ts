import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { declaredOutputs, renderGeneratedTerraform } from './plugin-terraform-wiring.js'
import { makeTmpDir } from '../test-utils/tmp.js'

let root: string

beforeEach(() => {
  root = makeTmpDir('tf-iface')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function moduleWith(name: string, tf: string): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'main.tf'), tf)
  return dir
}

describe('declaredOutputs', () => {
  it('reads the outputs a module declares', () => {
    const dir = moduleWith(
      'frontend',
      'output "frontend_bucket_regional_domain" {\n  value = ""\n}\noutput "role_arn" {\n  value = ""\n}\n',
    )
    expect([...declaredOutputs(dir)].sort()).toEqual([
      'frontend_bucket_regional_domain',
      'role_arn',
    ])
  })

  it('returns nothing for a module with no outputs', () => {
    expect([...declaredOutputs(moduleWith('bare', 'variable "x" {}\n'))]).toEqual([])
  })

  it('returns nothing rather than throwing for a missing directory', () => {
    expect([...declaredOutputs(join(root, 'nope'))]).toEqual([])
  })
})

describe('renderGeneratedTerraform — generated from the module interface (#685)', () => {
  /**
   * The exact failure. Under ADR-0021 a user-facing plugin has no Lambda, so a
   * hardcoded `function_arn` output is `Unsupported attribute` and the whole
   * environment fails to plan — a correct, current-architecture module could
   * not be instantiated at all.
   */
  it('does not invent a function_arn output on a module that has none', () => {
    const tf = renderGeneratedTerraform([
      {
        name: 'ideation',
        declaredVariables: new Set(['project_name', 'cdn_distribution_arn']),
        declaredOutputs: new Set(['frontend_bucket_regional_domain']),
      },
    ])
    expect(tf).not.toContain('function_arn')
    expect(tf).toContain('output "plugin_ideation_frontend_bucket_regional_domain"')
  })

  /**
   * The other half: the module REQUIRES cdn_distribution_arn with no default,
   * so omitting it is "No value for required variable" — which is what broke
   * `terraform plan` for a whole environment in #685.
   */
  it('passes cdn_distribution_arn to a module that declares it', () => {
    const tf = renderGeneratedTerraform([
      { name: 'ideation', declaredVariables: new Set(['cdn_distribution_arn']) },
    ])
    expect(tf).toContain('cdn_distribution_arn = module.cdn.distribution_arn')
  })

  it('does not pass cdn_distribution_arn to a module that does not declare it', () => {
    const tf = renderGeneratedTerraform([
      { name: 'legacy', declaredVariables: new Set(['project_name']) },
    ])
    expect(tf).not.toContain('cdn_distribution_arn')
  })

  /** A Lambda-backed legacy module must still get its function_arn re-exported. */
  it('still exports function_arn for a module that declares it', () => {
    const tf = renderGeneratedTerraform([
      {
        name: 'legacy',
        declaredVariables: new Set(['project_name']),
        declaredOutputs: new Set(['function_arn']),
      },
    ])
    expect(tf).toContain('output "plugin_legacy_function_arn"')
  })

  it('emits no output block at all when a module declares none', () => {
    const tf = renderGeneratedTerraform([
      { name: 'quiet', declaredVariables: new Set(['project_name']) },
    ])
    expect(tf).not.toContain('output "plugin_quiet')
  })
})
