import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import OrchestrationPage from './page'
import type * as OrchestrationApiModule from '@/lib/orchestration-api'
import type { WorkflowCatalog, WorkflowDefinition } from '@/lib/orchestration-api'

vi.mock('@/context/auth-context', () => ({
  useAuth: () => ({ getIdToken: () => 'fake-token' }),
}))

vi.mock('@/lib/api-client', () => ({
  createApiClient: () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }),
}))

const {
  fetchWorkflows,
  fetchCatalog,
  createWorkflow,
  updateWorkflow,
  setWorkflowEnabled,
  deleteWorkflow,
} = vi.hoisted(() => ({
  fetchWorkflows: vi.fn(),
  fetchCatalog: vi.fn(),
  createWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
  setWorkflowEnabled: vi.fn(),
  deleteWorkflow: vi.fn(),
}))

vi.mock('@/lib/orchestration-api', async () => {
  const actual = await vi.importActual<typeof OrchestrationApiModule>('@/lib/orchestration-api')
  return {
    ...actual,
    fetchWorkflows,
    fetchCatalog,
    createWorkflow,
    updateWorkflow,
    setWorkflowEnabled,
    deleteWorkflow,
  }
})

const catalog: WorkflowCatalog = {
  triggers: [
    {
      source: 'biffo.core',
      detail_type: 'demo.requested',
      label: 'Demo requested',
      description: 'Someone submits the "Book a demo" form.',
    },
    {
      source: 'biffo.core',
      detail_type: 'lead.captured',
      label: 'Lead captured',
      description: 'A lead comes in from the website or marketplace.',
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
  ],
}

const notify: WorkflowDefinition = {
  id: 'wf1',
  tenant_id: 'default',
  created_at: null,
  updated_at: null,
  name: 'Notify sales',
  trigger_source: 'biffo.core',
  trigger_detail_type: 'demo.requested',
  action_type: 'email',
  action_config: {
    from: 'keiran@tabsii.com',
    to: 'keiran@tabsii.com',
    subject: 'New demo request',
    body: 'A demo came in.',
  },
  enabled: true,
}

describe('OrchestrationPage', () => {
  beforeEach(() => {
    for (const fn of [
      fetchWorkflows,
      fetchCatalog,
      createWorkflow,
      updateWorkflow,
      setWorkflowEnabled,
      deleteWorkflow,
    ]) {
      fn.mockReset()
    }
    fetchCatalog.mockResolvedValue(catalog)
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

  it('surfaces an error when the fetch fails', async () => {
    fetchWorkflows.mockRejectedValue(new Error('administrator access required'))
    render(<OrchestrationPage />)
    expect(await screen.findByText('administrator access required')).toBeInTheDocument()
  })
})
