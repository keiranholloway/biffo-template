import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MarketplacePage from './page'
import type * as pluginApi from '@/lib/plugin-api'
import { fetchActivePlugins, PluginRegistryError, type RegistryPlugin } from '@/lib/plugin-api'

vi.mock('@/lib/plugin-api', async () => {
  const actual = await vi.importActual<typeof pluginApi>('@/lib/plugin-api')
  return {
    ...actual,
    fetchActivePlugins: vi.fn(),
  }
})

const mockFetchActivePlugins = vi.mocked(fetchActivePlugins)

function makePlugins(): RegistryPlugin[] {
  return [
    {
      name: 'rbac',
      version: '1.2.3',
      minor_version: '1.2',
      repo: 'https://github.com/keiranholloway/biffo-plugin-rbac',
      description: 'Fine-grained role-based access control.',
      author: 'Biffo Team',
      tags: ['auth', 'security'],
      status: 'active',
    },
    {
      name: 'invoicing',
      version: '0.4.0',
      minor_version: '0.4',
      repo: 'https://github.com/keiranholloway/biffo-plugin-invoicing',
      description: 'Invoice generation and billing.',
      author: 'Jane Dev',
      tags: ['billing'],
      status: 'active',
    },
  ]
}

describe('MarketplacePage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows a loading state before the registry resolves', () => {
    mockFetchActivePlugins.mockReturnValue(new Promise(() => {}))
    render(<MarketplacePage />)
    expect(screen.getByTestId('marketplace-loading')).toBeInTheDocument()
  })

  it('renders plugin cards once the registry loads', async () => {
    mockFetchActivePlugins.mockResolvedValue(makePlugins())
    render(<MarketplacePage />)

    expect(await screen.findByRole('heading', { name: 'rbac' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'invoicing' })).toBeInTheDocument()
  })

  it('shows an error message when the registry fetch fails', async () => {
    mockFetchActivePlugins.mockRejectedValue(new PluginRegistryError('Plugin registry unreachable'))
    render(<MarketplacePage />)

    expect(await screen.findByText('Plugin registry unreachable')).toBeInTheDocument()
  })

  it('handles an empty registry without treating it as an error', async () => {
    mockFetchActivePlugins.mockResolvedValue([])
    render(<MarketplacePage />)

    expect(await screen.findByText('No plugins available yet')).toBeInTheDocument()
  })

  it('filters plugins by search query', async () => {
    mockFetchActivePlugins.mockResolvedValue(makePlugins())
    const user = userEvent.setup()
    render(<MarketplacePage />)

    await screen.findByRole('heading', { name: 'rbac' })
    await user.type(screen.getByLabelText('Search plugins'), 'invoic')

    expect(screen.queryByRole('heading', { name: 'rbac' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'invoicing' })).toBeInTheDocument()
  })

  it('filters plugins by tag', async () => {
    mockFetchActivePlugins.mockResolvedValue(makePlugins())
    const user = userEvent.setup()
    render(<MarketplacePage />)

    await screen.findByRole('heading', { name: 'rbac' })
    await user.click(screen.getByRole('button', { name: 'billing' }))

    expect(screen.queryByRole('heading', { name: 'rbac' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'invoicing' })).toBeInTheDocument()
  })

  it('shows a no-match message when search excludes every plugin', async () => {
    mockFetchActivePlugins.mockResolvedValue(makePlugins())
    const user = userEvent.setup()
    render(<MarketplacePage />)

    await screen.findByRole('heading', { name: 'rbac' })
    await user.type(screen.getByLabelText('Search plugins'), 'nonexistent-plugin')

    expect(await screen.findByText('No plugins match your search')).toBeInTheDocument()
  })
})
