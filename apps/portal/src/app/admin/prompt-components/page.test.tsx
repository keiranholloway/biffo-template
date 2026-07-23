import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PromptComponentsPage from './page'
import type * as PromptComponentsApiModule from '@/lib/prompt-components-api'
import type { PromptComponent } from '@/lib/prompt-components-api'
import { HANDOFF_KEY } from '@/lib/prompt-handoff'

vi.mock('@/context/auth-context', () => ({
  useAuth: () => ({ getIdToken: () => 'fake-token' }),
}))

vi.mock('@/lib/api-client', () => ({
  createApiClient: () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }),
}))

const {
  fetchPromptComponents,
  createPromptComponent,
  updatePromptComponent,
  deletePromptComponent,
} = vi.hoisted(() => ({
  fetchPromptComponents: vi.fn(),
  createPromptComponent: vi.fn(),
  updatePromptComponent: vi.fn(),
  deletePromptComponent: vi.fn(),
}))

vi.mock('@/lib/prompt-components-api', async () => {
  const actual = await vi.importActual<typeof PromptComponentsApiModule>(
    '@/lib/prompt-components-api',
  )
  return {
    ...actual,
    fetchPromptComponents,
    createPromptComponent,
    updatePromptComponent,
    deletePromptComponent,
  }
})

const houseStyle: PromptComponent = {
  id: 'pc-1',
  tenant_id: 'default',
  created_at: '2026-07-20T09:30:00Z',
  updated_at: '2026-07-20T09:30:00Z',
  name: 'house-style',
  description: 'Shared tone',
  body: 'State confidence per claim. Cite sources.',
  variables: [],
}

const leadScorer: PromptComponent = {
  id: 'pc-2',
  tenant_id: 'default',
  created_at: '2026-07-20T09:30:00Z',
  updated_at: '2026-07-20T09:30:00Z',
  name: 'lead-scorer',
  description: null,
  body: 'Score leads for {{region}}.',
  variables: [{ name: 'region', required: true }],
}

describe('PromptComponentsPage', () => {
  beforeEach(() => {
    fetchPromptComponents.mockReset()
    createPromptComponent.mockReset()
    updatePromptComponent.mockReset()
    deletePromptComponent.mockReset()
    window.sessionStorage.clear()
  })

  it('renders components from the mocked client', async () => {
    fetchPromptComponents.mockResolvedValue([houseStyle, leadScorer])
    render(<PromptComponentsPage />)

    expect(await screen.findByText('house-style')).toBeInTheDocument()
    expect(screen.getByText('lead-scorer')).toBeInTheDocument()
    expect(screen.getByText('Shared tone')).toBeInTheDocument()
    // The variable name renders as a chip.
    expect(screen.getByText('region')).toBeInTheDocument()
  })

  it('shows an empty state when there are no components', async () => {
    fetchPromptComponents.mockResolvedValue([])
    render(<PromptComponentsPage />)
    expect(await screen.findByText('No prompt components yet')).toBeInTheDocument()
  })

  it('creates a component with the variables list in the body', async () => {
    fetchPromptComponents.mockResolvedValue([])
    createPromptComponent.mockResolvedValue(leadScorer)
    render(<PromptComponentsPage />)
    await screen.findByText('No prompt components yet')

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'lead-scorer' } })
    fireEvent.change(screen.getByLabelText('Body'), {
      target: { value: 'Score leads for {{region}}.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add variable' }))
    fireEvent.change(screen.getByLabelText('Variable 1 name'), { target: { value: 'region' } })
    fireEvent.change(screen.getByLabelText('Variable 1 description'), {
      target: { value: 'Target region' },
    })
    fireEvent.click(screen.getByLabelText('Variable 1 required'))
    fireEvent.click(screen.getByRole('button', { name: 'Add component' }))

    // Exact object equality — an empty default is omitted (no `default` key),
    // not sent as "".
    await waitFor(() => {
      expect(createPromptComponent).toHaveBeenCalledWith(expect.anything(), {
        name: 'lead-scorer',
        description: null,
        body: 'Score leads for {{region}}.',
        variables: [{ name: 'region', required: true, description: 'Target region' }],
      })
    })
  })

  it('loads a component for editing and PUTs the update', async () => {
    fetchPromptComponents.mockResolvedValue([houseStyle])
    updatePromptComponent.mockResolvedValue(houseStyle)
    render(<PromptComponentsPage />)
    await screen.findByText('house-style')

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('Name')).toHaveValue('house-style')
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Be concise.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => {
      expect(updatePromptComponent).toHaveBeenCalledWith(
        expect.anything(),
        'pc-1',
        expect.objectContaining({ name: 'house-style', body: 'Be concise.', variables: [] }),
      )
    })
  })

  it('deletes a component', async () => {
    fetchPromptComponents.mockResolvedValue([houseStyle])
    deletePromptComponent.mockResolvedValue(undefined)
    render(<PromptComponentsPage />)
    await screen.findByText('house-style')

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => {
      expect(deletePromptComponent).toHaveBeenCalledWith(expect.anything(), 'pc-1')
    })
  })

  it('surfaces a server 409 rather than swallowing it, keeping the form populated', async () => {
    fetchPromptComponents.mockResolvedValue([])
    createPromptComponent.mockRejectedValue(new Error('409: component name already exists'))
    render(<PromptComponentsPage />)
    await screen.findByText('No prompt components yet')

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'house-style' } })
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add component' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('409: component name already exists')
    // The form keeps the author's input after the failure.
    expect(screen.getByLabelText('Name')).toHaveValue('house-style')
  })

  it('consumes a prompt-component-body handoff, pre-filling Body and clearing it', async () => {
    fetchPromptComponents.mockResolvedValue([])
    window.sessionStorage.setItem(
      HANDOFF_KEY,
      JSON.stringify({ target: 'prompt-component-body', text: 'A handed-off clause.' }),
    )
    render(<PromptComponentsPage />)

    await waitFor(() => {
      expect(screen.getByLabelText('Body')).toHaveValue('A handed-off clause.')
    })
    // Consumed exactly once — the key is cleared so a reload does not re-apply it.
    expect(window.sessionStorage.getItem(HANDOFF_KEY)).toBeNull()
  })

  it('ignores a handoff targeted at another surface', async () => {
    fetchPromptComponents.mockResolvedValue([])
    window.sessionStorage.setItem(
      HANDOFF_KEY,
      JSON.stringify({ target: 'agent-goals', text: 'For the orchestration page.' }),
    )
    render(<PromptComponentsPage />)
    await screen.findByText('No prompt components yet')

    // Body is untouched, and the handoff is left in place for the page that owns it.
    expect(screen.getByLabelText('Body')).toHaveValue('')
    expect(window.sessionStorage.getItem(HANDOFF_KEY)).not.toBeNull()
  })

  it('surfaces a server 422 variable-shape error', async () => {
    fetchPromptComponents.mockResolvedValue([])
    createPromptComponent.mockRejectedValue(
      new Error('422: variables[0].name must be a valid identifier'),
    )
    render(<PromptComponentsPage />)
    await screen.findByText('No prompt components yet')

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'bad' } })
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add component' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '422: variables[0].name must be a valid identifier',
    )
  })
})
