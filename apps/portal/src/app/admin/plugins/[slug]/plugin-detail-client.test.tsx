import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PluginDetailPageClient } from './plugin-detail-client'

const { useSearchParamsMock } = vi.hoisted(() => ({ useSearchParamsMock: vi.fn() }))
vi.mock('next/navigation', () => ({
  useSearchParams: useSearchParamsMock,
}))

vi.mock('@/components/PluginDetail', () => ({
  PluginDetail: ({ slug }: { slug: string }) => <div data-testid="marketplace-detail">{slug}</div>,
}))

vi.mock('@/components/InstalledPluginDetail', () => ({
  InstalledPluginDetail: ({ name }: { name: string }) => (
    <div data-testid="installed-detail">{name}</div>
  ),
}))

function searchParamsFrom(query: string): URLSearchParams {
  return new URLSearchParams(query)
}

describe('PluginDetailPageClient', () => {
  it('renders InstalledPluginDetail when source=installed', () => {
    useSearchParamsMock.mockReturnValue(searchParamsFrom('source=installed&name=rbac'))
    render(<PluginDetailPageClient />)

    expect(screen.getByTestId('installed-detail')).toHaveTextContent('rbac')
    expect(screen.queryByTestId('marketplace-detail')).not.toBeInTheDocument()
  })

  it('renders PluginDetail (marketplace) when source=marketplace', () => {
    useSearchParamsMock.mockReturnValue(searchParamsFrom('source=marketplace&name=analytics'))
    render(<PluginDetailPageClient />)

    expect(screen.getByTestId('marketplace-detail')).toHaveTextContent('analytics')
    expect(screen.queryByTestId('installed-detail')).not.toBeInTheDocument()
  })

  it('defaults to marketplace when source is absent', () => {
    useSearchParamsMock.mockReturnValue(searchParamsFrom('name=analytics'))
    render(<PluginDetailPageClient />)

    expect(screen.getByTestId('marketplace-detail')).toHaveTextContent('analytics')
  })
})
