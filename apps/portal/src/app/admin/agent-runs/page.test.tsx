import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AgentRunsPage from './page'
import type * as AgentRunsApiModule from '@/lib/agent-runs-api'
import type { AgentRunSummary, AgentRunCostAggregate } from '@/lib/agent-runs-api'

vi.mock('@/context/auth-context', () => ({
  useAuth: () => ({ getIdToken: () => 'fake-token' }),
}))

vi.mock('@/lib/api-client', () => ({
  createApiClient: () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }),
}))

const { fetchAgentRuns, fetchAgentRunCosts } = vi.hoisted(() => ({
  fetchAgentRuns: vi.fn(),
  fetchAgentRunCosts: vi.fn(),
}))

vi.mock('@/lib/agent-runs-api', async () => {
  const actual = await vi.importActual<typeof AgentRunsApiModule>('@/lib/agent-runs-api')
  return { ...actual, fetchAgentRuns, fetchAgentRunCosts }
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
    fetchAgentRunCosts.mockReset()
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

describe('AgentRunsPage cost summary', () => {
  const costAggregates: AgentRunCostAggregate[] = [
    {
      model: 'anthropic/claude-sonnet-4',
      runs: 10,
      total_cost_usd: 0.1,
      total_input_tokens: 2000,
      total_output_tokens: 1000,
      unpriced_runs: 0,
    },
    {
      model: 'anthropic/claude-opus-4',
      runs: 5,
      total_cost_usd: 0.05,
      total_input_tokens: 1000,
      total_output_tokens: 500,
      unpriced_runs: 2,
    },
    {
      model: null,
      runs: 3,
      total_cost_usd: 0.03,
      total_input_tokens: 500,
      total_output_tokens: 200,
      unpriced_runs: 1,
    },
  ]

  beforeEach(() => {
    fetchAgentRuns.mockReset()
    fetchAgentRunCosts.mockReset()
  })

  it('renders per-model cost totals', async () => {
    fetchAgentRuns.mockResolvedValue([run])
    fetchAgentRunCosts.mockResolvedValue(costAggregates)
    render(<AgentRunsPage />)

    await waitFor(() => {
      expect(fetchAgentRunCosts).toHaveBeenCalled()
    })

    // Check that the cost summary table has been rendered with totals
    // Look for "Mean Cost / Run" which is unique to the summary table
    expect(await screen.findByText('Mean Cost / Run')).toBeInTheDocument()
    // Check that the total costs appear in the document
    expect(screen.getByText('$0.1000')).toBeInTheDocument()
    expect(screen.getByText('$0.0500')).toBeInTheDocument()
  })

  it('renders unpriced count when non-zero', async () => {
    fetchAgentRuns.mockResolvedValue([run])
    fetchAgentRunCosts.mockResolvedValue(costAggregates)
    render(<AgentRunsPage />)

    await waitFor(() => {
      expect(fetchAgentRunCosts).toHaveBeenCalled()
    })

    // unpriced_runs should appear for models that have unpriced runs
    expect(await screen.findByText(/2 unpriced/)).toBeInTheDocument()
    expect(screen.getByText(/1 unpriced/)).toBeInTheDocument()
  })

  it('does not render unpriced count when zero', async () => {
    fetchAgentRuns.mockResolvedValue([run])
    // Only the model with 0 unpriced runs, to avoid multiple matching elements
    fetchAgentRunCosts.mockResolvedValue([
      {
        model: 'anthropic/claude-sonnet-4',
        runs: 10,
        total_cost_usd: 0.1,
        total_input_tokens: 2000,
        total_output_tokens: 1000,
        unpriced_runs: 0,
      },
    ])
    render(<AgentRunsPage />)

    await waitFor(() => {
      expect(fetchAgentRunCosts).toHaveBeenCalled()
    })

    // The model row should show the cost but not have an unpriced count
    expect(await screen.findByText('$0.1000')).toBeInTheDocument()
    // Make sure "unpriced" does not appear in the summary table
    // Use the unique "Mean Cost / Run" header to identify the summary table
    const summaryText = screen.getByText('Mean Cost / Run').closest('table')?.textContent
    expect(summaryText).not.toContain('unpriced')
  })

  it('renders null model as explicit unknown text', async () => {
    fetchAgentRuns.mockResolvedValue([run])
    fetchAgentRunCosts.mockResolvedValue(costAggregates)
    render(<AgentRunsPage />)

    await waitFor(() => {
      expect(fetchAgentRunCosts).toHaveBeenCalled()
    })

    // The null model should render as "unknown model" or similar explicit text
    expect(await screen.findByText(/unknown model/i)).toBeInTheDocument()
  })

  it('computes mean cost over priced runs only', async () => {
    fetchAgentRuns.mockResolvedValue([run])
    // Test case: 5 runs, $0.05 total cost, but 2 unpriced
    // Mean should be $0.05 / (5 - 2) = $0.05 / 3 = $0.0167
    fetchAgentRunCosts.mockResolvedValue([
      {
        model: 'anthropic/claude-opus-4',
        runs: 5,
        total_cost_usd: 0.05,
        total_input_tokens: 1000,
        total_output_tokens: 500,
        unpriced_runs: 2,
      },
    ])
    render(<AgentRunsPage />)

    await waitFor(() => {
      expect(fetchAgentRunCosts).toHaveBeenCalled()
    })

    // Mean cost should be $0.0167 (0.05 / (5 - 2))
    expect(await screen.findByText('$0.0167')).toBeInTheDocument()
  })
})
