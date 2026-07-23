import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PromptAssistantPage from './page'
// The mock below spreads the actual module, so this resolves to the real class
// — the same one the page uses for `err instanceof ApiError`.
import { ApiError } from '@/lib/api-client'
import type * as ApiClientModule from '@/lib/api-client'
import type * as AgentChatApiModule from '@/lib/agent-chat-api'
import { HANDOFF_KEY } from '@/lib/prompt-handoff'

const { push } = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

vi.mock('@/context/auth-context', () => ({
  useAuth: () => ({ getIdToken: () => 'fake-token' }),
}))

// Keep the real ApiError (the page does `err instanceof ApiError`); stub only
// the client factory.
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

function typeAndSend(text: string) {
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

describe('PromptAssistantPage', () => {
  beforeEach(() => {
    sendAgentChat.mockReset()
    push.mockReset()
    window.sessionStorage.clear()
  })

  it('rounds a turn trip and appends the assistant reply', async () => {
    sendAgentChat.mockResolvedValue({
      thread_id: 'th-1',
      run_id: 'run-1',
      reply: 'Here is a draft: triage inbound leads by intent.',
      model: 'anthropic/claude-sonnet-4',
      cost_usd: 0.0021,
    })
    render(<PromptAssistantPage />)

    typeAndSend('Help me write agent instructions')

    expect(
      await screen.findByText('Here is a draft: triage inbound leads by intent.'),
    ).toBeInTheDocument()
    // The user turn is in the transcript too.
    expect(screen.getByText('Help me write agent instructions')).toBeInTheDocument()
    // First turn omits thread_id.
    expect(sendAgentChat).toHaveBeenCalledWith(expect.anything(), {
      message: 'Help me write agent instructions',
    })
    // Optional metadata renders.
    expect(screen.getByText('anthropic/claude-sonnet-4')).toBeInTheDocument()
    expect(screen.getByText('$0.0021')).toBeInTheDocument()
  })

  it('threads thread_id onto the second turn', async () => {
    sendAgentChat
      .mockResolvedValueOnce({ thread_id: 'th-42', run_id: 'r1', reply: 'first reply' })
      .mockResolvedValueOnce({ thread_id: 'th-42', run_id: 'r2', reply: 'second reply' })
    render(<PromptAssistantPage />)

    typeAndSend('first')
    await screen.findByText('first reply')

    typeAndSend('second')
    await screen.findByText('second reply')

    expect(sendAgentChat).toHaveBeenNthCalledWith(2, expect.anything(), {
      message: 'second',
      thread_id: 'th-42',
    })
  })

  it('does not send an empty or whitespace-only message', () => {
    render(<PromptAssistantPage />)
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: '   ' } })
    // Button stays disabled; clicking is a no-op.
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(sendAgentChat).not.toHaveBeenCalled()
  })

  it('surfaces a 502 as transient and keeps the input enabled for retry', async () => {
    sendAgentChat.mockRejectedValueOnce(
      new ApiError(502, JSON.stringify({ detail: 'The assistant turn failed.' })),
    )
    render(<PromptAssistantPage />)

    typeAndSend('draft something')

    expect(await screen.findByRole('alert')).toHaveTextContent('The assistant turn failed.')
    // Input stays usable.
    expect(screen.getByLabelText('Message')).not.toBeDisabled()
  })

  it('disables input when the assistant is not configured (503)', async () => {
    sendAgentChat.mockRejectedValueOnce(
      new ApiError(503, JSON.stringify({ detail: 'No model key set.' })),
    )
    render(<PromptAssistantPage />)

    typeAndSend('hello')

    expect(await screen.findByRole('alert')).toHaveTextContent('No model key set.')
    expect(await screen.findByRole('alert')).toHaveTextContent('not configured on this deployment')
    // Input is disabled — retrying cannot succeed.
    expect(screen.getByLabelText('Message')).toBeDisabled()
  })

  it('stashes the reply in sessionStorage and navigates on "Use this"', async () => {
    sendAgentChat.mockResolvedValue({
      thread_id: 'th-1',
      run_id: 'r1',
      reply: 'A reusable clause.',
    })
    render(<PromptAssistantPage />)

    typeAndSend('write a house style')
    await screen.findByText('A reusable clause.')

    fireEvent.click(screen.getByRole('button', { name: 'Send to agent goals' }))

    expect(push).toHaveBeenCalledWith('/admin/orchestration/')
    const stored = JSON.parse(window.sessionStorage.getItem(HANDOFF_KEY) ?? 'null') as unknown
    expect(stored).toEqual({ target: 'agent-goals', text: 'A reusable clause.' })
  })

  it('offers all three handoff targets on an assistant reply', async () => {
    sendAgentChat.mockResolvedValue({ thread_id: 'th-1', run_id: 'r1', reply: 'text' })
    render(<PromptAssistantPage />)
    typeAndSend('x')
    await screen.findByText('text')

    expect(screen.getByRole('button', { name: 'Send to prompt component' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send to agent instructions' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send to agent goals' })).toBeInTheDocument()
  })
})
