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
import type * as ApiClientModule from '@/lib/api-client'
import type * as AgentChatApiModule from '@/lib/agent-chat-api'
import type * as WorkflowDryRunApiModule from '@/lib/workflow-dryrun-api'
import { ApiError } from '@/lib/api-client'

// A stable getIdToken identity across renders, mirroring the real context's
// `useCallback` — otherwise `client` (a useMemo of it) would change every render
// and re-fire the catalog-load effect, resetting the form mid-test.
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

const { startWorkflowDryRun } = vi.hoisted(() => ({ startWorkflowDryRun: vi.fn() }))
vi.mock('@/lib/workflow-dryrun-api', async () => {
  const actual = await vi.importActual<typeof WorkflowDryRunApiModule>('@/lib/workflow-dryrun-api')
  return { ...actual, startWorkflowDryRun }
})

// The dry-run is asynchronous (#726): the POST only queues a run, and the panel
// polls the run for the outcome. Both halves are mocked, so a test states the
// queued id and the terminal run separately — which is also what lets a test
// assert the in-flight state without timing anything.
const { fetchAgentRun } = vi.hoisted(() => ({ fetchAgentRun: vi.fn() }))
vi.mock('@/lib/agent-runs-api', async () => {
  const actual = await vi.importActual('@/lib/agent-runs-api')
  return { ...actual, fetchAgentRun }
})

/** A terminal preview run, as `fetchAgentRun` would return it. */
function completedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-preview-1',
    tenant_id: 'default',
    agent_name: 'lead-enricher',
    status: 'completed',
    dry_run: true,
    definition_snapshot: { model: 'anthropic/claude-sonnet-4' },
    input_payload: {},
    messages: [{ role: 'assistant', content: 'ok' }],
    result: null,
    error: null,
    input_tokens: 10,
    output_tokens: 5,
    cost_usd: 0.002,
    depth: 0,
    run_as_kind: 'system',
    run_as_user_id: null,
    thread_id: null,
    causation_id: null,
    workflow_run_id: null,
    created_at: null,
    updated_at: null,
    started_at: null,
    completed_at: null,
    ...overrides,
  }
}

/** The common case: queued, then terminal on the first poll. */
function mockDryRun(run: Record<string, unknown> = completedRun()) {
  startWorkflowDryRun.mockResolvedValue({ run_id: String(run['id']), status: 'pending' })
  fetchAgentRun.mockResolvedValue(run)
}

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
  scope_levels: [],
}

/**
 * A catalog offering a write-back target (ADR-0027). Core filters this list to
 * what the *calling user* may write, so a non-empty array already means "you
 * are allowed to write here" — the builder never re-checks.
 */
const catalogWithWriteBack: WorkflowCatalog = {
  ...catalog,
  actions: catalog.actions.map((a) =>
    a.type === 'agent'
      ? {
          ...a,
          config_fields: [
            ...a.config_fields,
            { name: 'writeback', label: 'Record the result', type: 'writeback', required: false },
          ],
        }
      : a,
  ),
  scope_levels: ['tenant', 'brand'],
  writeback_targets: [
    {
      table: 'leads',
      label: 'Lead',
      operations: ['update'],
      scope_levels: ['brand'],
      row_selector: 'lead_id',
      columns: [
        {
          name: 'notes',
          label: 'Notes',
          type: 'textarea',
          required: false,
          values: [],
          overwrite: 'append',
        },
        {
          name: 'phone',
          label: 'Phone',
          type: 'tel',
          required: false,
          values: [],
          overwrite: 'if_empty',
        },
      ],
    },
  ],
}

// A catalog whose FIRST trigger declares payload fields (#505), so the builder
// loads straight into the trigger-aware "Only when…" dropdowns. It keeps the
// field-less triggers too, to exercise the free-text fallback in one fixture.
// A fan-in action carrying every structured sub-config it really has (#729).
// `output_tools` is a JSON tool schema; drawn as a generic text input it would
// put a *string* where Core expects an object.
const catalogWithFanIn: WorkflowCatalog = {
  triggers: catalog.triggers,
  actions: [
    ...catalog.actions,
    {
      type: 'agent_fan_in',
      label: 'Run an agent once several agents have finished',
      config_fields: [
        { name: 'expect_agents', label: 'Wait for these agents', type: 'text', required: true },
        { name: 'agent_name', label: 'Agent name', type: 'text', required: true },
        { name: 'instructions', label: 'Instructions', type: 'textarea', required: true },
        {
          name: 'output_tools',
          label: 'Structured result — the tool this agent must call to answer',
          type: 'output_tools',
          required: false,
        },
        { name: 'writeback', label: 'Record the result', type: 'writeback', required: false },
      ],
    },
  ],
  scope_levels: [],
}

const catalogWithFields: WorkflowCatalog = {
  triggers: [
    {
      source: 'biffo.core',
      detail_type: 'lead.updated',
      label: 'Lead updated',
      description: 'A lead row changed.',
      origin: 'declared',
      fields: [
        { name: 'status', label: 'Status', type: 'enum', values: ['new', 'won', 'lost'] },
        { name: 'score', label: 'Score', type: 'number', values: [] },
      ],
    },
    ...catalog.triggers,
  ],
  actions: catalog.actions,
  scope_levels: [],
}

// A catalog whose trigger declares fields AND whose email action's `to` is
// `payload_template`-eligible (#597 followup) — exercises the "insert field"
// picker on the recipient input.
const catalogWithPayloadTemplateTo: WorkflowCatalog = {
  triggers: catalogWithFields.triggers,
  actions: catalog.actions.map((a) =>
    a.type === 'email'
      ? {
          ...a,
          config_fields: a.config_fields.map((f) =>
            f.name === 'to' ? { ...f, payload_template: true } : f,
          ),
        }
      : a,
  ),
  scope_levels: [],
}

// A catalog whose email action's `body` (a textarea, unlike `to`'s plain
// input) is `payload_template`-eligible (#609) — exercises the picker on a
// content field, not just a recipient field.
const catalogWithPayloadTemplateBody: WorkflowCatalog = {
  triggers: catalogWithFields.triggers,
  actions: catalog.actions.map((a) =>
    a.type === 'email'
      ? {
          ...a,
          config_fields: a.config_fields.map((f) =>
            f.name === 'body' ? { ...f, payload_template: true } : f,
          ),
        }
      : a,
  ),
  scope_levels: [],
}

// A catalog whose instance has registered a hierarchy scope resolver
// (docs/implementation/0003-hierarchy-scoped-workflows) — the Scope section
// only renders when `scope_levels` is non-empty.
const catalogWithScopeLevels: WorkflowCatalog = {
  ...catalog,
  scope_levels: ['tenant', 'brand', 'region', 'unit'],
}

// An agent action whose runtime registered no tools — the picker must not render.
const catalogNoTools: WorkflowCatalog = {
  triggers: catalog.triggers,
  actions: catalog.actions.map((a) => (a.type === 'agent' ? { ...a, available_tools: [] } : a)),
  scope_levels: [],
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
  scope_levels: [],
}

// Like catalogParts, but the agent action ALSO carries a `goals` parts field —
// the real Phase-2/3 shape (instructions + goals). Used to exercise the goals
// handoff target.
const catalogPartsWithGoals: WorkflowCatalog = {
  triggers: catalog.triggers,
  actions: catalogParts.actions.map((a) =>
    a.type === 'agent'
      ? {
          ...a,
          config_fields: [
            ...a.config_fields,
            { name: 'goals', label: 'Goals', type: 'textarea', required: false, parts: true },
          ],
        }
      : a,
  ),
  scope_levels: [],
}

// The Phase-3 shape (ADR-0020, #527): the agent action carries an optional
// `delivery` config field, and the destination actions expose `output_body`
// (the message field, optional in a delivery) and `secret` (the webhook URL,
// round-tripped via the redaction sentinel). Slack + Email are enough to drive
// the delivery sub-form; the sub-form is built from *these* config_fields.
const SECRET_SENTINEL = '__biffo_secret_set__'
const catalogWithDelivery: WorkflowCatalog = {
  triggers: catalog.triggers,
  actions: [
    {
      type: 'email',
      label: 'Send email',
      config_fields: [
        { name: 'from', label: 'From', type: 'email', required: true },
        { name: 'to', label: 'To', type: 'email', required: true },
        { name: 'subject', label: 'Subject', type: 'text', required: true },
        { name: 'body', label: 'Body', type: 'textarea', required: true, output_body: true },
      ],
    },
    {
      type: 'slack',
      label: 'Slack message',
      config_fields: [
        { name: 'webhook_url', label: 'Webhook URL', type: 'url', required: true, secret: true },
        { name: 'message', label: 'Message', type: 'textarea', required: true, output_body: true },
      ],
    },
    ...catalog.actions
      .filter((a) => a.type === 'agent')
      .map((a) => ({
        ...a,
        config_fields: [
          ...a.config_fields,
          {
            name: 'delivery',
            label: 'Deliver the result on completion',
            type: 'delivery' as const,
            required: false,
          },
        ],
      })),
  ],
  scope_levels: [],
}

// An agent workflow whose delivery targets Slack, with the webhook stored as the
// redaction sentinel — exactly what a Core read returns (#432). Editing it must
// round-trip the sentinel so the stored secret is kept.
const agentWithDelivery: WorkflowDefinition = {
  id: 'wf-del',
  tenant_id: 'default',
  created_at: null,
  updated_at: null,
  name: 'Enrich and notify',
  trigger_source: 'biffo.core',
  trigger_detail_type: 'lead.captured',
  trigger_filter: null,
  action_type: 'agent',
  action_config: {
    agent_name: 'enricher',
    instructions: 'Enrich it.',
    model: 'moonshotai/kimi-k3',
    delivery: {
      type: 'slack',
      config: { webhook_url: SECRET_SENTINEL, message: 'Result: {output}' },
    },
  },
  enabled: false,
  schedule_config: null,
  scope: null,
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
  schedule_config: null,
  scope: null,
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
  schedule_config: null,
  scope: null,
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
  scheduled_for: null,
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
    sendAgentChat.mockReset()
    startWorkflowDryRun.mockReset()
    fetchAgentRun.mockReset()
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
        schedule_config: null,
        scope: null,
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

  it('never draws a fan-in structured field as a generic input', async () => {
    // A structured sub-config rendered as a text box does not merely look wrong:
    // typing in it stores a string where Core expects an object. The plain fields
    // must still render, so this is an exclusion and not a blanket suppression.
    fetchWorkflows.mockResolvedValue([])
    fetchCatalog.mockResolvedValue(catalogWithFanIn)

    render(<OrchestrationPage />)
    fireEvent.change(await screen.findByLabelText('Action'), {
      target: { value: 'agent_fan_in' },
    })

    expect(screen.getByLabelText('Agent name')).toBeInTheDocument()
    expect(
      screen.queryByLabelText('Structured result — the tool this agent must call to answer'),
    ).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Record the result')).not.toBeInTheDocument()
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

  // ── trigger-aware conditions (#505) ───────────────────────────────────────

  it('populates the field dropdown from the trigger fields', async () => {
    fetchWorkflows.mockResolvedValue([])
    fetchCatalog.mockResolvedValue(catalogWithFields)

    render(<OrchestrationPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add condition' }))

    const fieldSelect = screen.getByLabelText('Condition 1 field')
    expect(fieldSelect.tagName).toBe('SELECT')
    expect(Array.from(fieldSelect.querySelectorAll('option')).map((o) => o.textContent)).toEqual([
      'Status',
      'Score',
      'Custom field…',
    ])
  })

  it('shows a value dropdown for an enumerable field and submits the chosen value', async () => {
    fetchWorkflows.mockResolvedValue([])
    fetchCatalog.mockResolvedValue(catalogWithFields)
    createWorkflow.mockResolvedValue(notify)

    render(<OrchestrationPage />)
    fireEvent.change(await screen.findByPlaceholderText('Notify the sales team'), {
      target: { value: 'Won leads' },
    })
    fireEvent.change(screen.getByLabelText('From'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'c@d.com' } })
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Hi' } })
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Hello' } })

    // A new condition seeds to the trigger's first field (status, enum), so the
    // value control is a dropdown of that field's values.
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }))
    const valueSelect = screen.getByLabelText('Condition 1 value')
    expect(valueSelect.tagName).toBe('SELECT')
    expect(Array.from(valueSelect.querySelectorAll('option')).map((o) => o.value)).toEqual([
      '',
      'new',
      'won',
      'lost',
    ])
    fireEvent.change(valueSelect, { target: { value: 'won' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add workflow' }))

    await waitFor(() => {
      expect(createWorkflow).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ trigger_filter: { status: 'won' } }),
      )
    })
  })

  it('keeps a free-text value for a non-enumerable declared field', async () => {
    fetchWorkflows.mockResolvedValue([])
    fetchCatalog.mockResolvedValue(catalogWithFields)

    render(<OrchestrationPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add condition' }))
    // Switch the field to the numeric (non-enumerable) one.
    fireEvent.change(screen.getByLabelText('Condition 1 field'), { target: { value: 'score' } })
    // The value control falls back to a free-text input.
    expect(screen.getByLabelText('Condition 1 value').tagName).toBe('INPUT')
  })

  it('offers a custom-field escape hatch for an undeclared field', async () => {
    fetchWorkflows.mockResolvedValue([])
    fetchCatalog.mockResolvedValue(catalogWithFields)
    createWorkflow.mockResolvedValue(notify)

    render(<OrchestrationPage />)
    fireEvent.change(await screen.findByPlaceholderText('Notify the sales team'), {
      target: { value: 'Advanced' },
    })
    fireEvent.change(screen.getByLabelText('From'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'c@d.com' } })
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Hi' } })
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Hello' } })

    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }))
    fireEvent.change(screen.getByLabelText('Condition 1 field'), {
      target: { value: '__custom__' },
    })
    // The free-text field-name input appears; type an undeclared field.
    fireEvent.change(screen.getByLabelText('Condition 1 custom field'), {
      target: { value: 'region' },
    })
    fireEvent.change(screen.getByLabelText('Condition 1 value'), { target: { value: 'emea' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add workflow' }))

    await waitFor(() => {
      expect(createWorkflow).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ trigger_filter: { region: 'emea' } }),
      )
    })
  })

  it('falls back to a free-text field input when the trigger has no fields', async () => {
    // The default catalog's triggers declare no fields, so the condition editor
    // stays exactly as before — a plain text field + value (no regression).
    fetchWorkflows.mockResolvedValue([])

    render(<OrchestrationPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add condition' }))
    expect(screen.getByLabelText('Condition 1 field').tagName).toBe('INPUT')
    expect(screen.getByLabelText('Condition 1 value').tagName).toBe('INPUT')
  })

  it('loads an existing filter on an undeclared field via the custom escape hatch', async () => {
    // Editing a definition whose stored filter names a field the trigger does
    // not declare must round-trip: the field select shows "Custom field…" and
    // the free-text input is prefilled.
    fetchCatalog.mockResolvedValue(catalogWithFields)
    fetchWorkflows.mockResolvedValue([
      {
        ...notify,
        trigger_source: 'biffo.core',
        trigger_detail_type: 'lead.updated',
        trigger_filter: { region: 'emea' },
      },
    ])

    render(<OrchestrationPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))

    expect(screen.getByLabelText('Condition 1 field')).toHaveValue('__custom__')
    expect(screen.getByLabelText('Condition 1 custom field')).toHaveValue('region')
    expect(screen.getByLabelText('Condition 1 value')).toHaveValue('emea')
  })

  it('renders the run history with workflow name and outcome', async () => {
    fetchWorkflows.mockResolvedValue([notify])
    fetchRuns.mockResolvedValue([succeededRun])

    render(<OrchestrationPage />)

    // "Recent runs" is a STATIC header, rendered on mount before fetchRuns
    // resolves — so awaiting it does not guarantee the run row is in the DOM.
    // Wait for the run's own outcome, which only appears once the history loads,
    // rather than reading it synchronously (the #487 flake).
    expect(await screen.findByText('Recent runs')).toBeInTheDocument()
    expect(await screen.findByText('succeeded')).toBeInTheDocument()
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

  // ── payload-template recipient picker (#597 followup) ──────────────────────

  it('offers an insert-field picker on a payload_template recipient field when the trigger has fields', async () => {
    fetchWorkflows.mockResolvedValue([])
    fetchCatalog.mockResolvedValue(catalogWithPayloadTemplateTo)

    render(<OrchestrationPage />)
    await screen.findByLabelText('To')

    const picker = screen.getByLabelText('Insert a trigger field into To')
    expect(Array.from(picker.querySelectorAll('option')).map((o) => o.textContent)).toEqual([
      '+ Insert field from payload…',
      'Status (status)',
      'Score (score)',
    ])
  })

  it('appends the chosen field as a {field} template into the recipient input', async () => {
    fetchWorkflows.mockResolvedValue([])
    fetchCatalog.mockResolvedValue(catalogWithPayloadTemplateTo)

    render(<OrchestrationPage />)
    await screen.findByLabelText('To')

    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'fallback@example.com' } })
    fireEvent.change(screen.getByLabelText('Insert a trigger field into To'), {
      target: { value: 'status' },
    })

    expect(screen.getByLabelText('To')).toHaveValue('fallback@example.com{status}')
  })

  it('omits the insert-field picker when the trigger declares no fields', async () => {
    // The default catalog's triggers declare no fields, so even a
    // payload_template field falls back to a plain input — no dead-end picker.
    fetchWorkflows.mockResolvedValue([])
    fetchCatalog.mockResolvedValue({
      ...catalogWithPayloadTemplateTo,
      triggers: catalog.triggers,
    })

    render(<OrchestrationPage />)
    await screen.findByLabelText('To')

    expect(screen.queryByLabelText('Insert a trigger field into To')).not.toBeInTheDocument()
  })

  it('offers the insert-field picker on a payload_template textarea field too (#609)', async () => {
    // The picker isn't nested inside the textarea/select/input branches in
    // fieldControl() — it renders once per field regardless of which of
    // those the field takes, so a content field (Body, a textarea) gets it
    // the same as a recipient field (To, a plain input).
    fetchWorkflows.mockResolvedValue([])
    fetchCatalog.mockResolvedValue(catalogWithPayloadTemplateBody)

    render(<OrchestrationPage />)
    await screen.findByLabelText('Body')

    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Contact: ' } })
    fireEvent.change(screen.getByLabelText('Insert a trigger field into Body'), {
      target: { value: 'status' },
    })

    expect(screen.getByLabelText('Body')).toHaveValue('Contact: {status}')
  })

  it('omits the insert-field picker on a field that is not payload_template', async () => {
    // The default catalog's email `to` carries no `payload_template` flag —
    // no regression for actions that don't opt in.
    fetchWorkflows.mockResolvedValue([])
    fetchCatalog.mockResolvedValue(catalogWithFields)

    render(<OrchestrationPage />)
    await screen.findByLabelText('To')

    expect(screen.queryByLabelText('Insert a trigger field into To')).not.toBeInTheDocument()
  })

  // ── Timing: scheduled/delayed workflow actions (docs/implementation/0002-scheduled-workflow-actions) ──

  it('collapses the Timing section by default, with the delay controls hidden', async () => {
    fetchWorkflows.mockResolvedValue([])
    render(<OrchestrationPage />)

    expect(await screen.findByText('Timing (advanced, optional)')).toBeInTheDocument()
    expect(screen.queryByLabelText('Delay amount')).not.toBeInTheDocument()
  })

  it('reveals the delay controls once expanded and the checkbox is checked', async () => {
    fetchWorkflows.mockResolvedValue([])
    render(<OrchestrationPage />)

    fireEvent.click(await screen.findByText('Timing (advanced, optional)'))
    fireEvent.click(screen.getByLabelText('Run after a delay, instead of immediately'))

    expect(screen.getByLabelText('Delay amount')).toHaveValue(2)
    expect(screen.getByLabelText('Delay unit')).toHaveValue('weeks')
  })

  it('sends the delay converted to seconds when scheduling is enabled', async () => {
    fetchWorkflows.mockResolvedValue([])
    createWorkflow.mockResolvedValue(notify)

    render(<OrchestrationPage />)
    fireEvent.change(await screen.findByPlaceholderText('Notify the sales team'), {
      target: { value: 'Delayed ping' },
    })
    fireEvent.change(screen.getByLabelText('From'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'c@d.com' } })
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Hi' } })
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Hello there' } })

    fireEvent.click(screen.getByText('Timing (advanced, optional)'))
    fireEvent.click(screen.getByLabelText('Run after a delay, instead of immediately'))
    fireEvent.change(screen.getByLabelText('Delay amount'), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText('Delay unit'), { target: { value: 'days' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add workflow' }))

    await waitFor(() => {
      expect(createWorkflow).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          schedule_config: { type: 'fixed_delay', delay_seconds: 3 * 24 * 60 * 60 },
        }),
      )
    })
  })

  it('loads an existing schedule on edit, expanded with the value converted back', async () => {
    fetchCatalog.mockResolvedValue(catalog)
    fetchWorkflows.mockResolvedValue([
      { ...notify, schedule_config: { type: 'fixed_delay', delay_seconds: 1209600 } },
    ])

    render(<OrchestrationPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))

    expect(screen.getByLabelText('Run after a delay, instead of immediately')).toBeChecked()
    expect(screen.getByLabelText('Delay amount')).toHaveValue(2)
    expect(screen.getByLabelText('Delay unit')).toHaveValue('weeks')
  })

  it('flags a delayed workflow in the list', async () => {
    fetchWorkflows.mockResolvedValue([
      { ...notify, schedule_config: { type: 'fixed_delay', delay_seconds: 1209600 } },
    ])
    render(<OrchestrationPage />)

    expect(await screen.findByText('delayed')).toBeInTheDocument()
  })

  it('shows the scheduled run fire time in run history', async () => {
    fetchWorkflows.mockResolvedValue([notify])
    fetchRuns.mockResolvedValue([
      {
        ...succeededRun,
        status: 'scheduled',
        scheduled_for: '2026-08-09T12:00:00Z',
        logs: [],
      },
    ])

    render(<OrchestrationPage />)

    expect(await screen.findByText('scheduled')).toBeInTheDocument()
    expect(screen.getByText(/fires/)).toBeInTheDocument()
  })

  // ── Scope: hierarchy-scoped workflows (docs/implementation/0003-hierarchy-scoped-workflows) ──

  it('does not render the Scope section when the instance has registered no resolver', async () => {
    fetchCatalog.mockResolvedValue(catalog)
    fetchWorkflows.mockResolvedValue([])
    render(<OrchestrationPage />)

    await screen.findByText('Timing (advanced, optional)')
    expect(screen.queryByText('Scope (advanced, optional)')).not.toBeInTheDocument()
  })

  it('collapses the Scope section by default, with the level/id controls hidden', async () => {
    fetchCatalog.mockResolvedValue(catalogWithScopeLevels)
    fetchWorkflows.mockResolvedValue([])
    render(<OrchestrationPage />)

    expect(await screen.findByText('Scope (advanced, optional)')).toBeInTheDocument()
    expect(screen.queryByLabelText('Scope level')).not.toBeInTheDocument()
  })

  it('reveals the level/id controls once expanded and the checkbox is checked', async () => {
    fetchCatalog.mockResolvedValue(catalogWithScopeLevels)
    fetchWorkflows.mockResolvedValue([])
    render(<OrchestrationPage />)

    fireEvent.click(await screen.findByText('Scope (advanced, optional)'))
    fireEvent.click(screen.getByLabelText('Restrict this rule to one part of the hierarchy'))

    const level = screen.getByLabelText('Scope level')
    expect(level).toHaveValue('tenant')
    expect(Array.from(level.querySelectorAll('option')).map((o) => o.value)).toEqual([
      'tenant',
      'brand',
      'region',
      'unit',
    ])
    expect(screen.getByLabelText('Scope id')).toBeInTheDocument()
  })

  it('sends the chosen level+id when scope is enabled', async () => {
    fetchCatalog.mockResolvedValue(catalogWithScopeLevels)
    fetchWorkflows.mockResolvedValue([])
    createWorkflow.mockResolvedValue(notify)

    render(<OrchestrationPage />)
    fireEvent.change(await screen.findByPlaceholderText('Notify the sales team'), {
      target: { value: 'Scoped ping' },
    })
    fireEvent.change(screen.getByLabelText('From'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'c@d.com' } })
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Hi' } })
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Hello there' } })

    fireEvent.click(screen.getByText('Scope (advanced, optional)'))
    fireEvent.click(screen.getByLabelText('Restrict this rule to one part of the hierarchy'))
    fireEvent.change(screen.getByLabelText('Scope level'), { target: { value: 'brand' } })
    fireEvent.change(screen.getByLabelText('Scope id'), { target: { value: 'brand-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add workflow' }))

    await waitFor(() => {
      expect(createWorkflow).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          scope: { level: 'brand', id: 'brand-1' },
        }),
      )
    })
  })

  it('omits scope when the checkbox is left unchecked, even with catalog levels available', async () => {
    fetchCatalog.mockResolvedValue(catalogWithScopeLevels)
    fetchWorkflows.mockResolvedValue([])
    createWorkflow.mockResolvedValue(notify)

    render(<OrchestrationPage />)
    fireEvent.change(await screen.findByPlaceholderText('Notify the sales team'), {
      target: { value: 'Unscoped ping' },
    })
    fireEvent.change(screen.getByLabelText('From'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'c@d.com' } })
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Hi' } })
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Hello there' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add workflow' }))

    await waitFor(() => {
      expect(createWorkflow).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ scope: null }),
      )
    })
  })

  it('loads an existing scope on edit, expanded with the level/id populated', async () => {
    fetchCatalog.mockResolvedValue(catalogWithScopeLevels)
    fetchWorkflows.mockResolvedValue([{ ...notify, scope: { level: 'brand', id: 'brand-9' } }])

    render(<OrchestrationPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))

    expect(screen.getByLabelText('Restrict this rule to one part of the hierarchy')).toBeChecked()
    expect(screen.getByLabelText('Scope level')).toHaveValue('brand')
    expect(screen.getByLabelText('Scope id')).toHaveValue('brand-9')
  })

  // ── agent action: tools multiselect + curated model dropdown (ADR-0014) ─────

  it('offers a capabilities multiselect from available_tools and writes a list', async () => {
    fetchWorkflows.mockResolvedValue([])
    createWorkflow.mockResolvedValue(notify)

    render(<OrchestrationPage />)
    fireEvent.change(await screen.findByPlaceholderText('Notify the sales team'), {
      target: { value: 'Enrich' },
    })
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'agent' } })
    // Agent name lives in the Outcome section (visible without expanding).
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'enricher' } })

    // Capabilities and the raw prompt live under Advanced settings.
    fireEvent.click(screen.getByRole('button', { name: 'Advanced settings' }))

    // Options mirror the runtime's declared tools, with descriptions as help text.
    expect(screen.getByRole('checkbox', { name: /web_search/ })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /fetch_url/ })).toBeInTheDocument()
    expect(
      screen.getByText('Search the public web and return the top results.'),
    ).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'Enrich it' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /web_search/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))

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
    // No capabilities picker at all, even under Advanced.
    fireEvent.click(screen.getByRole('button', { name: 'Advanced settings' }))
    expect(screen.queryByText('Capabilities')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /web_search/ })).not.toBeInTheDocument()
  })

  it('offers the curated model options in a dropdown', async () => {
    fetchWorkflows.mockResolvedValue([])

    render(<OrchestrationPage />)
    fireEvent.change(await screen.findByLabelText('Action'), { target: { value: 'agent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Advanced settings' }))

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
    fireEvent.click(screen.getByRole('button', { name: 'Advanced settings' }))

    // The stored model — not among the curated options — is shown and selected,
    // so loading the agent does not silently reassign it to the first option.
    const model = screen.getByLabelText('Model')
    expect(model).toHaveValue('some-vendor/experimental-v9')
    const values = Array.from(model.querySelectorAll('option')).map((o) => o.value)
    expect(values).toContain('some-vendor/experimental-v9')

    // Save without touching the field: the off-list model round-trips unchanged.
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))

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
    fireEvent.click(screen.getByRole('button', { name: 'Advanced settings' }))

    // No warning yet: default model is not web-connected and no tool is picked.
    expect(screen.queryByText(REDUNDANT_WARNING)).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'moonshotai/kimi-k3:online' },
    })
    fireEvent.click(screen.getByRole('checkbox', { name: /web_search/ }))

    // Both conditions now hold — the hint appears, and the Save button stays
    // enabled (guidance, not a save-blocking gate).
    expect(screen.getByText(REDUNDANT_WARNING)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save draft' })).not.toBeDisabled()
  })

  it('does not warn for a :online model when no web_search tool is selected', async () => {
    fetchWorkflows.mockResolvedValue([])

    render(<OrchestrationPage />)
    fireEvent.change(await screen.findByLabelText('Action'), { target: { value: 'agent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Advanced settings' }))
    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'moonshotai/kimi-k3:online' },
    })

    expect(screen.queryByText(REDUNDANT_WARNING)).not.toBeInTheDocument()
  })

  it('does not warn for web_search with a non-online model', async () => {
    fetchWorkflows.mockResolvedValue([])

    render(<OrchestrationPage />)
    fireEvent.change(await screen.findByLabelText('Action'), { target: { value: 'agent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Advanced settings' }))
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

    // The raw prompt (parts editor) lives under Advanced settings.
    fireEvent.click(screen.getByRole('button', { name: 'Advanced settings' }))

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

    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))

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
    fireEvent.click(screen.getByRole('button', { name: 'Advanced settings' }))

    // The pre-library string renders as one inline part carrying its text.
    expect(screen.getByLabelText('Instructions part 1 text')).toHaveValue('Enrich {company}.')
  })

  // ── In-context "✨ Draft with AI" drawer → in-place fill (ADR-0016) ─────────

  it('inserts an accepted AI draft as a new inline instructions part', async () => {
    fetchCatalog.mockResolvedValue(catalogParts)
    fetchPromptComponents.mockResolvedValue([])
    fetchWorkflows.mockResolvedValue([])
    sendAgentChat.mockResolvedValue({
      thread_id: 'th-1',
      run_id: 'r1',
      reply: 'Triage inbound leads by intent.',
    })

    render(<OrchestrationPage />)
    fireEvent.change(await screen.findByLabelText('Action'), { target: { value: 'agent' } })
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'triage' } })

    // The raw prompt (and its AI-draft button) live under Advanced settings.
    fireEvent.click(screen.getByRole('button', { name: 'Advanced settings' }))
    // The manual parts editor is present; the AI button is additive.
    fireEvent.click(screen.getByRole('button', { name: '✨ Draft Instructions with AI' }))
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'help me' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Use this draft' }))

    // The reply lands in-place as the first inline part — no navigation, no
    // sessionStorage handoff.
    expect(await screen.findByLabelText('Instructions part 1 text')).toHaveValue(
      'Triage inbound leads by intent.',
    )
    // The drawer closed on accept.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // The drawer seeded the agent context onto the first (and only) turn.
    const firstCall = sendAgentChat.mock.calls[0]?.[1] as { message: string }
    expect(firstCall.message).toContain('instructions for agent “triage”')
  })

  it('drafts into the goals parts field with the goals context', async () => {
    fetchCatalog.mockResolvedValue(catalogPartsWithGoals)
    fetchPromptComponents.mockResolvedValue([])
    fetchWorkflows.mockResolvedValue([])
    sendAgentChat.mockResolvedValue({
      thread_id: 'th-1',
      run_id: 'r1',
      reply: 'Maximise qualified pipeline.',
    })

    render(<OrchestrationPage />)
    fireEvent.change(await screen.findByLabelText('Action'), { target: { value: 'agent' } })
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'pipeline' } })

    // Goals is relabelled "Result" in the Outcome section (task-oriented).
    fireEvent.click(screen.getByRole('button', { name: '✨ Draft Result with AI' }))
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'help me' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Use this draft' }))

    expect(await screen.findByLabelText('Result part 1 text')).toHaveValue(
      'Maximise qualified pipeline.',
    )
    // The drawer still seeds the *goals* context regardless of the display label.
    const firstCall = sendAgentChat.mock.calls[0]?.[1] as { message: string }
    expect(firstCall.message).toContain('goals for agent “pipeline”')
  })

  // ── Outcome journey: sections, presets, Advanced disclosure (Phase 1) ──────

  it('renders the outcome-oriented sections for the agent action', async () => {
    fetchCatalog.mockResolvedValue(catalogWithDelivery)
    fetchWorkflows.mockResolvedValue([])

    render(<OrchestrationPage />)
    fireEvent.change(await screen.findByLabelText('Action'), { target: { value: 'agent' } })

    expect(screen.getByText('When this happens (trigger)')).toBeInTheDocument()
    expect(screen.getByText('Conditions (optional)')).toBeInTheDocument()
    expect(screen.getByText('What should the agent do?')).toBeInTheDocument()
    // Delivery is real now (ADR-0020) — a task-shaped destination question, not a
    // Phase-3 placeholder. It starts on None, so no destination fields show yet.
    expect(screen.getByRole('heading', { name: 'Where should the result go?' })).toBeInTheDocument()
    expect(screen.getByLabelText<HTMLSelectElement>('Destination').value).toBe('')
    expect(screen.queryByLabelText('Webhook URL')).not.toBeInTheDocument()
    expect(screen.getByText('Test & review')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Advanced settings' })).toBeInTheDocument()
  })

  it('hides model, capabilities and the raw prompt until Advanced is expanded', async () => {
    fetchWorkflows.mockResolvedValue([])

    render(<OrchestrationPage />)
    fireEvent.change(await screen.findByLabelText('Action'), { target: { value: 'agent' } })

    // Collapsed by default.
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument()
    expect(screen.queryByText('Capabilities')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Maximum turns')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Advanced settings' }))

    expect(screen.getByLabelText('Model')).toBeInTheDocument()
    expect(screen.getByText('Capabilities')).toBeInTheDocument()
    expect(screen.getByLabelText('Maximum turns')).toBeInTheDocument()
  })

  it('fills instructions and the result from a guided preset', async () => {
    fetchCatalog.mockResolvedValue(catalogPartsWithGoals)
    fetchWorkflows.mockResolvedValue([])

    render(<OrchestrationPage />)
    fireEvent.change(await screen.findByLabelText('Action'), { target: { value: 'agent' } })

    // Presets are outcome-shaped cards, not blank boxes.
    fireEvent.click(screen.getByRole('button', { name: /Research a prospect/ }))

    // The result (goals) field, in the Outcome section, is now seeded.
    expect(screen.getByLabelText<HTMLTextAreaElement>('Result part 1 text').value).toMatch(
      /prospect brief/i,
    )

    // …and the raw instructions under Advanced were seeded too.
    fireEvent.click(screen.getByRole('button', { name: 'Advanced settings' }))
    expect(screen.getByLabelText<HTMLTextAreaElement>('Instructions part 1 text').value).toMatch(
      /research inbound prospects/i,
    )
  })

  it('seeds the sample input data from the trigger fields (#505)', async () => {
    fetchCatalog.mockResolvedValue(catalogWithFields)
    fetchWorkflows.mockResolvedValue([])

    render(<OrchestrationPage />)
    // First trigger (lead.updated) declares status(enum)+score(number).
    fireEvent.change(await screen.findByLabelText('Action'), { target: { value: 'agent' } })

    const sample = screen.getByLabelText<HTMLTextAreaElement>('Sample input data')
    const parsed = JSON.parse(sample.value) as Record<string, unknown>
    expect(parsed).toEqual({ status: 'new', score: 42 })
  })

  // ── Test & review: dry-run preview + the enable gate (Phase 2) ─────────────

  const fillTestableAgent = async () => {
    fireEvent.change(await screen.findByPlaceholderText('Notify the sales team'), {
      target: { value: 'Enrich lead' },
    })
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'agent' } })
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'enricher' } })
    fireEvent.click(screen.getByRole('button', { name: 'Advanced settings' }))
    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'Enrich it.' } })
  }

  it('keeps Test clickable when required fields are missing and says what to add', async () => {
    fetchWorkflows.mockResolvedValue([])

    render(<OrchestrationPage />)
    // Pick the agent action but leave name/agent/instructions blank.
    fireEvent.change(await screen.findByLabelText('Action'), { target: { value: 'agent' } })

    // The button is not disabled — a dead button leaves the author guessing.
    const testBtn = screen.getAllByRole('button', { name: 'Test workflow' })[0] as HTMLElement
    expect(testBtn).not.toBeDisabled()

    fireEvent.click(testBtn)

    // It names exactly what is missing and never hits the API.
    expect(
      await screen.findByText(
        /Add a workflow name, an agent name and instructions to run the test/,
      ),
    ).toBeInTheDocument()
    expect(startWorkflowDryRun).not.toHaveBeenCalled()
  })

  it('runs the dry-run and previews the returned output', async () => {
    fetchWorkflows.mockResolvedValue([])
    mockDryRun(
      completedRun({
        messages: [{ role: 'assistant', content: 'Acme is a mid-market SaaS company.' }],
        definition_snapshot: { model: 'moonshotai/kimi-k3' },
        cost_usd: 0.0021,
      }),
    )

    render(<OrchestrationPage />)
    await fillTestableAgent()

    // "Test workflow" is persistent (panel + sticky action bar) — either runs it.
    fireEvent.click(screen.getAllByRole('button', { name: 'Test workflow' })[0] as HTMLElement)

    expect(await screen.findByText('Acme is a mid-market SaaS company.')).toBeInTheDocument()
    expect(screen.getByText('test passed')).toBeInTheDocument()
    // The request carried the inline instructions and the agent name.
    const body = startWorkflowDryRun.mock.calls.at(0)?.[1] as {
      agent_name: string
      instructions: unknown
    }
    expect(body.agent_name).toBe('enricher')
    expect(body.instructions).toBe('Enrich it.')
  })

  it('disables Enable until a test passes, and re-disables it after an edit', async () => {
    fetchWorkflows.mockResolvedValue([])
    mockDryRun()

    render(<OrchestrationPage />)
    await fillTestableAgent()

    // Required fields are valid but no test has run — Enable is gated.
    expect(screen.getByRole('button', { name: 'Enable workflow' })).toBeDisabled()

    // "Test workflow" is persistent (panel + sticky action bar) — either runs it.
    fireEvent.click(screen.getAllByRole('button', { name: 'Test workflow' })[0] as HTMLElement)
    await screen.findByText('test passed')
    expect(screen.getByRole('button', { name: 'Enable workflow' })).not.toBeDisabled()

    // Editing the config invalidates the passing test — Enable re-locks.
    fireEvent.change(screen.getByLabelText('Instructions'), {
      target: { value: 'Enrich it thoroughly.' },
    })
    expect(screen.queryByText('test passed')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Enable workflow' })).toBeDisabled()
  })

  it('enables the workflow (enabled=true) once a test has passed', async () => {
    fetchWorkflows.mockResolvedValue([])
    mockDryRun()
    createWorkflow.mockResolvedValue(notify)

    render(<OrchestrationPage />)
    await fillTestableAgent()
    // "Test workflow" is persistent (panel + sticky action bar) — either runs it.
    fireEvent.click(screen.getAllByRole('button', { name: 'Test workflow' })[0] as HTMLElement)
    await screen.findByText('test passed')
    fireEvent.click(screen.getByRole('button', { name: 'Enable workflow' }))

    await waitFor(() => {
      expect(createWorkflow).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action_type: 'agent', enabled: true }),
      )
    })
  })

  it('saves a draft with enabled=false without a test', async () => {
    fetchWorkflows.mockResolvedValue([])
    createWorkflow.mockResolvedValue(notify)

    render(<OrchestrationPage />)
    await fillTestableAgent()
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))

    await waitFor(() => {
      expect(createWorkflow).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action_type: 'agent', enabled: false }),
      )
    })
  })

  it('reports a run that came back failed, and keeps Enable gated', async () => {
    fetchWorkflows.mockResolvedValue([])
    // The run terminated honestly rather than the request failing — the shape a
    // runtime error takes now that nothing is invoked inside the request (#726).
    mockDryRun(completedRun({ status: 'failed', error: 'The agent could not complete this turn.' }))

    render(<OrchestrationPage />)
    await fillTestableAgent()
    fireEvent.click(screen.getAllByRole('button', { name: 'Test workflow' })[0] as HTMLElement)

    expect(await screen.findByText(/could not complete this turn/)).toBeInTheDocument()
    expect(screen.queryByText('test passed')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Enable workflow' })).toBeDisabled()
  })

  it('shows a retryable error when the draft is refused, and never polls', async () => {
    fetchWorkflows.mockResolvedValue([])
    startWorkflowDryRun.mockRejectedValue(
      new ApiError(422, JSON.stringify({ detail: 'Prompt component “tone” does not exist.' })),
    )

    render(<OrchestrationPage />)
    await fillTestableAgent()
    fireEvent.click(screen.getAllByRole('button', { name: 'Test workflow' })[0] as HTMLElement)

    expect(await screen.findByText(/does not exist/)).toBeInTheDocument()
    expect(screen.queryByText('test passed')).not.toBeInTheDocument()
    // No run was queued, so there is nothing to poll — polling anyway would 404
    // in a loop against a run id that never existed.
    expect(fetchAgentRun).not.toHaveBeenCalled()
  })

  it('shows the run it is waiting on while the agent is still working', async () => {
    fetchWorkflows.mockResolvedValue([])
    startWorkflowDryRun.mockResolvedValue({ run_id: 'run-preview-1', status: 'pending' })
    // Never terminal: the agent is still going. This is the state a research
    // agent sits in for minutes, and the one a synchronous dry-run could not
    // represent at all — it simply timed out.
    fetchAgentRun.mockResolvedValue(completedRun({ status: 'running' }))

    render(<OrchestrationPage />)
    await fillTestableAgent()
    fireEvent.click(screen.getAllByRole('button', { name: 'Test workflow' })[0] as HTMLElement)

    expect(await screen.findByText(/Running the agent/)).toBeInTheDocument()
    // The id is offered so a long run is followable in Agent Runs rather than
    // being an indefinite spinner.
    expect(await screen.findByText('run-preview-1')).toBeInTheDocument()
    expect(screen.queryByText('test passed')).not.toBeInTheDocument()
  })

  // ── Delivery: destination sub-form, output_body, secrets, gating (Phase 3) ──

  it('renders a chosen destination’s fields from the catalog and stores delivery', async () => {
    fetchCatalog.mockResolvedValue(catalogWithDelivery)
    fetchWorkflows.mockResolvedValue([])
    mockDryRun()
    createWorkflow.mockResolvedValue(agentWithDelivery)

    render(<OrchestrationPage />)
    await fillTestableAgent()

    // Choosing Slack renders ITS config_fields — the standalone action's own,
    // reused, not a second copy.
    fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'slack' } })
    expect(screen.getByLabelText('Webhook URL')).toBeInTheDocument()
    // The output_body field is presented as optional.
    expect(screen.getByLabelText('Message (optional)')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Webhook URL'), {
      target: { value: 'https://hooks.slack.com/services/abc' },
    })

    // Test, then enable — delivery is stored under action_config.delivery.
    fireEvent.click(screen.getAllByRole('button', { name: 'Test workflow' })[0] as HTMLElement)
    await screen.findByText('test passed')
    fireEvent.click(screen.getByRole('button', { name: 'Enable workflow' }))

    await waitFor(() => {
      expect(createWorkflow).toHaveBeenCalled()
    })
    const body = createWorkflow.mock.calls.at(-1)?.[1] as WorkflowInput
    expect(body.enabled).toBe(true)
    expect(body.action_config.delivery).toEqual({
      type: 'slack',
      config: { webhook_url: 'https://hooks.slack.com/services/abc' },
    })
  })

  it('clears the delivery sub-config when None is chosen', async () => {
    fetchCatalog.mockResolvedValue(catalogWithDelivery)
    fetchWorkflows.mockResolvedValue([])
    mockDryRun()
    createWorkflow.mockResolvedValue(agentWithDelivery)

    render(<OrchestrationPage />)
    await fillTestableAgent()

    fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'slack' } })
    expect(screen.getByLabelText('Webhook URL')).toBeInTheDocument()

    // Back to None — the destination fields disappear and nothing is stored.
    fireEvent.change(screen.getByLabelText('Destination'), { target: { value: '' } })
    expect(screen.queryByLabelText('Webhook URL')).not.toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: 'Test workflow' })[0] as HTMLElement)
    await screen.findByText('test passed')
    fireEvent.click(screen.getByRole('button', { name: 'Enable workflow' }))

    await waitFor(() => {
      expect(createWorkflow).toHaveBeenCalled()
    })
    const body = createWorkflow.mock.calls.at(-1)?.[1] as WorkflowInput
    expect(body.action_config).not.toHaveProperty('delivery')
  })

  it('treats the delivery message as optional but enforces other required fields', async () => {
    fetchCatalog.mockResolvedValue(catalogWithDelivery)
    fetchWorkflows.mockResolvedValue([])
    mockDryRun()

    render(<OrchestrationPage />)
    await fillTestableAgent()
    fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'slack' } })

    // The dry-run does not perform delivery, so the test passes even with the
    // required webhook empty — but Enable stays gated on the half-filled delivery.
    fireEvent.click(screen.getAllByRole('button', { name: 'Test workflow' })[0] as HTMLElement)
    await screen.findByText('test passed')
    expect(screen.getByRole('button', { name: 'Enable workflow' })).toBeDisabled()

    // Fill the required webhook (message left blank — optional in a delivery) and
    // re-test: Enable now unlocks.
    fireEvent.change(screen.getByLabelText('Webhook URL'), {
      target: { value: 'https://hooks.slack.com/services/xyz' },
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Test workflow' })[0] as HTMLElement)
    await screen.findByText('test passed')
    expect(screen.getByRole('button', { name: 'Enable workflow' })).not.toBeDisabled()
  })

  it('re-arms the Enable test-gate when the delivery config is edited', async () => {
    fetchCatalog.mockResolvedValue(catalogWithDelivery)
    fetchWorkflows.mockResolvedValue([])
    mockDryRun()

    render(<OrchestrationPage />)
    await fillTestableAgent()
    fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'slack' } })
    fireEvent.change(screen.getByLabelText('Webhook URL'), {
      target: { value: 'https://hooks.slack.com/services/xyz' },
    })

    fireEvent.click(screen.getAllByRole('button', { name: 'Test workflow' })[0] as HTMLElement)
    await screen.findByText('test passed')
    expect(screen.getByRole('button', { name: 'Enable workflow' })).not.toBeDisabled()

    // Editing the delivery (its message) invalidates the passing test — since
    // delivery lives in action_config, the snapshot changes and Enable re-locks.
    fireEvent.change(screen.getByLabelText('Message (optional)'), {
      target: { value: 'Done: {output}' },
    })
    expect(screen.queryByText('test passed')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Enable workflow' })).toBeDisabled()
  })

  it('round-trips a delivery secret via the redaction sentinel', async () => {
    fetchCatalog.mockResolvedValue(catalogWithDelivery)
    fetchWorkflows.mockResolvedValue([agentWithDelivery])
    updateWorkflow.mockResolvedValue(agentWithDelivery)

    render(<OrchestrationPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))

    // The stored delivery is prefilled; the secret shows the sentinel, never a
    // cleared field — identical to how the standalone action treats a secret.
    expect(screen.getByLabelText<HTMLSelectElement>('Destination').value).toBe('slack')
    expect(screen.getByLabelText<HTMLInputElement>('Webhook URL').value).toBe(SECRET_SENTINEL)

    // Saving without touching the secret submits the sentinel back, so Core keeps
    // the stored webhook rather than overwriting it.
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => {
      expect(updateWorkflow).toHaveBeenCalled()
    })
    const [, id, body] = updateWorkflow.mock.calls.at(-1) as [unknown, string, WorkflowInput]
    expect(id).toBe('wf-del')
    // The sentinel round-trips unchanged — Core keeps the stored webhook.
    expect(body.action_config.delivery).toMatchObject({
      type: 'slack',
      config: { webhook_url: SECRET_SENTINEL },
    })
  })

  // ── Record the result (ADR-0027) ───────────────────────────────────────────
  //
  // The one field in this builder that writes to the database, so the tests are
  // about what an author can and cannot express — not about the controls.

  describe('write-back', () => {
    async function openAgentWithWriteBack() {
      fetchCatalog.mockResolvedValue(catalogWithWriteBack)
      fetchWorkflows.mockResolvedValue([])
      createWorkflow.mockResolvedValue(notify)
      render(<OrchestrationPage />)
      fireEvent.change(await screen.findByPlaceholderText('Notify the sales team'), {
        target: { value: 'Enrich the lead' },
      })
      fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'agent' } })
    }

    it('offers only the targets Core said this caller may write', async () => {
      await openAgentWithWriteBack()
      const picker = screen.getByLabelText('Record into')
      expect(picker).toBeInTheDocument()
      expect(screen.getByRole('option', { name: 'Lead' })).toBeInTheDocument()
      // Opting out is the default and stays available.
      expect(screen.getByRole('option', { name: 'Don’t record' })).toBeInTheDocument()
    })

    it('omits the section entirely when the caller may write nowhere', async () => {
      fetchCatalog.mockResolvedValue({ ...catalogWithWriteBack, writeback_targets: [] })
      fetchWorkflows.mockResolvedValue([])
      render(<OrchestrationPage />)
      fireEvent.change(await screen.findByPlaceholderText('Notify the sales team'), {
        target: { value: 'x' },
      })
      fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'agent' } })
      expect(screen.queryByLabelText('Record into')).not.toBeInTheDocument()
    })

    it('sends only the columns the author chose', async () => {
      await openAgentWithWriteBack()
      fireEvent.change(screen.getByLabelText('Record into'), { target: { value: 'leads' } })
      fireEvent.click(screen.getByLabelText(/^Notes/))
      fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'qualifier' } })
      // The target derives a column from the brand, so it needs a scope.
      fireEvent.click(screen.getByText('Scope (advanced, optional)'))
      fireEvent.click(screen.getByLabelText('Restrict this rule to one part of the hierarchy'))
      fireEvent.change(screen.getByLabelText('Scope level'), { target: { value: 'brand' } })
      fireEvent.change(screen.getByLabelText('Scope id'), { target: { value: 'b1' } })
      // The agent action uses the outcome-oriented flow (#527), whose primary
      // action is "Save draft" rather than "Add workflow".
      fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))

      await waitFor(() => {
        expect(createWorkflow).toHaveBeenCalled()
      })
      const body = createWorkflow.mock.calls[0]?.[1] as { action_config: Record<string, unknown> }
      // `phone` was never ticked, so it must not arrive as an empty mapping —
      // Core reads that as "fill this with nothing".
      expect(body.action_config.writeback).toEqual({
        table: 'leads',
        operation: 'update',
        columns: { notes: '{output.notes}' },
      })
    })

    it('sends no write-back at all when nothing is ticked', async () => {
      await openAgentWithWriteBack()
      fireEvent.change(screen.getByLabelText('Record into'), { target: { value: 'leads' } })
      fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'qualifier' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))

      await waitFor(() => {
        expect(createWorkflow).toHaveBeenCalled()
      })
      const body = createWorkflow.mock.calls[0]?.[1] as { action_config: Record<string, unknown> }
      expect(body.action_config).not.toHaveProperty('writeback')
    })

    it('says in words what it will do, including how each column is written', async () => {
      await openAgentWithWriteBack()
      fireEvent.change(screen.getByLabelText('Record into'), { target: { value: 'leads' } })
      fireEvent.click(screen.getByLabelText(/^Notes/))

      // #527 asks for a plain-language plan; it matters most on the field that
      // writes to the database.
      expect(screen.getByText(/Updates the Lead this event is about/)).toBeInTheDocument()
      expect(screen.getByText(/added beneath what is already there/)).toBeInTheDocument()
    })

    it('warns when the target needs a scope the workflow has not got', async () => {
      await openAgentWithWriteBack()
      fireEvent.change(screen.getByLabelText('Record into'), { target: { value: 'leads' } })
      expect(screen.getByText(/needs this workflow scoped to a brand/)).toBeInTheDocument()
    })

    it('never also draws the write-back as a generic text input', async () => {
      // The bug this exists for: a structured sub-config that has its own
      // section AND falls through to the generic field renderer appears twice.
      // Typing in the stray box puts a *string* where Core expects an object,
      // and the author has two controls for one setting.
      //
      // Found by clicking the deployed portal, not here — the original tests
      // queried by label and were satisfied by *a* match, so two matches read
      // as success. Hence getAllBy + a role assertion rather than getBy.
      await openAgentWithWriteBack()
      const textboxes = screen.queryAllByRole('textbox', { name: /Record the result/i })
      expect(textboxes).toHaveLength(0)
      // The real control is the target picker, and there is exactly one.
      expect(screen.getAllByLabelText('Record into')).toHaveLength(1)
    })

    it('tells the author the row comes from the event, not the agent', async () => {
      await openAgentWithWriteBack()
      fireEvent.change(screen.getByLabelText('Record into'), { target: { value: 'leads' } })
      expect(screen.getByText(/never from the agent/)).toBeInTheDocument()
    })
  })

  it('shows which user a write-capable workflow runs as', async () => {
    fetchWorkflows.mockResolvedValue([
      { ...notify, run_as_kind: 'user', run_as_user_id: 'c37c0fa7-8f9b-47ff-93b5-bd02be78aebb' },
    ])
    render(<OrchestrationPage />)
    // ADR-0027 §2: the stored principal belongs next to the rule — a reader
    // needs to know whose permissions it acts with.
    expect(await screen.findByText(/runs as c37c0fa7/)).toBeInTheDocument()
  })
})
