import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PluginCard } from './PluginCard'
import type { RegistryPlugin } from '@/lib/plugin-api'

function basePlugin(overrides: Partial<RegistryPlugin> = {}): RegistryPlugin {
  return {
    name: 'rbac',
    version: '1.2.3',
    minor_version: '1.2',
    repo: 'https://github.com/keiranholloway/biffo-plugin-rbac',
    status: 'active',
    ...overrides,
  }
}

function plugin(overrides: Partial<RegistryPlugin> = {}): RegistryPlugin {
  return basePlugin({
    description: 'Fine-grained role-based access control.',
    author: 'Biffo Team',
    tags: ['auth', 'security'],
    ...overrides,
  })
}

describe('PluginCard', () => {
  it('renders name, version, description, author and tags', () => {
    render(<PluginCard plugin={plugin()} />)

    expect(screen.getByRole('heading', { name: 'rbac' })).toBeInTheDocument()
    expect(screen.getByText('v1.2.3')).toBeInTheDocument()
    expect(screen.getByText('Fine-grained role-based access control.')).toBeInTheDocument()
    expect(screen.getByText('By Biffo Team')).toBeInTheDocument()
    expect(screen.getByText('auth')).toBeInTheDocument()
    expect(screen.getByText('security')).toBeInTheDocument()
  })

  it('links to the plugin detail route by slug', () => {
    render(<PluginCard plugin={plugin({ name: 'analytics' })} />)
    expect(screen.getByRole('link')).toHaveAttribute('href', '/admin/plugins/analytics')
  })

  it('falls back to Biffo Team when author is missing', () => {
    render(<PluginCard plugin={basePlugin()} />)
    expect(screen.getByText('By Biffo Team')).toBeInTheDocument()
  })

  it('omits the tag list when there are no tags', () => {
    render(<PluginCard plugin={basePlugin()} />)
    expect(screen.queryByText('auth')).not.toBeInTheDocument()
  })
})
