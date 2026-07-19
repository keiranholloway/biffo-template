import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegistryPluginEntry } from '../adapters/registry/index.js'
import { capturedOutput } from '../test-utils/console.js'
import { runPluginInfo } from './plugin-info.js'

vi.mock('../lib/logger.js', () => ({
  log: { step: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const RBAC_ENTRY: RegistryPluginEntry = {
  name: 'rbac',
  version: '1.2.3',
  minor_version: '1.2',
  repo: 'https://github.com/keiranholloway/biffo-plugin-rbac',
  description: 'Role-based access control',
  author: 'Biffo Team',
  tags: ['auth', 'security'],
  required_core_version: '>=0.5.0',
  infra_modules: ['rbac'],
  api_routes: ['/roles', '/permissions'],
  status: 'active',
}

function makeRegistry(plugins: RegistryPluginEntry[]) {
  return {
    fetchRegistry: vi.fn().mockResolvedValue({
      schema_version: '1.0',
      last_updated: '2026-06-30T00:00:00Z',
      plugins,
    }),
  }
}

describe('runPluginInfo', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  it('throws when the plugin is not found in the registry', async () => {
    const registry = makeRegistry([])
    await expect(runPluginInfo('rbac', { registry: registry as never })).rejects.toThrow(
      "Plugin 'rbac' was not found",
    )
  })

  it('prints the registry entry fields for a found plugin', async () => {
    const registry = makeRegistry([RBAC_ENTRY])

    await runPluginInfo('rbac', { registry: registry as never })

    const output = capturedOutput(logSpy)
    expect(output).toContain('rbac@1.2.3')
    expect(output).toContain('active')
    expect(output).toContain('1.2')
    expect(output).toContain('https://github.com/keiranholloway/biffo-plugin-rbac')
    expect(output).toContain('Role-based access control')
    expect(output).toContain('Biffo Team')
    expect(output).toContain('auth, security')
    expect(output).toContain('>=0.5.0')
    expect(output).toContain('/roles, /permissions')
  })

  it('shows disabled plugins too, unlike install/upgrade which reject them', async () => {
    const registry = makeRegistry([{ ...RBAC_ENTRY, status: 'disabled' }])

    await runPluginInfo('rbac', { registry: registry as never })

    const output = capturedOutput(logSpy)
    expect(output).toContain('disabled')
  })

  it('prints every matching entry when the registry has more than one for a name', async () => {
    const registry = makeRegistry([
      RBAC_ENTRY,
      { ...RBAC_ENTRY, version: '2.0.0', minor_version: '2.0', status: 'disabled' },
    ])

    await runPluginInfo('rbac', { registry: registry as never })

    const output = capturedOutput(logSpy)
    expect(output).toContain('rbac@1.2.3')
    expect(output).toContain('rbac@2.0.0')
  })
})
