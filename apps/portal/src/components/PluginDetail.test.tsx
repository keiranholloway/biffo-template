import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginDetail } from './PluginDetail'
import type * as PluginRegistryModule from '@/lib/plugin-registry'
import type { RegistryPluginEntry } from '@/lib/plugin-registry'

const { fetchPluginBySlugMock } = vi.hoisted(() => ({
  fetchPluginBySlugMock: vi.fn(),
}))

vi.mock('@/lib/plugin-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof PluginRegistryModule>()
  return {
    ...actual,
    fetchPluginBySlug: fetchPluginBySlugMock,
  }
})

const INVOICING_PLUGIN: RegistryPluginEntry = {
  name: 'invoicing',
  version: '1.2.3',
  minor_version: '1.2',
  repo: 'https://github.com/keiranholloway/biffo-plugin-invoicing',
  description: 'Invoicing and billing for your product',
  author: 'Biffo Team',
  tags: ['finance', 'billing'],
  required_core_version: '>=1.0.0',
  status: 'active',
}

describe('PluginDetail', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows a loading state before the registry responds', () => {
    fetchPluginBySlugMock.mockReturnValue(new Promise(() => {}))
    render(<PluginDetail slug="invoicing" />)
    expect(document.querySelector('.animate-pulse')).not.toBeNull()
  })

  it('renders the plugin details and the exact copy-paste install command', async () => {
    fetchPluginBySlugMock.mockResolvedValue(INVOICING_PLUGIN)
    render(<PluginDetail slug="invoicing" />)

    expect(await screen.findByRole('heading', { name: 'invoicing' })).toBeInTheDocument()
    expect(screen.getByText(/Invoicing and billing for your product/)).toBeInTheDocument()
    expect(screen.getByText('finance')).toBeInTheDocument()
    expect(screen.getByText('billing')).toBeInTheDocument()
    expect(screen.getByText('>=1.0.0')).toBeInTheDocument()
    expect(screen.getByText('biffo plugin install invoicing@1.2')).toBeInTheDocument()

    // No working install/uninstall/upgrade buttons — only the copy-to-clipboard action.
    expect(screen.queryByRole('button', { name: /install/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /uninstall/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /upgrade/i })).not.toBeInTheDocument()
  })

  it('shows a graceful not-found message when the plugin is absent from the registry', async () => {
    fetchPluginBySlugMock.mockResolvedValue(null)
    render(<PluginDetail slug="does-not-exist" />)

    expect(await screen.findByText(/not found/i)).toBeInTheDocument()
    expect(screen.getByText(/Back to marketplace/i)).toBeInTheDocument()
  })

  it('shows an error message when the registry cannot be reached', async () => {
    fetchPluginBySlugMock.mockRejectedValue(new Error('Could not reach the plugin registry: boom'))
    render(<PluginDetail slug="invoicing" />)

    await waitFor(() => {
      expect(screen.getByText(/Could not reach the plugin registry: boom/)).toBeInTheDocument()
    })
  })

  it('re-fetches when the slug prop changes', async () => {
    fetchPluginBySlugMock.mockResolvedValue(INVOICING_PLUGIN)
    const { rerender } = render(<PluginDetail slug="invoicing" />)
    await screen.findByRole('heading', { name: 'invoicing' })

    fetchPluginBySlugMock.mockResolvedValue(null)
    rerender(<PluginDetail slug="other-plugin" />)

    await screen.findByText(/not found/i)
    expect(fetchPluginBySlugMock).toHaveBeenCalledWith('invoicing')
    expect(fetchPluginBySlugMock).toHaveBeenCalledWith('other-plugin')
  })
})
