import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantDrawer, type AssistantContext } from './assistant-drawer'
// The mock below spreads the actual module, so this resolves to the real class
// — the same one the drawer uses for `err instanceof ApiError`.
import { ApiError } from '@/lib/api-client'
import type * as ApiClientModule from '@/lib/api-client'
import type * as AgentChatApiModule from '@/lib/agent-chat-api'

vi.mock('@/context/auth-context', () => ({
  useAuth: () => ({ getIdToken: () => 'fake-token' }),
}))

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

const instructionsCtx: AssistantContext = {
  kind: 'agent-instructions',
  agentName: 'Enrich demo',
  model: 'moonshotai/kimi-k3',
}

function renderDrawer(overrides: Partial<Parameters<typeof AssistantDrawer>[0]> = {}) {
  const onAccept = overrides.onAccept ?? vi.fn()
  const onClose = overrides.onClose ?? vi.fn()
  render(
    <AssistantDrawer
      open
      onClose={onClose}
      onAccept={onAccept}
      context={overrides.context ?? instructionsCtx}
    />,
  )
  return { onAccept, onClose }
}

function typeAndSend(text: string) {
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

describe('AssistantDrawer', () => {
  beforeEach(() => {
    sendAgentChat.mockReset()
  })

  it('shows the context header for what is being drafted', () => {
    renderDrawer()
    expect(screen.getByText('Drafting instructions for agent “Enrich demo”')).toBeInTheDocument()
  })

  it('rounds a turn trip, appends the reply, and seeds context on the first turn only', async () => {
    sendAgentChat
      .mockResolvedValueOnce({
        thread_id: 'th-1',
        run_id: 'r1',
        reply: 'First draft.',
        model: 'anthropic/claude-sonnet-4',
        cost_usd: 0.0021,
      })
      .mockResolvedValueOnce({ thread_id: 'th-1', run_id: 'r2', reply: 'Second draft.' })
    renderDrawer()

    typeAndSend('Triage inbound leads')
    expect(await screen.findByText('First draft.')).toBeInTheDocument()
    // The author's raw text is in the transcript, not the seeded variant.
    expect(screen.getByText('Triage inbound leads')).toBeInTheDocument()
    expect(screen.getByText('anthropic/claude-sonnet-4')).toBeInTheDocument()
    expect(screen.getByText('$0.0021')).toBeInTheDocument()

    // First turn: no thread_id, and the message carries a clearly-labelled
    // context seed line prepended to the author's text.
    const firstCall = sendAgentChat.mock.calls[0]?.[1] as { message: string; thread_id?: string }
    expect(firstCall.thread_id).toBeUndefined()
    expect(firstCall.message).toContain('[Context —')
    expect(firstCall.message).toContain('instructions for agent “Enrich demo”')
    expect(firstCall.message).toContain('model: moonshotai/kimi-k3')
    expect(firstCall.message).toContain('Triage inbound leads')

    // Second turn threads thread_id and sends the raw text with NO seed line.
    typeAndSend('Make it shorter')
    await screen.findByText('Second draft.')
    expect(sendAgentChat).toHaveBeenNthCalledWith(2, expect.anything(), {
      message: 'Make it shorter',
      thread_id: 'th-1',
    })
  })

  it('disables send while empty or busy', () => {
    renderDrawer()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('calls onAccept with the reply and closes on "Use this draft"', async () => {
    sendAgentChat.mockResolvedValue({
      thread_id: 'th-1',
      run_id: 'r1',
      reply: 'A reusable clause.',
    })
    const { onAccept, onClose } = renderDrawer()

    typeAndSend('write a house style')
    await screen.findByText('A reusable clause.')
    fireEvent.click(screen.getByRole('button', { name: 'Use this draft' }))

    expect(onAccept).toHaveBeenCalledWith('A reusable clause.')
    expect(onClose).toHaveBeenCalled()
  })

  it('shows the 503 server detail exactly once and disables the input', async () => {
    sendAgentChat.mockRejectedValueOnce(
      new ApiError(
        503,
        JSON.stringify({ detail: 'The assistant is not configured on this deployment.' }),
      ),
    )
    renderDrawer()

    typeAndSend('hello')

    const detail = 'The assistant is not configured on this deployment.'
    expect(await screen.findByRole('alert')).toHaveTextContent(detail)
    // Shown once — the historic doubling bug is fixed.
    expect(screen.getAllByText(detail)).toHaveLength(1)
    // Input disabled: retrying cannot succeed.
    expect(screen.getByLabelText('Message')).toBeDisabled()
  })

  it('surfaces a 502 as transient, keeping the input enabled and the turn in the transcript', async () => {
    sendAgentChat.mockRejectedValueOnce(
      new ApiError(502, JSON.stringify({ detail: 'The assistant turn failed.' })),
    )
    renderDrawer()

    typeAndSend('draft something')

    expect(await screen.findByRole('alert')).toHaveTextContent('The assistant turn failed.')
    expect(screen.getByLabelText('Message')).not.toBeDisabled()
    // The user's turn stays visible so they can retry with context.
    expect(screen.getByText('draft something')).toBeInTheDocument()
  })

  it('renders nothing when closed', () => {
    render(
      <AssistantDrawer
        open={false}
        onClose={vi.fn()}
        onAccept={vi.fn()}
        context={instructionsCtx}
      />,
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
