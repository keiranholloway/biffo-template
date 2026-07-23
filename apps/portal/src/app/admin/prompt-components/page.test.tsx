import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PromptComponentsPage from './page'
import type * as PromptComponentsApiModule from '@/lib/prompt-components-api'
import type { PromptComponent } from '@/lib/prompt-components-api'
import type * as ApiClientModule from '@/lib/api-client'
import type * as AgentChatApiModule from '@/lib/agent-chat-api'

// A stable getIdToken identity across renders, mirroring the real context's
// `useCallback` — otherwise `client` (a useMemo of it) would change every render
// and re-fire the load effect mid-test.
const { getIdToken } = vi.hoisted(() => ({ getIdToken: () => 'fake-token' }))
vi.mock('@/context/auth-context', () => ({
  useAuth: () => ({ getIdToken }),
}))

// Preserve the real ApiError — the AssistantDrawer (rendered by this page) does
// `err instanceof ApiError`; stub only the client factory.
vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('@/lib/api-client')
  return {
    ...actual,
    createApiClient: () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }),
  }
})

const { sendAgentChat } = vi.hoisted(() => ({ sendAgentChat: vi.fn() }))
vi.mock('@/lib/agent-chat-api', async () => {
  const actual = await vi.importActual<typeof AgentChatApiModule>('@/lib/agent-chat-api')
  return { ...actual, sendAgentChat }
})

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
    sendAgentChat.mockReset()
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

  it('fills the Body textarea from an accepted AI draft (in-context drawer)', async () => {
    fetchPromptComponents.mockResolvedValue([])
    sendAgentChat.mockResolvedValue({
      thread_id: 'th-1',
      run_id: 'r1',
      reply: 'State confidence per claim. Cite sources.',
    })
    render(<PromptComponentsPage />)
    await screen.findByText('No prompt components yet')

    // Name flows into the drawer context; the manual Body field is unchanged.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'house-style' } })
    fireEvent.click(screen.getByRole('button', { name: '✨ Draft body with AI' }))
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'draft a house style' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Use this draft' }))

    // The reply fills Body in place; the drawer closes.
    await waitFor(() => {
      expect(screen.getByLabelText('Body')).toHaveValue('State confidence per claim. Cite sources.')
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    const firstCall = sendAgentChat.mock.calls[0]?.[1] as { message: string }
    expect(firstCall.message).toContain('prompt component “house-style”')
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
