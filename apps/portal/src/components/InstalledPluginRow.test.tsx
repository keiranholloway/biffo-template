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
  has_admin_ingress: false,
  admin_required_group: null,
  admin_nav_label: null,
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

  it('links to the plugin detail page via query params, not a dynamic path segment', () => {
    render(<InstalledPluginRow plugin={rbacPlugin} />)

    // Every plugin must link to the exact same statically-generated path
    // (output: 'export' only pre-renders /admin/plugins/placeholder/) --
    // a per-plugin path segment 404s on a real deploy since next/link
    // falls back to a full browser navigation for path segments that
    // weren't in generateStaticParams(). See page.tsx's comment.
    expect(screen.getByRole('link', { name: /view details/i })).toHaveAttribute(
      'href',
      '/admin/plugins/placeholder?source=installed&name=rbac',
    )
  })
})
