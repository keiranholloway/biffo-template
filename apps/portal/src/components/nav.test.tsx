import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Nav } from './nav'

vi.mock('@/context/auth-context', () => ({
  useAuth: () => ({ session: null, logout: vi.fn() }),
}))

describe('Nav', () => {
  it('links to the core admin surfaces', () => {
    render(<Nav />)
    expect(screen.getByRole('link', { name: 'Workflows' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Prompt library' })).toBeInTheDocument()
  })

  it('no longer surfaces the retired standalone prompt assistant', () => {
    render(<Nav />)
    // The assistant now lives in an in-context drawer (ADR-0016), not a nav entry.
    expect(screen.queryByRole('link', { name: 'Prompt assistant' })).not.toBeInTheDocument()
  })
})
