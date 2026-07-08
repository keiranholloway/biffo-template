'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/context/auth-context'
import { createApiClient } from '@/lib/api-client'
import {
  createWorkflow,
  deleteWorkflow,
  fetchCatalog,
  fetchWorkflows,
  setWorkflowEnabled,
  updateWorkflow,
  type CatalogAction,
  type WorkflowCatalog,
  type WorkflowDefinition,
  type WorkflowInput,
} from '@/lib/orchestration-api'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error'
}

const inputClass = 'mt-1 rounded border px-2 py-1 text-sm'

// Config-field type -> HTML <input type>. Anything else falls back to text.
function inputType(fieldType: string): string {
  if (fieldType === 'email') return 'email'
  if (fieldType === 'url') return 'url'
  if (fieldType === 'tel') return 'tel'
  return 'text'
}

export default function OrchestrationPage() {
  const { getIdToken } = useAuth()
  const client = useMemo(() => createApiClient(getIdToken), [getIdToken])

  const [workflows, setWorkflows] = useState<WorkflowDefinition[] | null>(null)
  const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Form state (create by default; `editingId` non-null while editing a row).
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [triggerKey, setTriggerKey] = useState('')
  const [actionType, setActionType] = useState('')
  const [config, setConfig] = useState<Record<string, string>>({})
  const [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState(false)

  const resetForm = useCallback((cat: WorkflowCatalog | null) => {
    setEditingId(null)
    setName('')
    const t = cat?.triggers[0]
    setTriggerKey(t ? `${t.source}|${t.detail_type}` : '')
    setActionType(cat?.actions[0]?.type ?? '')
    setConfig({})
    setEnabled(true)
  }, [])

  useEffect(() => {
    fetchCatalog(client)
      .then((cat) => {
        setCatalog(cat)
        resetForm(cat)
      })
      .catch((err: unknown) => {
        setError(errorMessage(err))
      })
  }, [client, resetForm])

  const reload = useCallback(async () => {
    try {
      setWorkflows(await fetchWorkflows(client))
      setError(null)
    } catch (err: unknown) {
      setError(errorMessage(err))
    }
  }, [client])

  useEffect(() => {
    void reload()
  }, [reload])

  // Run a mutation, surface any error, and refresh from the server.
  async function run(action: () => Promise<unknown>) {
    try {
      await action()
      await reload()
    } catch (err: unknown) {
      setError(errorMessage(err))
    }
  }

  const selectedAction: CatalogAction | undefined = catalog?.actions.find(
    (a) => a.type === actionType,
  )

  function loadForEdit(w: WorkflowDefinition) {
    setEditingId(w.id)
    setName(w.name)
    setTriggerKey(`${w.trigger_source}|${w.trigger_detail_type}`)
    setActionType(w.action_type)
    setConfig({ ...w.action_config })
    setEnabled(w.enabled)
  }

  async function submitForm() {
    if (busy) return
    const [trigger_source, trigger_detail_type] = triggerKey.split('|')
    const body: WorkflowInput = {
      name: name.trim(),
      trigger_source: trigger_source ?? '',
      trigger_detail_type: trigger_detail_type ?? '',
      action_type: actionType,
      action_config: config,
      enabled,
    }
    setBusy(true)
    try {
      await run(async () => {
        if (editingId != null) {
          await updateWorkflow(client, editingId, body)
        } else {
          await createWorkflow(client, body)
        }
        resetForm(catalog)
      })
    } finally {
      setBusy(false)
    }
  }

  function triggerLabel(w: WorkflowDefinition): string {
    const match = catalog?.triggers.find(
      (t) => t.source === w.trigger_source && t.detail_type === w.trigger_detail_type,
    )
    return match?.label ?? `${w.trigger_source} / ${w.trigger_detail_type}`
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Workflows</h1>
      <p className="mt-1 text-sm text-gray-600">
        Automate follow-ups: when an event happens, run an action. Create a workflow below and it
        takes effect on the next matching event — no deploy needed.
      </p>

      {error != null && (
        <div className="mt-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {catalog != null && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void submitForm()
          }}
          className="mt-6 rounded-xl border bg-white p-4 shadow-sm"
        >
          <h2 className="text-sm font-semibold text-gray-900">
            {editingId != null ? 'Edit workflow' : 'New workflow'}
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col text-xs text-gray-600">
              Name
              <input
                required
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                }}
                placeholder="Notify the sales team"
                className={inputClass}
              />
            </label>
            <label className="flex flex-col text-xs text-gray-600">
              When this happens (trigger)
              <select
                aria-label="Trigger"
                value={triggerKey}
                onChange={(e) => {
                  setTriggerKey(e.target.value)
                }}
                className={inputClass}
              >
                {catalog.triggers.map((t) => (
                  <option
                    key={`${t.source}|${t.detail_type}`}
                    value={`${t.source}|${t.detail_type}`}
                  >
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col text-xs text-gray-600">
              Do this (action)
              <select
                aria-label="Action"
                value={actionType}
                onChange={(e) => {
                  setActionType(e.target.value)
                  setConfig({})
                }}
                className={inputClass}
              >
                {catalog.actions.map((a) => (
                  <option key={a.type} value={a.type}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 self-end text-sm text-gray-800">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => {
                  setEnabled(e.target.checked)
                }}
              />
              Enabled
            </label>
          </div>

          {selectedAction != null && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {selectedAction.config_fields.map((field) => (
                <label
                  key={field.name}
                  className={`flex flex-col text-xs text-gray-600 ${
                    field.type === 'textarea' ? 'sm:col-span-2' : ''
                  }`}
                >
                  {field.label}
                  {field.type === 'textarea' ? (
                    <textarea
                      value={config[field.name] ?? ''}
                      required={field.required}
                      onChange={(e) => {
                        setConfig((c) => ({ ...c, [field.name]: e.target.value }))
                      }}
                      rows={3}
                      className={inputClass}
                    />
                  ) : (
                    <input
                      type={inputType(field.type)}
                      value={config[field.name] ?? ''}
                      required={field.required}
                      onChange={(e) => {
                        setConfig((c) => ({ ...c, [field.name]: e.target.value }))
                      }}
                      className={inputClass}
                    />
                  )}
                </label>
              ))}
            </div>
          )}

          <div className="mt-4 flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Saving…' : editingId != null ? 'Save changes' : 'Add workflow'}
            </button>
            {editingId != null && (
              <button
                type="button"
                onClick={() => {
                  resetForm(catalog)
                }}
                className="rounded border px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      )}

      {workflows == null && error == null && (
        <div className="mt-6 space-y-2" aria-label="Loading workflows">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded bg-gray-100" />
          ))}
        </div>
      )}

      {workflows != null && workflows.length === 0 && (
        <div className="mt-8 rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center">
          <p className="text-sm font-medium text-gray-600">No workflows yet</p>
          <p className="mt-1 text-xs text-gray-400">Create one above to get started.</p>
        </div>
      )}

      {workflows != null && workflows.length > 0 && (
        <div className="mt-6 overflow-x-auto rounded-xl border bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Trigger</th>
                <th className="px-4 py-2">Action</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {workflows.map((w) => (
                <tr key={w.id}>
                  <td className="px-4 py-2 text-gray-800">{w.name}</td>
                  <td className="px-4 py-2 text-gray-600">{triggerLabel(w)}</td>
                  <td className="px-4 py-2 text-gray-600">{w.action_type}</td>
                  <td className="px-4 py-2">
                    {w.enabled ? (
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-700">
                        enabled
                      </span>
                    ) : (
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                        disabled
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          loadForEdit(w)
                        }}
                        className="rounded border px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void run(() => setWorkflowEnabled(client, w.id, !w.enabled))
                        }}
                        className="rounded border px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                      >
                        {w.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void run(() => deleteWorkflow(client, w.id))
                        }}
                        className="rounded border border-rose-200 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
