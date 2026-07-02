import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { InstalledPluginRow } from './InstalledPluginRow'
import type { InstalledPlugin } from '@/lib/plugin-api'

const rbacPlugin: InstalledPlugin = {
  name: 'rbac',
  version: '0.1.0',
  description: 'Fine-grained role-based access control.',
  tables: [
    { name: 'rbac_roles', columns: [], indexes: [] },
    { name: 'rbac_permissions', columns: [], indexes: [] },
  ],
  routes: [
    { method: 'GET', path: '/roles', table: 'rbac_roles', operation: 'list', description: '' },
  ],
}

describe('InstalledPluginRow', () => {
  it('shows the plugin name and version', () => {
    render(<InstalledPluginRow plugin={rbacPlugin} />)

    expect(screen.getByText('rbac')).toBeInTheDocument()
    expect(screen.getByText('v0.1.0')).toBeInTheDocument()
  })

  it('shows the description when present', () => {
    render(<InstalledPluginRow plugin={rbacPlugin} />)

    expect(screen.getByText('Fine-grained role-based access control.')).toBeInTheDocument()
  })

  it('omits the description paragraph when empty', () => {
    render(<InstalledPluginRow plugin={{ ...rbacPlugin, description: '' }} />)

    expect(screen.queryByText('Fine-grained role-based access control.')).not.toBeInTheDocument()
  })

  it('shows table and route counts, pluralized correctly', () => {
    render(<InstalledPluginRow plugin={rbacPlugin} />)

    expect(screen.getByText('2 tables · 1 route')).toBeInTheDocument()
  })

  it('links to the plugin detail page', () => {
    render(<InstalledPluginRow plugin={rbacPlugin} />)

    expect(screen.getByRole('link', { name: /view details/i })).toHaveAttribute(
      'href',
      '/admin/plugins/rbac',
    )
  })
})
