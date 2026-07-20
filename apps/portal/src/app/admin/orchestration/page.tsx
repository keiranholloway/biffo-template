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
  type CatalogActionField,
  type WorkflowCatalog,
  type WorkflowDefinition,
  type CatalogTrigger,
  type WorkflowInput,
} from '@/lib/orchestration-api'
import {
  filterTriggers,
  groupTriggersBySource,
  optionLabel,
  originOf,
  triggerKeyOf,
} from '@/lib/trigger-catalog'

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

// A field's effective value: what's configured, else the catalog default.
function effectiveValue(
  fields: CatalogActionField[],
  config: Record<string, string>,
  name: string,
): string {
  const value = config[name]
  if (value != null && value !== '') return value
  return fields.find((f) => f.name === name)?.default ?? ''
}

// Conditional fields (e.g. WhatsApp's template config) only render when the
// field they depend on holds the matching value.
function fieldApplies(
  fields: CatalogActionField[],
  config: Record<string, string>,
  field: CatalogActionField,
): boolean {
  const condition = field.visible_when
  if (condition == null) return true
  return effectiveValue(fields, config, condition.field) === condition.equals
}

// Seed a freshly-chosen action's config with its catalog defaults, so what the
// form shows is what gets saved.
function defaultConfig(action: CatalogAction | undefined): Record<string, string> {
  const config: Record<string, string> = {}
  for (const field of action?.config_fields ?? []) {
    if (field.default != null) config[field.name] = field.default
  }
  return config
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
  const [triggerQuery, setTriggerQuery] = useState('')
  const [actionType, setActionType] = useState('')
  const [config, setConfig] = useState<Record<string, string>>({})
  const [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState(false)

  const resetForm = useCallback((cat: WorkflowCatalog | null) => {
    setEditingId(null)
    setName('')
    const t = cat?.triggers[0]
    setTriggerKey(t ? triggerKeyOf(t) : '')
    setTriggerQuery('')
    setActionType(cat?.actions[0]?.type ?? '')
    setConfig(defaultConfig(cat?.actions[0]))
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

  const selectedTrigger: CatalogTrigger | undefined = catalog?.triggers.find(
    (t) => triggerKeyOf(t) === triggerKey,
  )

  // The filter narrows the dropdown but never drops the current selection —
  // otherwise the browser would silently reassign the select's value.
  const triggerGroups = useMemo(
    () => groupTriggersBySource(filterTriggers(catalog?.triggers ?? [], triggerQuery, triggerKey)),
    [catalog, triggerQuery, triggerKey],
  )

  const matchCount = useMemo(
    () => filterTriggers(catalog?.triggers ?? [], triggerQuery).length,
    [catalog, triggerQuery],
  )

  function loadForEdit(w: WorkflowDefinition) {
    setEditingId(w.id)
    setName(w.name)
    setTriggerKey(`${w.trigger_source}|${w.trigger_detail_type}`)
    setTriggerQuery('')
    setActionType(w.action_type)
    setConfig({ ...w.action_config })
    setEnabled(w.enabled)
  }

  async function submitForm() {
    if (busy) return
    const [trigger_source, trigger_detail_type] = triggerKey.split('|')
    // Save only the fields that apply, so switching e.g. WhatsApp text →
    // template doesn't leave the abandoned branch's values in action_config.
    const fields = selectedAction?.config_fields ?? []
    const applicable = Object.fromEntries(
      Object.entries(config).filter((entry) =>
        fields.some((f) => f.name === entry[0] && fieldApplies(fields, config, f)),
      ),
    )
    const body: WorkflowInput = {
      name: name.trim(),
      trigger_source: trigger_source ?? '',
      trigger_detail_type: trigger_detail_type ?? '',
      action_type: actionType,
      action_config: applicable,
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
      (t) => triggerKeyOf(t) === `${w.trigger_source}|${w.trigger_detail_type}`,
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
            <div className="flex flex-col text-xs text-gray-600">
              <label className="flex flex-col">
                Filter triggers
                <input
                  type="search"
                  aria-label="Filter triggers"
                  value={triggerQuery}
                  onChange={(e) => {
                    setTriggerQuery(e.target.value)
                  }}
                  placeholder="Search by name, source or event"
                  className={inputClass}
                />
              </label>
              <label className="mt-2 flex flex-col">
                When this happens (trigger)
                <select
                  aria-label="Trigger"
                  value={triggerKey}
                  onChange={(e) => {
                    setTriggerKey(e.target.value)
                  }}
                  className={inputClass}
                >
                  {triggerGroups.map((group) => (
                    <optgroup key={group.source} label={group.source}>
                      {group.triggers.map((t) => (
                        <option key={triggerKeyOf(t)} value={triggerKeyOf(t)} title={t.description}>
                          {optionLabel(t)}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              {triggerQuery.trim() !== '' && matchCount === 0 && (
                <p className="mt-1 text-xs text-gray-500">
                  No triggers match “{triggerQuery.trim()}”. Showing the current selection only.
                </p>
              )}
              {selectedTrigger != null && (
                <div className="mt-1.5 flex items-start gap-2">
                  {originOf(selectedTrigger) === 'declared' ? (
                    <span
                      title="Declared in the Core event registry."
                      className="shrink-0 rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-700"
                    >
                      declared
                    </span>
                  ) : (
                    <span
                      title="Not declared anywhere — seen on the event bus."
                      className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700"
                    >
                      observed
                    </span>
                  )}
                  <span className="text-xs text-gray-500">{selectedTrigger.description}</span>
                </div>
              )}
            </div>
            <label className="flex flex-col text-xs text-gray-600">
              Do this (action)
              <select
                aria-label="Action"
                value={actionType}
                onChange={(e) => {
                  setActionType(e.target.value)
                  setConfig(defaultConfig(catalog.actions.find((a) => a.type === e.target.value)))
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
              {selectedAction.config_fields
                .filter((field) => fieldApplies(selectedAction.config_fields, config, field))
                .map((field) => (
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
                    ) : field.type === 'select' ? (
                      <select
                        aria-label={field.label}
                        value={effectiveValue(selectedAction.config_fields, config, field.name)}
                        onChange={(e) => {
                          setConfig((c) => ({ ...c, [field.name]: e.target.value }))
                        }}
                        className={inputClass}
                      >
                        {(field.options ?? []).map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
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
