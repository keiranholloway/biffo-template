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

  it('links to the plugin detail page via query params, not a dynamic path segment', () => {
    render(<PluginCard plugin={plugin({ name: 'analytics' })} />)
    // See InstalledPluginRow.test.tsx's equivalent assertion for why: only
    // /admin/plugins/placeholder/ is statically generated under output: 'export'.
    expect(screen.getByRole('link', { name: 'analytics' })).toHaveAttribute(
      'href',
      '/admin/plugins/placeholder?source=marketplace&name=analytics',
    )
  })

  it('links to the source repository, opening it off-site in a new tab', () => {
    render(<PluginCard plugin={plugin()} />)

    const repoLink = screen.getByRole('link', { name: /view source/i })
    expect(repoLink).toHaveAttribute('href', 'https://github.com/keiranholloway/biffo-plugin-rbac')
    expect(repoLink).toHaveAttribute('target', '_blank')
    // Without noopener the opened page gets a handle on this window via
    // window.opener and can navigate the portal away from under the user.
    expect(repoLink).toHaveAttribute('rel', expect.stringContaining('noopener'))
  })

  it('keeps the repo link separate from the card link rather than nesting anchors', () => {
    const { container } = render(<PluginCard plugin={plugin()} />)

    // An <a> inside an <a> is invalid HTML and React reports it as a
    // hydration error, so the card must not be a link wrapping the repo link.
    expect(container.querySelector('a a')).toBeNull()
    expect(screen.getAllByRole('link')).toHaveLength(2)
  })

  it('marks a built-in plugin as shipping with core', () => {
    render(<PluginCard plugin={plugin({ tags: ['built-in', 'events'] })} />)
    expect(screen.getByText('Ships with Biffo core')).toBeInTheDocument()
  })

  it('does not claim an ordinary plugin ships with core', () => {
    render(<PluginCard plugin={plugin()} />)
    expect(screen.queryByText('Ships with Biffo core')).not.toBeInTheDocument()
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
