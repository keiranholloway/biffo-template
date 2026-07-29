import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentRunDetailClient, parseContent } from './agent-run-detail-client'
import type * as AgentRunsApiModule from '@/lib/agent-runs-api'
import type { AgentRunResponse } from '@/lib/agent-runs-api'

const { useSearchParamsMock } = vi.hoisted(() => ({ useSearchParamsMock: vi.fn() }))
vi.mock('next/navigation', () => ({ useSearchParams: useSearchParamsMock }))

vi.mock('@/context/auth-context', () => ({
  useAuth: () => ({ getIdToken: () => 'fake-token' }),
}))

vi.mock('@/lib/api-client', () => ({
  createApiClient: () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }),
}))

const { fetchAgentRun } = vi.hoisted(() => ({ fetchAgentRun: vi.fn() }))

vi.mock('@/lib/agent-runs-api', async () => {
  const actual = await vi.importActual<typeof AgentRunsApiModule>('@/lib/agent-runs-api')
  return { ...actual, fetchAgentRun }
})

const runRecord: AgentRunResponse = {
  id: 'run-123',
  tenant_id: 'default',
  created_at: '2026-07-20T09:30:00Z',
  updated_at: '2026-07-20T09:30:05Z',
  workflow_run_id: null,
  dry_run: false,
  idempotency_key: null,
  agent_name: 'demo-enricher',
  status: 'completed',
  run_as_kind: 'system',
  run_as_user_id: null,
  thread_id: null,
  causation_id: null,
  depth: 0,
  definition_snapshot: { model: 'anthropic/claude-sonnet-4', tools: ['web_search'] },
  input_payload: { company: 'Acme' },
  messages: [
    { role: 'system', content: 'Enrich the demo request.' },
    {
      role: 'user',
      content: '<untrusted-context>\n{\n  "company": "Acme"\n}\n</untrusted-context>',
    },
    { role: 'assistant', content: 'Acme is a mid-market manufacturer.' },
    {
      role: 'tool',
      tool_call_id: 'call-1',
      name: 'web_search',
      content:
        '<untrusted-tool-result tool="web_search">\nAcme Corp, Ohio.\n</untrusted-tool-result>',
    },
  ],
  result: { summary: 'Acme is a manufacturer.' },
  error: null,
  input_tokens: 1200,
  output_tokens: 340,
  cost_usd: 0.0123,
  started_at: '2026-07-20T09:30:00.000Z',
  completed_at: '2026-07-20T09:30:01.400Z',
  prompt_version_id: null,
}

function searchParamsFrom(query: string): URLSearchParams {
  return new URLSearchParams(query)
}

describe('parseContent', () => {
  it('splits an untrusted-context block from surrounding prose', () => {
    const segments = parseContent('before\n<untrusted-context>\ndata\n</untrusted-context>\nafter')
    expect(segments).toEqual([
      { kind: 'trusted', text: 'before' },
      { kind: 'untrusted', tool: undefined, text: 'data' },
      { kind: 'trusted', text: 'after' },
    ])
  })

  it('captures the tool name from an untrusted-tool-result fence', () => {
    const segments = parseContent(
      '<untrusted-tool-result tool="web_search">\nsnippet\n</untrusted-tool-result>',
    )
    expect(segments).toEqual([{ kind: 'untrusted', tool: 'web_search', text: 'snippet' }])
  })

  it('treats content with no fence as a single trusted segment', () => {
    expect(parseContent('just prose')).toEqual([{ kind: 'trusted', text: 'just prose' }])
  })
})

describe('AgentRunDetailClient', () => {
  beforeEach(() => {
    fetchAgentRun.mockReset()
    useSearchParamsMock.mockReset()
  })

  it('reads the run id from useSearchParams (not a route param) and fetches it', async () => {
    useSearchParamsMock.mockReturnValue(searchParamsFrom('run=run-123'))
    fetchAgentRun.mockResolvedValue(runRecord)

    render(<AgentRunDetailClient />)

    expect(await screen.findByRole('heading', { name: 'demo-enricher' })).toBeInTheDocument()
    expect(fetchAgentRun).toHaveBeenCalledWith(expect.anything(), 'run-123')
  })

  it('renders the message thread with each role', async () => {
    useSearchParamsMock.mockReturnValue(searchParamsFrom('run=run-123'))
    fetchAgentRun.mockResolvedValue(runRecord)

    render(<AgentRunDetailClient />)
    await screen.findByRole('heading', { name: 'demo-enricher' })

    expect(screen.getByText('System')).toBeInTheDocument()
    expect(screen.getByText('User (context)')).toBeInTheDocument()
    expect(screen.getByText('Assistant')).toBeInTheDocument()
    expect(screen.getByText('Tool result')).toBeInTheDocument()
    expect(screen.getByText('Acme is a mid-market manufacturer.')).toBeInTheDocument()
  })

  it('renders fenced/untrusted content in a distinct block, stripped of markers', async () => {
    useSearchParamsMock.mockReturnValue(searchParamsFrom('run=run-123'))
    fetchAgentRun.mockResolvedValue(runRecord)

    render(<AgentRunDetailClient />)
    await screen.findByRole('heading', { name: 'demo-enricher' })

    const blocks = screen.getAllByTestId('untrusted-block')
    // One for the untrusted-context payload, one for the tool result.
    expect(blocks).toHaveLength(2)
    // The "not instructions" framing is what makes it data-not-instructions.
    expect(screen.getAllByText('Untrusted data — not instructions').length).toBe(2)
    // The raw fence markers must not leak into the rendered text.
    expect(screen.queryByText(/<untrusted-context>/)).not.toBeInTheDocument()
    // The tool that produced a block is named.
    expect(screen.getByText('from tool: web_search')).toBeInTheDocument()
  })

  it('surfaces an error when no run id is present', async () => {
    useSearchParamsMock.mockReturnValue(searchParamsFrom(''))
    render(<AgentRunDetailClient />)
    expect(await screen.findByText('No run selected.')).toBeInTheDocument()
  })

  it('shows the prompt_version_id when present', async () => {
    useSearchParamsMock.mockReturnValue(searchParamsFrom('run=run-123'))
    const recordWithVersion: AgentRunResponse = {
      ...runRecord,
      prompt_version_id: 'agent-version-42',
    }
    fetchAgentRun.mockResolvedValue(recordWithVersion)

    render(<AgentRunDetailClient />)
    await screen.findByRole('heading', { name: 'demo-enricher' })

    // The stat should show the prompt version id
    expect(screen.getByText('Prompt version')).toBeInTheDocument()
    expect(screen.getByText('agent-version-42')).toBeInTheDocument()
  })

  it('does not show prompt_version_id stat when null', async () => {
    useSearchParamsMock.mockReturnValue(searchParamsFrom('run=run-123'))
    const recordWithoutVersion: AgentRunResponse = {
      ...runRecord,
      prompt_version_id: null,
    }
    fetchAgentRun.mockResolvedValue(recordWithoutVersion)

    render(<AgentRunDetailClient />)
    await screen.findByRole('heading', { name: 'demo-enricher' })

    // The stat should not appear
    expect(screen.queryByText('Prompt version')).not.toBeInTheDocument()
  })
})
