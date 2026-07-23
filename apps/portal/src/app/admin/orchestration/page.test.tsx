import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import OrchestrationPage from './page'
import type * as OrchestrationApiModule from '@/lib/orchestration-api'
import type {
  WorkflowCatalog,
  WorkflowDefinition,
  WorkflowInput,
  WorkflowRun,
} from '@/lib/orchestration-api'
import type { PromptComponent } from '@/lib/prompt-components-api'

vi.mock('@/context/auth-context', () => ({
  useAuth: () => ({ getIdToken: () => 'fake-token' }),
}))

vi.mock('@/lib/api-client', () => ({
  createApiClient: () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }),
}))

const {
  fetchWorkflows,
  fetchRuns,
  fetchCatalog,
  createWorkflow,
  updateWorkflow,
  setWorkflowEnabled,
  deleteWorkflow,
  fetchPromptComponents,
} = vi.hoisted(() => ({
  fetchWorkflows: vi.fn(),
  fetchRuns: vi.fn(),
  fetchCatalog: vi.fn(),
  createWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
  setWorkflowEnabled: vi.fn(),
  deleteWorkflow: vi.fn(),
  fetchPromptComponents: vi.fn(),
}))

vi.mock('@/lib/orchestration-api', async () => {
  const actual = await vi.importActual<typeof OrchestrationApiModule>('@/lib/orchestration-api')
  return {
    ...actual,
    fetchWorkflows,
    fetchRuns,
    fetchCatalog,
    createWorkflow,
    updateWorkflow,
    setWorkflowEnabled,
    deleteWorkflow,
  }
})

vi.mock('@/lib/prompt-components-api', () => ({ fetchPromptComponents }))

const catalog: WorkflowCatalog = {
  triggers: [
    {
      source: 'biffo.core',
      detail_type: 'demo.requested',
      label: 'Demo requested',
      description: 'Someone submits the "Book a demo" form.',
      origin: 'declared',
    },
    {
      source: 'biffo.core',
      detail_type: 'lead.captured',
      label: 'Lead captured',
      description: 'A lead comes in from the website or marketplace.',
      origin: 'declared',
    },
    {
      source: 'tabsii.billing',
      detail_type: 'invoice.paid',
      label: 'invoice.paid',
      description: 'Seen on the event bus.',
      origin: 'observed',
    },
  ],
  actions: [
    {
      type: 'email',
      label: 'Send email',
      config_fields: [
        { name: 'from', label: 'From', type: 'email', required: true },
        { name: 'to', label: 'To', type: 'email', required: true },
        { name: 'subject', label: 'Subject', type: 'text', required: true },
        { name: 'body', label: 'Body', type: 'textarea', required: true },
      ],
    },
    {
      type: 'whatsapp',
      label: 'WhatsApp message',
      config_fields: [
        { name: 'to', label: 'To', type: 'tel', required: true },
        {
          name: 'message_type',
          label: 'Message type',
          type: 'select',
          required: false,
          default: 'text',
          options: [
            { value: 'text', label: 'Text (reply, within 24h window)' },
            { value: 'template', label: 'Template (proactive)' },
          ],
        },
        {
          name: 'message',
          label: 'Message',
          type: 'textarea',
          required: true,
          visible_when: { field: 'message_type', equals: 'text' },
        },
        {
          name: 'template_name',
          label: 'Template name',
          type: 'text',
          required: true,
          visible_when: { field: 'message_type', equals: 'template' },
        },
        {
          name: 'language_code',
          label: 'Language code',
          type: 'text',
          required: true,
          default: 'en_US',
          visible_when: { field: 'message_type', equals: 'template' },
        },
        {
          name: 'template_params',
          label: 'Body parameters',
          type: 'text',
          required: false,
          visible_when: { field: 'message_type', equals: 'template' },
        },
      ],
    },
    {
      type: 'agent',
      label: 'Run an agent',
      available_tools: [
        {
          name: 'web_search',
          description: 'Search the public web and return the top results.',
          parameters: { type: 'object' },
        },
        {
          name: 'fetch_url',
          description: 'Fetch a URL and return its text.',
          parameters: { type: 'object' },
        },
      ],
      config_fields: [
        { name: 'agent_name', label: 'Agent name', type: 'text', required: true },
        { name: 'instructions', label: 'Instructions', type: 'textarea', required: true },
        {
          name: 'model',
          label: 'Model',
          type: 'select',
          required: true,
          default: 'moonshotai/kimi-k3',
          options: [
            { value: 'moonshotai/kimi-k3', label: 'Kimi K3 (low-cost default)' },
            { value: 'moonshotai/kimi-k3:online', label: 'Kimi K3 (web-connected)' },
            { value: 'anthropic/claude-opus-4-8', label: 'Claude Opus 4.8 (premium)' },
          ],
        },
        {
          name: 'max_turns',
          label: 'Maximum turns',
          type: 'number',
          required: false,
          default: '1',
        },
      ],
    },
  ],
}

// An agent action whose runtime registered no tools — the picker must not render.
const catalogNoTools: WorkflowCatalog = {
  triggers: catalog.triggers,
  actions: catalog.actions.map((a) => (a.type === 'agent' ? { ...a, available_tools: [] } : a)),
}

// A library component the parts editor can reference (ADR-0015).
const leadScorerComponent: PromptComponent = {
  id: 'pc-2',
  tenant_id: 'default',
  created_at: '2026-07-20T09:30:00Z',
  updated_at: '2026-07-20T09:30:00Z',
  name: 'lead-scorer',
  description: 'Score leads for a region',
  body: 'Score leads for {{region}}.',
  variables: [{ name: 'region', description: 'Target region', required: true }],
}

// The real Phase-2 catalog: the agent action's `instructions` field carries
// `parts: true` (ADR-0015), so the builder renders the ordered-parts editor
// rather than a plain textarea.
const catalogParts: WorkflowCatalog = {
  triggers: catalog.triggers,
  actions: catalog.actions.map((a) =>
    a.type === 'agent'
      ? {
          ...a,
          config_fields: a.config_fields.map((f) =>
            f.name === 'instructions' ? { ...f, parts: true } : f,
          ),
        }
      : a,
  ),
}

// An agent stored with a model that is NOT among the curated options.
const offListAgent: WorkflowDefinition = {
  id: 'wfa',
  tenant_id: 'default',
  created_at: null,
  updated_at: null,
  name: 'Enrich lead',
  trigger_source: 'biffo.core',
  trigger_detail_type: 'lead.captured',
  trigger_filter: null,
  action_type: 'agent',
  action_config: {
    agent_name: 'enricher',
    instructions: 'Enrich {company}.',
    model: 'some-vendor/experimental-v9',
    tools: ['web_search'],
  },
  enabled: true,
}

const notify: WorkflowDefinition = {
  id: 'wf1',
  tenant_id: 'default',
  created_at: null,
  updated_at: null,
  name: 'Notify sales',
  trigger_source: 'biffo.core',
  trigger_detail_type: 'demo.requested',
  trigger_filter: null,
  action_type: 'email',
  action_config: {
    from: 'keiran@tabsii.com',
    to: 'keiran@tabsii.com',
    subject: 'New demo request',
    body: 'A demo came in.',
  },
  enabled: true,
}

const succeededRun: WorkflowRun = {
  id: 'run1',
  tenant_id: 'default',
  created_at: '2026-07-20T09:30:00Z',
  updated_at: '2026-07-20T09:30:00Z',
  definition_id: 'wf1',
  definition_name: 'Notify sales',
  status: 'succeeded',
  trigger_event: { company: 'Acme' },
  logs: [
    {
      id: 'log1',
      created_at: '2026-07-20T09:30:01Z',
      run_id: 'run1',
      action_type: 'email',
      status: 'succeeded',
      response: { message_id: 'ses-1' },
      error: null,
    },
  ],
}

describe('OrchestrationPage', () => {
  beforeEach(() => {
    for (const fn of [
      fetchWorkflows,
      fetchRuns,
      fetchCatalog,
      createWorkflow,
      updateWorkflow,
      setWorkflowEnabled,
      deleteWorkflow,
      fetchPromptComponents,
    ]) {
      fn.mockReset()
    }
    fetchCatalog.mockResolvedValue(catalog)
    fetchRuns.mockResolvedValue([])
    fetchPromptComponents.mockResolvedValue([])
  })

  it('renders workflows with name, trigger label, action and status', async () => {
    fetchWorkflows.mockResolvedValue([
      notify,
      { ...notify, id: 'wf2', name: 'Notify ops', enabled: false },
    ])

    render(<OrchestrationPage />)

    expect(await screen.findByText('Notify sales')).toBeInTheDocument()
    // The trigger is shown by its catalog label, not the raw source/detail_type.
    expect(screen.getAllByText('Demo requested').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('disabled')).toBeInTheDocument()
  })

  it('shows an empty state when there are no workflows', async () => {
    fetchWorkflows.mockResolvedValue([])
    render(<OrchestrationPage />)
    expect(await screen.findByText('No workflows yet')).toBeInTheDocument()
  })

  it('creates a workflow from the form with per-action config', async () => {
    fetchWorkflows.mockResolvedValue([])
    createWorkflow.mockResolvedValue(notify)

    render(<OrchestrationPage />)
    fireEvent.change(await screen.findByPlaceholderText('Notify the sales team'), {
      target: { value: 'Sales ping' },
    })
    fireEvent.change(screen.getByLabelText('From'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'c@d.com' } })
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Hi' } })
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Hello there' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add workflow' }))

    await waitFor(() => {
      expect(createWorkflow).toHaveBeenCalledWith(expect.anything(), {
        name: 'Sales ping',
        trigger_source: 'biffo.core',
        trigger_detail_type: 'demo.requested',
        trigger_filter: null,
        action_type: 'email',
        action_config: { from: 'a@b.com', to: 'c@d.com', subject: 'Hi', body: 'Hello there' },
        enabled: true,
      })
    })
  })

  it('toggles a workflow off', async () => {
    fetchWorkflows.mockResolvedValue([notify])
    setWorkflowEnabled.mockResolvedValue({ ...notify, enabled: false })

    render(<OrchestrationPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }))

    await waitFor(() => {
      expect(setWorkflowEnabled).toHaveBeenCalledWith(expect.anything(), 'wf1', false)
    })
  })

  it('loads a workflow into the form for editing and saves it', async () => {
    fetchWorkflows.mockResolvedValue([notify])
    updateWorkflow.mockResolvedValue(notify)

    render(<OrchestrationPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))

    // The form is now prefilled with the existing name.
    const nameInput = screen.getByPlaceholderText('Notify the sales team')
    expect(nameInput).toHaveValue('Notify sales')
    fireEvent.change(nameInput, { target: { value: 'Notify sales v2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => {
      expect(updateWorkflow).toHaveBeenCalledWith(
        expect.anything(),
        'wf1',
        expect.objectContaining({ name: 'Notify sales v2', action_type: 'email' }),
      )
    })
  })

  it('deletes a workflow', async () => {
    fetchWorkflows.mockResolvedValue([notify])
    deleteWorkflow.mockResolvedValue(undefined)

    render(<OrchestrationPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(deleteWorkflow).toHaveBeenCalledWith(expect.anything(), 'wf1')
    })
  })

  it('shows only the text fields for a WhatsApp text message', async () => {
    fetchWorkflows.mockResolvedValue([])

    render(<OrchestrationPage />)
    fireEvent.change(await screen.findByLabelText('Action'), { target: { value: 'whatsapp' } })

    // `text` is the default message type, so the template fields stay hidden.
    expect(screen.getByLabelText('Message')).toBeInTheDocument()
    expect(screen.queryByLabelText('Template name')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Language code')).not.toBeInTheDocument()
  })

  it('swaps in the template fields when the message type is template', async () => {
    fetchWorkflows.mockResolvedValue([])
    createWorkflow.mockResolvedValue(notify)

    render(<OrchestrationPage />)
    fireEvent.change(await screen.findByPlaceholderText('Notify the sales team'), {
      target: { value: 'Demo booked' },
    })
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'whatsapp' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '+15551234567' } })
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'stale draft' } })
    fireEvent.change(screen.getByLabelText('Message type'), { target: { value: 'template' } })

    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()
    // The catalog default prefills the language.
    expect(screen.getByLabelText('Language code')).toHaveValue('en_US')

    fireEvent.change(screen.getByLabelText('Template name'), {
      target: { value: 'demo_booked' },
    })
    fireEvent.change(screen.getByLabelText('Body parameters'), {
      target: { value: '{company}' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add workflow' }))

    await waitFor(() => {
      expect(createWorkflow).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action_type: 'whatsapp',
          // The abandoned text branch's draft is not saved.
          action_config: {
            to: '+15551234567',
            message_type: 'template',
            template_name: 'demo_booked',
            language_code: 'en_US',
            template_params: '{company}',
          },
        }),
      )
    })
  })

  it('groups the trigger options by source', async () => {
    fetchWorkflows.mockResolvedValue([])
    render(<OrchestrationPage />)

    const select = await screen.findByLabelText('Trigger')
    const groups = Array.from(select.querySelectorAll('optgroup'))
    expect(groups.map((g) => g.label)).toEqual(['biffo.core', 'tabsii.billing'])
    const coreOptions = groups[0]?.querySelectorAll('option') ?? []
    expect(Array.from(coreOptions).map((o) => o.textContent)).toEqual([
      'Demo requested',
      'Lead captured',
    ])
  })

  it('marks an observed trigger in its option text and exposes descriptions', async () => {
    fetchWorkflows.mockResolvedValue([])
    render(<OrchestrationPage />)

    const select = await screen.findByLabelText('Trigger')
    const observed = Array.from(select.querySelectorAll('option')).find(
      (o) => o.value === 'tabsii.billing|invoice.paid',
    )
    expect(observed?.textContent).toBe('invoice.paid (observed)')
    expect(observed?.title).toBe('Seen on the event bus.')
  })

  it('badges the selected trigger declared or observed and shows its description', async () => {
    fetchWorkflows.mockResolvedValue([])
    render(<OrchestrationPage />)

    // Defaults to the first catalog trigger, which is declared.
    expect(await screen.findByText('declared')).toBeInTheDocument()
    expect(screen.getByText('Someone submits the "Book a demo" form.')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Trigger'), {
      target: { value: 'tabsii.billing|invoice.paid' },
    })

    expect(screen.getByText('observed')).toBeInTheDocument()
    expect(screen.queryByText('declared')).not.toBeInTheDocument()
    expect(screen.getByText('Seen on the event bus.')).toBeInTheDocument()
  })

  it('filters the trigger options, always keeping the current selection', async () => {
    fetchWorkflows.mockResolvedValue([])
    render(<OrchestrationPage />)

    fireEvent.change(await screen.findByLabelText('Filter triggers'), {
      target: { value: 'invoice' },
    })

    const select = screen.getByLabelText('Trigger')
    // The match, plus the still-selected default so the select's value stays valid.
    expect(Array.from(select.querySelectorAll('option')).map((o) => o.value)).toEqual([
      'biffo.core|demo.requested',
      'tabsii.billing|invoice.paid',
    ])
    expect(select).toHaveValue('biffo.core|demo.requested')
  })

  it('explains when the filter matches nothing', async () => {
    fetchWorkflows.mockResolvedValue([])
    render(<OrchestrationPage />)

    fireEvent.change(await screen.findByLabelText('Filter triggers'), {
      target: { value: 'nothing-matches-this' },
    })

    expect(screen.getByText(/No triggers match/)).toBeInTheDocument()
    const select = screen.getByLabelText('Trigger')
    expect(Array.from(select.querySelectorAll('option')).map((o) => o.value)).toEqual([
      'biffo.core|demo.requested',
    ])
  })

  it('surfaces an error when the fetch fails', async () => {
    fetchWorkflows.mockRejectedValue(new Error('administrator access required'))
    render(<OrchestrationPage />)
    expect(await screen.findByText('administrator access required')).toBeInTheDocument()
  })

  // ── "Only when…" conditions (trigger_filter) ──────────────────────────────

  it('sends conditions as a trigger_filter object', async () => {
    fetchWorkflows.mockResolvedValue([])
    createWorkflow.mockResolvedValue(notify)

    render(<OrchestrationPage />)
    fireEvent.change(await screen.findByPlaceholderText('Notify the sales team'), {
      target: { value: 'Won deals' },
    })
    fireEvent.change(screen.getByLabelText('From'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'c@d.com' } })
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Hi' } })
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Hello' } })

    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }))
    fireEvent.change(screen.getByLabelText('Condition 1 field'), { target: { value: 'status' } })
    fireEvent.change(screen.getByLabelText('Condition 1 value'), { target: { value: 'won' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add workflow' }))

    await waitFor(() => {
      expect(createWorkflow).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ trigger_filter: { status: 'won' } }),
      )
    })
  })

  it('sends null when no conditions are set', async () => {
    fetchWorkflows.mockResolvedValue([])
    createWorkflow.mockResolvedValue(notify)

    render(<OrchestrationPage />)
    fireEvent.change(await screen.findByPlaceholderText('Notify the sales team'), {
      target: { value: 'Any deal' },
    })
    fireEvent.change(screen.getByLabelText('From'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'c@d.com' } })
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Hi' } })
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add workflow' }))

    await waitFor(() => {
      expect(createWorkflow).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ trigger_filter: null }),
      )
    })
  })

  it('ignores a condition row with no field name', async () => {
    // A half-typed row must not become a filter on the empty-string key.
    fetchWorkflows.mockResolvedValue([])
    createWorkflow.mockResolvedValue(notify)

    render(<OrchestrationPage />)
    fireEvent.change(await screen.findByPlaceholderText('Notify the sales team'), {
      target: { value: 'Half typed' },
    })
    fireEvent.change(screen.getByLabelText('From'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'c@d.com' } })
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Hi' } })
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Hello' } })

    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }))
    fireEvent.change(screen.getByLabelText('Condition 1 value'), { target: { value: 'orphan' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add workflow' }))

    await waitFor(() => {
      expect(createWorkflow).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ trigger_filter: null }),
      )
    })
  })

  it('loads existing conditions into the form for editing', async () => {
    fetchWorkflows.mockResolvedValue([{ ...notify, trigger_filter: { status: 'won' } }])

    render(<OrchestrationPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))

    expect(screen.getByLabelText('Condition 1 field')).toHaveValue('status')
    expect(screen.getByLabelText('Condition 1 value')).toHaveValue('won')
  })

  it('removes a condition', async () => {
    fetchWorkflows.mockResolvedValue([{ ...notify, trigger_filter: { status: 'won' } }])
    updateWorkflow.mockResolvedValue(notify)

    render(<OrchestrationPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => {
      expect(updateWorkflow).toHaveBeenCalledWith(
        expect.anything(),
        'wf1',
        expect.objectContaining({ trigger_filter: null }),
      )
    })
  })

  it('flags a filtered workflow in the list', async () => {
    fetchWorkflows.mockResolvedValue([{ ...notify, trigger_filter: { status: 'won' } }])
    render(<OrchestrationPage />)
    expect(await screen.findByText('filtered')).toBeInTheDocument()
  })

  it('renders the run history with workflow name and outcome', async () => {
    fetchWorkflows.mockResolvedValue([notify])
    fetchRuns.mockResolvedValue([succeededRun])

    render(<OrchestrationPage />)

    expect(await screen.findByText('Recent runs')).toBeInTheDocument()
    expect(screen.getByText('succeeded')).toBeInTheDocument()
  })

  it('shows the error of a failed run', async () => {
    fetchWorkflows.mockResolvedValue([notify])
    fetchRuns.mockResolvedValue([
      {
        ...succeededRun,
        status: 'failed',
        logs: [{ ...succeededRun.logs[0], status: 'failed', error: 'SES rejected the recipient' }],
      },
    ])

    render(<OrchestrationPage />)

    expect(await screen.findByText('SES rejected the recipient')).toBeInTheDocument()
    expect(screen.getByText('failed')).toBeInTheDocument()
  })

  it('still lists a run whose workflow was deleted', async () => {
    fetchWorkflows.mockResolvedValue([])
    fetchRuns.mockResolvedValue([{ ...succeededRun, definition_name: null }])

    render(<OrchestrationPage />)

    expect(await screen.findByText('(deleted)')).toBeInTheDocument()
  })

  it('shows an empty state when nothing has run', async () => {
    fetchWorkflows.mockResolvedValue([notify])
    fetchRuns.mockResolvedValue([])

    render(<OrchestrationPage />)

    expect(await screen.findByText('Nothing has run yet')).toBeInTheDocument()
  })

  // ── agent action: tools multiselect + curated model dropdown (ADR-0014) ─────

  it('offers a tools multiselect from available_tools and writes a list', async () => {
    fetchWorkflows.mockResolvedValue([])
    createWorkflow.mockResolvedValue(notify)

    render(<OrchestrationPage />)
    fireEvent.change(await screen.findByPlaceholderText('Notify the sales team'), {
      target: { value: 'Enrich' },
    })
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'agent' } })

    // Options mirror the runtime's declared tools, with descriptions as help text.
    expect(screen.getByRole('checkbox', { name: /web_search/ })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /fetch_url/ })).toBeInTheDocument()
    expect(
      screen.getByText('Search the public web and return the top results.'),
    ).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'enricher' } })
    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'Enrich it' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /web_search/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Add workflow' }))

    await waitFor(() => {
      expect(createWorkflow).toHaveBeenCalled()
    })
    const body = createWorkflow.mock.calls.at(0)?.[1] as WorkflowInput | undefined
    expect(body?.action_type).toBe('agent')
    // A genuine list, not a scalar — and the unchecked tool is absent.
    expect(body?.action_config.tools).toEqual(['web_search'])
  })

  it('renders cleanly with no tools picker when available_tools is empty', async () => {
    fetchCatalog.mockResolvedValue(catalogNoTools)
    fetchWorkflows.mockResolvedValue([])

    render(<OrchestrationPage />)
    fireEvent.change(await screen.findByLabelText('Action'), { target: { value: 'agent' } })

    // The rest of the agent form still renders — no crash.
    expect(screen.getByLabelText('Agent name')).toBeInTheDocument()
    // No tools picker at all.
    expect(screen.queryByText('Tools')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /web_search/ })).not.toBeInTheDocument()
  })

  it('offers the curated model options in a dropdown', async () => {
    fetchWorkflows.mockResolvedValue([])

    render(<OrchestrationPage />)
    fireEvent.change(await screen.findByLabelText('Action'), { target: { value: 'agent' } })

    const model = screen.getByLabelText('Model')
    const values = Array.from(model.querySelectorAll('option')).map((o) => o.value)
    expect(values).toEqual([
      'moonshotai/kimi-k3',
      'moonshotai/kimi-k3:online',
      'anthropic/claude-opus-4-8',
    ])
    // The default is preselected.
    expect(model).toHaveValue('moonshotai/kimi-k3')
  })

  it('keeps an off-list stored model selectable and preserves it on save', async () => {
    fetchWorkflows.mockResolvedValue([offListAgent])
    updateWorkflow.mockResolvedValue(offListAgent)

    render(<OrchestrationPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))

    // The stored model — not among the curated options — is shown and selected,
    // so loading the agent does not silently reassign it to the first option.
    const model = screen.getByLabelText('Model')
    expect(model).toHaveValue('some-vendor/experimental-v9')
    const values = Array.from(model.querySelectorAll('option')).map((o) => o.value)
    expect(values).toContain('some-vendor/experimental-v9')

    // Save without touching the field: the off-list model round-trips unchanged.
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => {
      expect(updateWorkflow).toHaveBeenCalled()
    })
    const [, id, body] = updateWorkflow.mock.calls.at(0) as [unknown, string, WorkflowInput]
    expect(id).toBe('wfa')
    expect(body.action_config.model).toBe('some-vendor/experimental-v9')
    expect(body.action_config.tools).toEqual(['web_search'])
  })

  // ── redundant-web-search guidance (non-blocking, agent action only) ─────────

  const REDUNDANT_WARNING = /already performs web search/

  it('warns when a :online model and the web_search tool are both selected', async () => {
    fetchWorkflows.mockResolvedValue([])

    render(<OrchestrationPage />)
    fireEvent.change(await screen.findByLabelText('Action'), { target: { value: 'agent' } })

    // No warning yet: default model is not web-connected and no tool is picked.
    expect(screen.queryByText(REDUNDANT_WARNING)).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'moonshotai/kimi-k3:online' },
    })
    fireEvent.click(screen.getByRole('checkbox', { name: /web_search/ }))

    // Both conditions now hold — the hint appears, and the Add button stays
    // enabled (guidance, not a save-blocking gate).
    expect(screen.getByText(REDUNDANT_WARNING)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add workflow' })).not.toBeDisabled()
  })

  it('does not warn for a :online model when no web_search tool is selected', async () => {
    fetchWorkflows.mockResolvedValue([])

    render(<OrchestrationPage />)
    fireEvent.change(await screen.findByLabelText('Action'), { target: { value: 'agent' } })
    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'moonshotai/kimi-k3:online' },
    })

    expect(screen.queryByText(REDUNDANT_WARNING)).not.toBeInTheDocument()
  })

  it('does not warn for web_search with a non-online model', async () => {
    fetchWorkflows.mockResolvedValue([])

    render(<OrchestrationPage />)
    fireEvent.change(await screen.findByLabelText('Action'), { target: { value: 'agent' } })
    // Default model 'moonshotai/kimi-k3' is not web-connected.
    fireEvent.click(screen.getByRole('checkbox', { name: /web_search/ }))

    expect(screen.queryByText(REDUNDANT_WARNING)).not.toBeInTheDocument()
  })

  it('never warns for a non-agent action', async () => {
    fetchWorkflows.mockResolvedValue([])

    render(<OrchestrationPage />)
    // Email action has neither a model nor a tools picker.
    fireEvent.change(await screen.findByLabelText('Action'), { target: { value: 'email' } })

    expect(screen.queryByText(REDUNDANT_WARNING)).not.toBeInTheDocument()
  })

  // ── Ordered-parts editor for a `parts: true` field (ADR-0015 Phase 2) ──────

  it('renders `instructions` as an ordered-parts editor and writes parts JSON', async () => {
    fetchCatalog.mockResolvedValue(catalogParts)
    fetchPromptComponents.mockResolvedValue([leadScorerComponent])
    fetchWorkflows.mockResolvedValue([])
    createWorkflow.mockResolvedValue(notify)

    render(<OrchestrationPage />)
    fireEvent.change(await screen.findByPlaceholderText('Notify the sales team'), {
      target: { value: 'Score midlands leads' },
    })
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'agent' } })
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'scorer' } })

    // No plain Instructions textarea — a parts editor instead.
    expect(screen.queryByRole('textbox', { name: 'Instructions' })).not.toBeInTheDocument()

    // Add a component reference and fill its declared variable.
    fireEvent.click(screen.getByRole('button', { name: 'Add component' }))
    fireEvent.change(screen.getByLabelText('Instructions part 1 component'), {
      target: { value: 'lead-scorer' },
    })
    fireEvent.change(screen.getByLabelText('Instructions part 1 value for region'), {
      target: { value: 'Midlands' },
    })
    // Add an inline part after it.
    fireEvent.click(screen.getByRole('button', { name: 'Add text' }))
    fireEvent.change(screen.getByLabelText('Instructions part 2 text'), {
      target: { value: 'Be concise.' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Add workflow' }))

    await waitFor(() => {
      expect(createWorkflow).toHaveBeenCalled()
    })
    const body = createWorkflow.mock.calls.at(0)?.[1] as WorkflowInput | undefined
    expect(body?.action_config.instructions).toEqual([
      { component: 'lead-scorer', values: { region: 'Midlands' } },
      { inline: 'Be concise.' },
    ])
  })

  it('loads a plain-string `instructions` as a single inline part (backward shape)', async () => {
    fetchCatalog.mockResolvedValue(catalogParts)
    fetchPromptComponents.mockResolvedValue([])
    fetchWorkflows.mockResolvedValue([
      { ...offListAgent, action_config: { ...offListAgent.action_config, tools: [] } },
    ])

    render(<OrchestrationPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))

    // The pre-library string renders as one inline part carrying its text.
    expect(screen.getByLabelText('Instructions part 1 text')).toHaveValue('Enrich {company}.')
  })
})
