import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MicroservicesList } from './MicroservicesList'
import { ROOT_SIBLING_NAME } from '@/lib/siblings-api'
import type * as SiblingsApiModule from '@/lib/siblings-api'

const { fetchSiblings } = vi.hoisted(() => ({ fetchSiblings: vi.fn() }))
vi.mock('@/lib/siblings-api', async () => {
  const actual = await vi.importActual<typeof SiblingsApiModule>('@/lib/siblings-api')
  return { ...actual, fetchSiblings } // keep the real siblingHref
})

describe('MicroservicesList', () => {
  beforeEach(() => {
    fetchSiblings.mockReset()
  })

  it('renders each sibling with its description and a no-trailing-slash link', async () => {
    fetchSiblings.mockResolvedValue([
      { name: 'crm', description: 'Customer relationship management' },
      { name: 'cms', description: '' },
    ])

    render(<MicroservicesList />)

    expect(await screen.findByText('crm')).toBeInTheDocument()
    expect(screen.getByText('Customer relationship management')).toBeInTheDocument()

    const crmLink = screen.getByText('crm').closest('a')
    expect(crmLink).toHaveAttribute('href', '/crm') // exactly /crm, no trailing slash
    const cmsLink = screen.getByText('cms').closest('a')
    expect(cmsLink).toHaveAttribute('href', '/cms')
  })

  it('lists each declared route as a labelled link under the sibling', async () => {
    fetchSiblings.mockResolvedValue([
      {
        name: 'intake',
        description: 'Public lead capture',
        routes: [
          { path: 'demo', label: 'Book a demo' },
          { path: 'apply', label: 'Apply' },
        ],
      },
    ])

    render(<MicroservicesList />)

    // Declared routes render as labelled links to /<name>/<path>.
    expect(await screen.findByText('Book a demo')).toBeInTheDocument()
    expect(screen.getByText('Book a demo').closest('a')).toHaveAttribute('href', '/intake/demo')
    expect(screen.getByText('Apply').closest('a')).toHaveAttribute('href', '/intake/apply')
    // The wildcard plumbing path is NOT shown.
    expect(screen.queryByText('/intake/*')).not.toBeInTheDocument()
  })

  it('shows just the root link for a sibling with no declared routes', async () => {
    fetchSiblings.mockResolvedValue([{ name: 'crm', description: 'CRM' }])
    render(<MicroservicesList />)
    expect(await screen.findByText('crm')).toBeInTheDocument()
    expect(screen.getByText('crm').closest('a')).toHaveAttribute('href', '/crm')
    expect(screen.getByText('/crm')).toBeInTheDocument()
  })

  it('links the root sibling to / and its declared routes to /<path>, never /app', async () => {
    fetchSiblings.mockResolvedValue([
      {
        name: ROOT_SIBLING_NAME,
        description: 'The platform itself',
        routes: [{ path: 'dashboard', label: 'Founder Dashboard' }],
      },
    ])

    render(<MicroservicesList />)

    expect(await screen.findByText(ROOT_SIBLING_NAME)).toBeInTheDocument()
    expect(screen.getByText(ROOT_SIBLING_NAME).closest('a')).toHaveAttribute('href', '/')
    expect(screen.getByText('Founder Dashboard').closest('a')).toHaveAttribute('href', '/dashboard')
  })

  it('shows an empty state when there are no siblings', async () => {
    fetchSiblings.mockResolvedValue([])
    render(<MicroservicesList />)
    expect(await screen.findByText('No microservices yet')).toBeInTheDocument()
  })

  it('surfaces an error when the manifest fails to load', async () => {
    fetchSiblings.mockRejectedValue(new Error('Could not load microservices (404)'))
    render(<MicroservicesList />)
    await waitFor(() => {
      expect(screen.getByText('Could not load microservices (404)')).toBeInTheDocument()
    })
  })
})
