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

  it('prints ui_components as label (type) pairs, not [object Object] (#1555)', async () => {
    const registry = makeRegistry([
      {
        ...RBAC_ENTRY,
        ui_components: [
          { type: 'nav-link', label: 'RBAC', path: '/admin/rbac' },
          { type: 'page', label: 'Roles', path: '/admin/rbac/roles' },
        ],
      },
    ])

    await runPluginInfo('rbac', { registry: registry as never })

    const output = capturedOutput(logSpy)
    expect(output).toContain('RBAC (nav-link), Roles (page)')
    expect(output).not.toContain('[object Object]')
  })

  it('explains that scope-seam entitlement is instance-declared, with the exact line to ask for (#1653)', async () => {
    const registry = makeRegistry([RBAC_ENTRY])

    await runPluginInfo('rbac', { registry: registry as never })

    const output = capturedOutput(logSpy)
    expect(output).toContain('Scope-seam entitlement')
    // The remedy is named for THIS plugin, so an author can paste it.
    expect(output).toContain('entitlements={"system:rbac": frozenset({"<permission_code>"})}')
    // The trust direction, stated where the author is looking.
    expect(output).toContain('Declared by the INSTANCE, never by this plugin')
    expect(output).toContain('biffo.plugin.json is not consulted')
  })

  it('does not claim to know what an instance has actually entitled (#1653, class #1362)', async () => {
    const registry = makeRegistry([RBAC_ENTRY])

    await runPluginInfo('rbac', { registry: registry as never })

    const output = capturedOutput(logSpy)
    // The whole point of routing diagnosability here rather than into the 403
    // is that this side can afford to be honest. It must say it cannot read
    // the live map rather than print a number derived from a second source.
    expect(output).toContain('cannot report what an instance')
    // And it must never assert a verdict about this instance's map.
    expect(output).not.toMatch(/entitled to:/i)
    expect(output).not.toMatch(/not entitled on this instance/i)
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
