import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MicroservicesList } from './MicroservicesList'
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

  it('lists every route pattern per sibling (bare entry + wildcard), not just the link', async () => {
    fetchSiblings.mockResolvedValue([{ name: 'intake', description: 'Public lead capture' }])

    render(<MicroservicesList />)

    // Both CloudFront behaviors are shown on the card...
    expect(await screen.findByText('/intake')).toBeInTheDocument()
    expect(screen.getByText('/intake/*')).toBeInTheDocument()
    // ...but only the bare path is the clickable entry point.
    expect(screen.getByText('intake').closest('a')).toHaveAttribute('href', '/intake')
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
