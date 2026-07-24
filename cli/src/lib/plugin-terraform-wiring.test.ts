import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  declaredOutputs,
  declaredVariables,
  GENERATED_TF_FILE,
  GENERATED_TFVARS_FILE,
  listEnvironments,
  listPluginModules,
  listUnwirableEnvironments,
  listWireablePlugins,
  pluginModuleSource,
  pluginOutputsFromRoot,
  renderGeneratedTerraform,
  rootPluginOutputName,
  staleFirstPartyCopies,
  syncPluginTerraform,
} from './plugin-terraform-wiring.js'

let cwd: string

/** The full standard variable contract a current `_template`-derived module declares. */
const STANDARD_VARIABLES = [
  'project_name',
  'environment',
  'plugin_name',
  'handler',
  'event_bus_name',
  'core_api_url',
  'core_api_execution_arn',
  'tags',
]

function makePluginModule(name: string, variables: string[] = STANDARD_VARIABLES): void {
  const dir = join(cwd, 'modules', 'plugins', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'main.tf'), '# module body\n')
  writeFileSync(
    join(dir, 'variables.tf'),
    variables.map((v) => `variable "${v}" {\n  type = string\n}\n`).join('\n'),
  )
}

function makeEnvironment(name: string, withEnabledPlugins = true): void {
  const dir = join(cwd, 'infra', 'environments', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'main.tf'),
    '# root config\n' +
      (withEnabledPlugins ? 'variable "enabled_plugins" {\n  type = list(string)\n}\n' : ''),
  )
}

function generatedTf(env: string): string {
  return readFileSync(join(cwd, 'infra', 'environments', env, GENERATED_TF_FILE), 'utf8')
}

function generatedTfvars(env: string): unknown {
  return JSON.parse(
    readFileSync(join(cwd, 'infra', 'environments', env, GENERATED_TFVARS_FILE), 'utf8'),
  )
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'biffo-plugin-tf-'))
})
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe('listPluginModules', () => {
  it('returns nothing when modules/plugins/ does not exist', () => {
    expect(listPluginModules(cwd)).toEqual([])
  })

  it('excludes the _template skeleton and sorts the rest', () => {
    makePluginModule('widgets')
    makePluginModule('_template')
    makePluginModule('acme-crm')

    expect(listPluginModules(cwd)).toEqual(['acme-crm', 'widgets'])
  })
})

describe('listEnvironments', () => {
  it('only counts directories that are actually root configs', () => {
    makeEnvironment('dev')
    makeEnvironment('prod')
    // A stray directory with no main.tf is not a root module.
    mkdirSync(join(cwd, 'infra', 'environments', 'notes'), { recursive: true })

    expect(listEnvironments(cwd)).toEqual(['dev', 'prod'])
  })

  it('skips a root config that declares no enabled_plugins variable', () => {
    makeEnvironment('dev')
    makeEnvironment('legacy', false)

    // infra/ is user-owned, so an instance can have the CLI without the
    // variable. Wiring "legacy" anyway would break its terraform validate.
    expect(listEnvironments(cwd)).toEqual(['dev'])
    expect(listUnwirableEnvironments(cwd)).toEqual(['legacy'])
  })
})

describe('declaredVariables', () => {
  it('collects variable block labels across every .tf file in the module', () => {
    makePluginModule('widgets', ['project_name', 'tags'])
    const dir = join(cwd, 'modules', 'plugins', 'widgets')
    writeFileSync(join(dir, 'extra.tf'), 'variable "memory_size" {\n  type = number\n}\n')

    expect([...declaredVariables(dir)].sort()).toEqual(['memory_size', 'project_name', 'tags'])
  })
})

describe('declaredOutputs', () => {
  it('parses output blocks from every .tf file in the module', () => {
    const dir = mkdtempSync(join(tmpdir(), 'biffo-outputs-'))
    writeFileSync(
      join(dir, 'outputs.tf'),
      'output "function_url_domain" {\n  value = ""\n}\noutput "frontend_bucket_name" {\n  value = ""\n}\n',
    )
    expect([...declaredOutputs(dir)].sort()).toEqual([
      'frontend_bucket_name',
      'function_url_domain',
    ])
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('user-facing plugin output surfacing (ADR-0018)', () => {
  it('emits a root output only for the user-facing outputs the module declares', () => {
    const tf = renderGeneratedTerraform([
      {
        name: 'ideation',
        declaredVariables: new Set(['project_name']),
        declaredOutputs: new Set(['function_url_domain', 'frontend_bucket_regional_domain']),
      },
    ])
    // function_arn is always surfaced
    expect(tf).toContain('output "plugin_ideation_function_arn"')
    // the two declared user-facing outputs are surfaced...
    expect(tf).toContain('output "plugin_ideation_function_url_domain"')
    expect(tf).toContain('try(module.plugin_ideation["ideation"].function_url_domain, null)')
    expect(tf).toContain('output "plugin_ideation_frontend_bucket_regional_domain"')
    // ...but frontend_bucket_name (not declared here) is NOT, so no dangling ref
    expect(tf).not.toContain('plugin_ideation_frontend_bucket_name')
  })

  it('emits no user-facing outputs for a plugin that declares none', () => {
    const tf = renderGeneratedTerraform([
      { name: 'crm', declaredVariables: new Set(['project_name']) },
    ])
    expect(tf).toContain('output "plugin_crm_function_arn"')
    expect(tf).not.toContain('function_url_domain')
  })

  it('pluginOutputsFromRoot inverts the root surfacing, keeping only present keys', () => {
    const root = {
      [rootPluginOutputName('ideation', 'function_url_domain')]: 'abc.lambda-url.on.aws',
      [rootPluginOutputName('ideation', 'frontend_bucket_regional_domain')]: 'b.s3.amazonaws.com',
      [rootPluginOutputName('ideation', 'frontend_bucket_name')]: 'proj-dev-ideation-web',
      plugin_ideation_function_arn: 'arn:aws:lambda:...',
      unrelated: 'x',
    }
    expect(pluginOutputsFromRoot('ideation', root)).toEqual({
      function_url_domain: 'abc.lambda-url.on.aws',
      frontend_bucket_regional_domain: 'b.s3.amazonaws.com',
      frontend_bucket_name: 'proj-dev-ideation-web',
    })
    // a plugin the outputs don't mention yields an empty map (register fails closed)
    expect(pluginOutputsFromRoot('other', root)).toEqual({})
  })
})

describe('syncPluginTerraform', () => {
  it('emits a module block, an output and an enabled_plugins entry per plugin', () => {
    makeEnvironment('dev')
    makePluginModule('widgets')

    const result = syncPluginTerraform(cwd)

    expect(result.plugins).toEqual(['widgets'])
    expect(result.changedPaths).toEqual([
      `infra/environments/dev/${GENERATED_TF_FILE}`,
      `infra/environments/dev/${GENERATED_TFVARS_FILE}`,
    ])

    const tf = generatedTf('dev')
    expect(tf).toContain('module "plugin_widgets" {')
    expect(tf).toContain('source   = "../../../modules/plugins/widgets"')
    expect(tf).toContain(
      'for_each = contains(var.enabled_plugins, "widgets") ? { "widgets" = true } : {}',
    )
    expect(tf).toContain('output "plugin_widgets_function_arn" {')
    expect(generatedTfvars('dev')).toEqual({ enabled_plugins: ['widgets'] })
  })

  it('wires the ADR-0009 caller-side execute-api grant, but never the Core API allowlist', () => {
    makeEnvironment('dev')
    makePluginModule('widgets')

    syncPluginTerraform(cwd)
    const tf = generatedTf('dev')

    // Caller side: plugin -> api_gateway. Cycle-free, so it is automated.
    expect(tf).toContain('core_api_execution_arn = module.api_gateway.execution_arn')
    // Callee side: setting this from a plugin's role_arn output would create
    // core_api -> api_gateway -> plugin -> core_api. It must stay out of here.
    expect(tf).not.toContain('BIFFO_SERVICE_PRINCIPAL_ARN_ALLOWLIST =')
    expect(tf).not.toContain('.role_arn')
  })

  it('sources the user-facing plugin inputs (Cognito + CDN) when the module declares them', () => {
    makeEnvironment('dev')
    // A user-facing plugin (ADR-0018) declares the extra ingress/frontend inputs.
    makePluginModule('ideation', [
      'project_name',
      'environment',
      'plugin_name',
      'handler',
      'event_bus_name',
      'core_api_url',
      'core_api_execution_arn',
      'cognito_user_pool_id',
      'cognito_client_id',
      'cognito_region',
      'cdn_distribution_arn',
      'tags',
    ])

    syncPluginTerraform(cwd)
    const tf = generatedTf('dev')

    // Alignment-agnostic: renderArguments pads keys to the widest one.
    expect(tf).toMatch(/cognito_user_pool_id\s+= module\.auth\.user_pool_id/)
    expect(tf).toMatch(/cognito_client_id\s+= module\.auth\.client_id/)
    expect(tf).toMatch(/cognito_region\s+= var\.aws_region/)
    expect(tf).toMatch(/cdn_distribution_arn\s+= module\.cdn\.distribution_arn/)
  })

  it('does not source the Cognito/CDN inputs for a plugin that does not declare them', () => {
    makeEnvironment('dev')
    makePluginModule('widgets') // event-only plugin: STANDARD_VARIABLES, no user-facing inputs

    syncPluginTerraform(cwd)
    const tf = generatedTf('dev')

    expect(tf).not.toContain('cognito_user_pool_id')
    expect(tf).not.toContain('cdn_distribution_arn')
  })

  it('omits arguments a plugin module does not declare, so older modules still validate', () => {
    makeEnvironment('dev')
    // A module predating PR #260's core_api_execution_arn variable.
    makePluginModule('legacy', [
      'project_name',
      'environment',
      'plugin_name',
      'handler',
      'event_bus_name',
      'core_api_url',
      'tags',
    ])

    syncPluginTerraform(cwd)
    const tf = generatedTf('dev')

    expect(tf).toContain('core_api_url')
    expect(tf).not.toContain('core_api_execution_arn')
  })

  it('writes into every environment root config', () => {
    makeEnvironment('dev')
    makeEnvironment('staging')
    makeEnvironment('prod')
    makePluginModule('widgets')

    const result = syncPluginTerraform(cwd)

    expect(result.environments).toEqual(['dev', 'prod', 'staging'])
    for (const env of ['dev', 'staging', 'prod']) {
      expect(generatedTf(env)).toContain('module "plugin_widgets" {')
      expect(generatedTfvars(env)).toEqual({ enabled_plugins: ['widgets'] })
    }
  })

  it('is idempotent — re-running produces byte-identical output, never a duplicate block', () => {
    makeEnvironment('dev')
    makePluginModule('widgets')

    syncPluginTerraform(cwd)
    const first = generatedTf('dev')
    const firstVars = readFileSync(
      join(cwd, 'infra', 'environments', 'dev', GENERATED_TFVARS_FILE),
      'utf8',
    )

    syncPluginTerraform(cwd)
    syncPluginTerraform(cwd)

    const third = generatedTf('dev')
    expect(third).toBe(first)
    expect(
      readFileSync(join(cwd, 'infra', 'environments', 'dev', GENERATED_TFVARS_FILE), 'utf8'),
    ).toBe(firstVars)
    expect(third.match(/module "plugin_widgets"/g)).toHaveLength(1)
    expect(generatedTfvars('dev')).toEqual({ enabled_plugins: ['widgets'] })
  })

  it('drops a plugin whose module directory has been removed', () => {
    makeEnvironment('dev')
    makePluginModule('widgets')
    makePluginModule('acme-crm')
    syncPluginTerraform(cwd)
    expect(generatedTf('dev')).toContain('module "plugin_acme-crm"')

    rmSync(join(cwd, 'modules', 'plugins', 'acme-crm'), { recursive: true, force: true })
    syncPluginTerraform(cwd)

    const tf = generatedTf('dev')
    expect(tf).not.toContain('module "plugin_acme-crm"')
    expect(tf).toContain('module "plugin_widgets"')
    expect(generatedTfvars('dev')).toEqual({ enabled_plugins: ['widgets'] })
  })

  it('removes the generated files entirely once the last plugin is uninstalled', () => {
    makeEnvironment('dev')
    makePluginModule('widgets')
    syncPluginTerraform(cwd)

    rmSync(join(cwd, 'modules', 'plugins', 'widgets'), { recursive: true, force: true })
    const result = syncPluginTerraform(cwd)

    expect(result.plugins).toEqual([])
    expect(existsSync(join(cwd, 'infra', 'environments', 'dev', GENERATED_TF_FILE))).toBe(false)
    expect(existsSync(join(cwd, 'infra', 'environments', 'dev', GENERATED_TFVARS_FILE))).toBe(false)
    expect(result.changedPaths).toHaveLength(2)
  })

  it('is a no-op on a checkout with no environments and no plugins', () => {
    const result = syncPluginTerraform(cwd)
    expect(result).toEqual({
      plugins: [],
      environments: [],
      skippedEnvironments: [],
      changedPaths: [],
    })
  })

  it('writes nothing into an environment it cannot wire', () => {
    makeEnvironment('dev')
    makeEnvironment('legacy', false)
    makePluginModule('widgets')

    const result = syncPluginTerraform(cwd)

    expect(result.environments).toEqual(['dev'])
    expect(result.skippedEnvironments).toEqual(['legacy'])
    expect(existsSync(join(cwd, 'infra', 'environments', 'legacy', GENERATED_TF_FILE))).toBe(false)
    expect(existsSync(join(cwd, 'infra', 'environments', 'dev', GENERATED_TF_FILE))).toBe(true)
  })

  it('aligns the = signs so the generated file survives terraform fmt -check', () => {
    makeEnvironment('dev')
    makePluginModule('widgets')
    syncPluginTerraform(cwd)

    const tf = generatedTf('dev')
    // Only the module block — the output block below it is formatted as its
    // own alignment group, exactly as `terraform fmt` would.
    const moduleBlock = tf.slice(tf.indexOf('module "plugin_widgets"'), tf.indexOf('\noutput "'))
    const argLines = moduleBlock
      .split('\n')
      .filter((l) => /^ {2}\w+ +=/.test(l) && !l.includes('source') && !l.includes('for_each'))
    const columns = new Set(argLines.map((l) => l.indexOf('=')))
    expect(argLines.length).toBeGreaterThan(0)
    expect(columns.size).toBe(1)
  })
})

describe('first-party plugins are owned by plugins.core.tf, not the generated file (ADR-0014)', () => {
  let cwd: string
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'biffo-fp-'))
    mkdirSync(join(cwd, 'infra', 'environments', 'dev'), { recursive: true })
    writeFileSync(
      join(cwd, 'infra', 'environments', 'dev', 'main.tf'),
      'variable "enabled_plugins" {}\n',
    )
  })
  afterEach(() => rmSync(cwd, { recursive: true, force: true }))

  const firstParty = (name: string) => {
    const dir = join(cwd, 'services', '_plugins', name, 'terraform')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'main.tf'), 'variable "project_name" {}\nvariable "plugin_name" {}\n')
  }
  const copied = (name: string) => {
    const dir = join(cwd, 'modules', 'plugins', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'main.tf'), 'variable "project_name" {}\nvariable "plugin_name" {}\n')
  }

  it('sources a first-party plugin from its real, synced location', () => {
    firstParty('agent-runtime')
    expect(pluginModuleSource(cwd, 'agent-runtime')).toBe(
      '../../../services/_plugins/agent-runtime/terraform',
    )
  })

  it('still sources a third-party plugin from the copy, which IS its delivery', () => {
    copied('acme-crm')
    expect(pluginModuleSource(cwd, 'acme-crm')).toBe('../../../modules/plugins/acme-crm')
  })

  it('does NOT wire a first-party plugin — plugins.core.tf (ADR-0014) provisions it', () => {
    firstParty('orchestrator')
    // Excluded from the generated file: wiring it would duplicate the
    // module "plugin_orchestrator" that plugins.core.tf already declares.
    expect(listWireablePlugins(cwd)).toEqual([])
  })

  it('wires third-party plugins but never a first-party one, even side by side', () => {
    firstParty('orchestrator')
    copied('acme-crm')
    expect(listWireablePlugins(cwd)).toEqual(['acme-crm'])
  })

  /**
   * A first-party plugin left with a *stale* copy under modules/plugins/ must
   * still be excluded (plugins.core.tf owns it), so the generated file never
   * emits a colliding module "plugin_<name>" — and the copy is flagged for
   * deletion by staleFirstPartyCopies.
   */
  it('excludes a first-party plugin even when a stale copy is present, and never emits its block', () => {
    firstParty('agent-runtime')
    copied('agent-runtime')

    expect(listWireablePlugins(cwd)).toEqual([])

    const tf = syncPluginTerraform(cwd)
    expect(tf.plugins).toEqual([])
    // no generated file is written when only first-party (stale-copied) plugins exist
    expect(existsSync(join(cwd, 'infra', 'environments', 'dev', GENERATED_TF_FILE))).toBe(false)
  })

  it('reports a stale copy so it can be deleted deliberately', () => {
    firstParty('agent-runtime')
    copied('agent-runtime')
    copied('acme-crm')

    // Only the first-party one is stale — the third-party copy is load-bearing.
    expect(staleFirstPartyCopies(cwd)).toEqual(['agent-runtime'])
  })

  it('reports nothing once the copy is gone', () => {
    firstParty('agent-runtime')
    expect(staleFirstPartyCopies(cwd)).toEqual([])
  })

  it('reads a THIRD-party plugin variables from its copy under modules/plugins/', () => {
    copied('acme-crm')
    writeFileSync(
      join(cwd, 'modules', 'plugins', 'acme-crm', 'main.tf'),
      'variable "project_name" {}\nvariable "tags" {}\n',
    )

    syncPluginTerraform(cwd)
    const generated = readFileSync(
      join(cwd, 'infra', 'environments', 'dev', GENERATED_TF_FILE),
      'utf8',
    )
    expect(generated).toContain('tags')
  })
})
