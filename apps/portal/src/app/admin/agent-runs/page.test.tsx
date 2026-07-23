import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AgentRunsPage from './page'
import type * as AgentRunsApiModule from '@/lib/agent-runs-api'
import type { AgentRunSummary } from '@/lib/agent-runs-api'

vi.mock('@/context/auth-context', () => ({
  useAuth: () => ({ getIdToken: () => 'fake-token' }),
}))

vi.mock('@/lib/api-client', () => ({
  createApiClient: () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }),
}))

const { fetchAgentRuns } = vi.hoisted(() => ({ fetchAgentRuns: vi.fn() }))

vi.mock('@/lib/agent-runs-api', async () => {
  const actual = await vi.importActual<typeof AgentRunsApiModule>('@/lib/agent-runs-api')
  return { ...actual, fetchAgentRuns }
})

const run: AgentRunSummary = {
  id: 'run-123',
  tenant_id: 'default',
  created_at: '2026-07-20T09:30:00Z',
  updated_at: '2026-07-20T09:30:05Z',
  agent_name: 'demo-enricher',
  status: 'completed',
  model: 'anthropic/claude-sonnet-4',
  input_tokens: 1200,
  output_tokens: 340,
  cost_usd: 0.0123,
  started_at: '2026-07-20T09:30:00.000Z',
  completed_at: '2026-07-20T09:30:01.400Z',
}

describe('AgentRunsPage', () => {
  beforeEach(() => {
    fetchAgentRuns.mockReset()
  })

  it('renders rows from the mocked client', async () => {
    fetchAgentRuns.mockResolvedValue([run])
    render(<AgentRunsPage />)

    expect(await screen.findByText('demo-enricher')).toBeInTheDocument()
    // "completed" also appears as a filter <option>, so scope to the status badge (a <span>).
    expect(screen.getByText('completed', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByText('anthropic/claude-sonnet-4')).toBeInTheDocument()
    expect(screen.getByText('$0.0123')).toBeInTheDocument()
    // Row links to the placeholder detail path with the run id as a query param.
    const link = screen.getByRole('link', { name: 'demo-enricher' })
    expect(link).toHaveAttribute('href', '/admin/agent-runs/placeholder?run=run-123')
  })

  it('shows an empty state when there are no runs', async () => {
    fetchAgentRuns.mockResolvedValue([])
    render(<AgentRunsPage />)
    expect(await screen.findByText('No agent runs')).toBeInTheDocument()
  })

  it('applies agent_name and status filters', async () => {
    fetchAgentRuns.mockResolvedValue([run])
    render(<AgentRunsPage />)
    await screen.findByText('demo-enricher')

    fireEvent.change(screen.getByLabelText('Filter by agent name'), {
      target: { value: 'demo-enricher' },
    })
    fireEvent.change(screen.getByLabelText('Filter by status'), {
      target: { value: 'failed' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => {
      expect(fetchAgentRuns).toHaveBeenLastCalledWith(expect.anything(), {
        agent_name: 'demo-enricher',
        status: 'failed',
      })
    })
  })
})
