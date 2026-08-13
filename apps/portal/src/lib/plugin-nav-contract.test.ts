import { describe, expect, it } from 'vitest'
import {
  derivePluginAdminHref,
  type PluginNavSource,
  resolvePluginNavLinks,
} from './plugin-nav-contract'

function plugin(overrides: Partial<PluginNavSource> = {}): PluginNavSource {
  return {
    name: 'marketing',
    has_admin_ingress: true,
    admin_required_group: 'admin',
    admin_nav_label: 'Marketing',
    ...overrides,
  }
}

describe('derivePluginAdminHref', () => {
  it('derives the shared-plugin-host admin URL from the plugin name, not a path', () => {
    expect(derivePluginAdminHref('marketing')).toBe('/api/v1/plugins/marketing/admin')
  })

  it('has no trailing slash — the surface is API-served, not statically exported', () => {
    expect(derivePluginAdminHref('marketing').endsWith('/')).toBe(false)
  })
})

describe('resolvePluginNavLinks', () => {
  it('is empty when no plugins are installed', () => {
    expect(resolvePluginNavLinks([], ['admin'])).toEqual([])
    expect(resolvePluginNavLinks(undefined, ['admin'])).toEqual([])
  })

  it('renders a plugin with a declared admin surface the caller can reach', () => {
    const links = resolvePluginNavLinks([plugin()], ['admin'])
    expect(links).toEqual([{ href: '/api/v1/plugins/marketing/admin', label: 'Marketing' }])
  })

  it('derives the href from the name, ignoring any manifest path the caller might send', () => {
    // The API response never actually carries `path` (see plugin-api.ts's
    // InstalledPlugin type), but nothing here should trust one even if it did.
    const links = resolvePluginNavLinks([{ ...plugin(), path: '/admin/marketing' }], ['admin'])
    expect(links[0]?.href).toBe('/api/v1/plugins/marketing/admin')
  })

  it('falls back to the plugin name when no nav label is declared', () => {
    const links = resolvePluginNavLinks([plugin({ admin_nav_label: null })], ['admin'])
    expect(links).toEqual([{ href: '/api/v1/plugins/marketing/admin', label: 'marketing' }])
  })

  it('drops a plugin with no admin surface', () => {
    const links = resolvePluginNavLinks(
      [plugin({ has_admin_ingress: false, admin_required_group: null })],
      ['admin'],
    )
    expect(links).toEqual([])
  })

  it('drops a plugin whose required group the caller lacks', () => {
    const links = resolvePluginNavLinks(
      [plugin({ admin_required_group: 'marketing-team' })],
      ['admin'],
    )
    expect(links).toEqual([])
  })

  it('drops everything when the caller has no groups at all (empty claim, fail-closed)', () => {
    expect(resolvePluginNavLinks([plugin()], [])).toEqual([])
    expect(resolvePluginNavLinks([plugin()], undefined)).toEqual([])
  })

  it('fails soft on a malformed entry rather than throwing', () => {
    const entries = [undefined, null, 'not-an-object', plugin({ name: 'rbac' })] as unknown[]
    expect(() => resolvePluginNavLinks(entries, ['admin'])).not.toThrow()
    expect(resolvePluginNavLinks(entries, ['admin'])).toEqual([
      { href: '/api/v1/plugins/rbac/admin', label: 'Marketing' },
    ])
  })

  it('drops an entry with a missing or blank name', () => {
    const entries = [plugin({ name: '' }), plugin({ name: '   ' })]
    expect(resolvePluginNavLinks(entries, ['admin'])).toEqual([])
  })

  it('fails closed on has_admin_ingress true but no admin_required_group (malformed upstream)', () => {
    const links = resolvePluginNavLinks([plugin({ admin_required_group: null })], ['admin'])
    expect(links).toEqual([])
  })

  it('de-duplicates by resolved href, first declaration winning', () => {
    const links = resolvePluginNavLinks(
      [plugin({ admin_nav_label: 'First' }), plugin({ admin_nav_label: 'Second' })],
      ['admin'],
    )
    expect(links).toEqual([{ href: '/api/v1/plugins/marketing/admin', label: 'First' }])
  })

  it('preserves declaration order and includes only what the caller can reach', () => {
    const links = resolvePluginNavLinks(
      [
        plugin({
          name: 'billing',
          admin_nav_label: 'Billing',
          admin_required_group: 'billing-team',
        }),
        plugin({ name: 'marketing', admin_nav_label: 'Marketing' }),
        plugin({ name: 'rbac', admin_nav_label: 'RBAC' }),
      ],
      ['admin'],
    )
    expect(links.map((l) => l.label)).toEqual(['Marketing', 'RBAC'])
  })
})
