'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/context/auth-context'
import { createApiClient } from '@/lib/api-client'
import {
  createWorkflow,
  deleteWorkflow,
  fetchCatalog,
  fetchRuns,
  fetchWorkflows,
  setWorkflowEnabled,
  updateWorkflow,
  type CatalogAction,
  type CatalogActionField,
  type WorkflowCatalog,
  type WorkflowDefinition,
  type CatalogTrigger,
  type WorkflowInput,
  type WorkflowRun,
} from '@/lib/orchestration-api'
import {
  filterTriggers,
  groupTriggersBySource,
  optionLabel,
  originOf,
  triggerKeyOf,
} from '@/lib/trigger-catalog'
import { fetchPromptComponents, type PromptComponent } from '@/lib/prompt-components-api'
import { normalizeParts, type PromptPart } from '@/lib/prompt-parts'
import { PartsField } from './parts-field'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error'
}

const inputClass = 'mt-1 rounded border px-2 py-1 text-sm'

/** One row of the "only when" editor. Kept as a list, not an object, so a row
 *  being typed into can have an empty field name without collapsing. */
interface FilterRow {
  field: string
  value: string
}

/** Rows -> the API's trigger_filter. Rows with no field name are dropped; no
 *  usable rows at all means null (matches every event). */
function toTriggerFilter(rows: FilterRow[]): Record<string, string> | null {
  const entries = rows
    .map((r) => [r.field.trim(), r.value] as const)
    .filter(([field]) => field !== '')
  return entries.length > 0 ? Object.fromEntries(entries) : null
}

function toFilterRows(filter: Record<string, string> | null | undefined): FilterRow[] {
  return Object.entries(filter ?? {}).map(([field, value]) => ({ field, value }))
}

// Run status -> badge colour. Terminal failure reads red, success green, and
// anything still in flight stays neutral.
const runStatusClass: Record<string, string> = {
  succeeded: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-rose-100 text-rose-700',
  skipped: 'bg-amber-100 text-amber-700',
}

function formatWhen(iso: string | null): string {
  if (iso == null) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

/** The error from a run's last recorded action, if it failed. */
function runError(run: WorkflowRun): string | null {
  const last = run.logs.at(-1)
  return last?.error ?? null
}

// Config-field type -> HTML <input type>. Anything else falls back to text.
function inputType(fieldType: string): string {
  if (fieldType === 'email') return 'email'
  if (fieldType === 'url') return 'url'
  if (fieldType === 'tel') return 'tel'
  return 'text'
}

// action_config values are strings for scalar fields, string lists for a
// `multiselect`, and an ordered-parts list for a `parts: true` prompt field
// (ADR-0015). These coerce a value to the shape a given control expects,
// without asserting a type the data may not have.
type ConfigValue = string | string[] | PromptPart[]
type Config = Record<string, ConfigValue>

function asString(value: ConfigValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function asList(value: ConfigValue | undefined): string[] {
  // Only the string members of a list (the multiselect/tools case). A parts
  // list is never read through here — parts fields render via their own branch.
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

// A field's effective value: what's configured, else the catalog default. Only
// meaningful for scalar fields; a list value (multiselect) reads as unset here.
function effectiveValue(fields: CatalogActionField[], config: Config, name: string): string {
  const value = config[name]
  if (typeof value === 'string' && value !== '') return value
  return fields.find((f) => f.name === name)?.default ?? ''
}

// Conditional fields (e.g. WhatsApp's template config) only render when the
// field they depend on holds the matching value.
function fieldApplies(
  fields: CatalogActionField[],
  config: Config,
  field: CatalogActionField,
): boolean {
  const condition = field.visible_when
  if (condition == null) return true
  return effectiveValue(fields, config, condition.field) === condition.equals
}

// The synthetic config field name the tool picker writes into action_config.
// Deliberately NOT a Core config_field (Core keeps tools out of config_fields);
// the builder injects it from the action's `available_tools`.
const TOOLS_FIELD = 'tools'

// The web-search tool by name — the only runtime tool today, checked by name
// deliberately (not generalised to hypothetical future web tools).
const WEB_SEARCH_TOOL = 'web_search'

// A model whose string ends in `:online` (the OpenRouter convention) performs
// web search at the provider; the web_search tool performs it again in the
// runtime. Both on one worker double the web injection — worth flagging, but
// only informational, never a save-time block. Keyed off the `:online` suffix,
// not a model name, so it covers any future web-connected model.
function webSearchIsRedundant(config: Config): boolean {
  return (
    asString(config.model).endsWith(':online') && asList(config.tools).includes(WEB_SEARCH_TOOL)
  )
}

// The agent action's tool picker, built from the tools the runtime declared. A
// `multiselect` whose options come from `available_tools`, so it always mirrors
// what the runtime actually registered — never a hardcoded list. Absent/empty
// available_tools yields no field (the picker simply doesn't render).
function toolsField(action: CatalogAction | undefined): CatalogActionField | null {
  const tools = action?.available_tools ?? []
  if (tools.length === 0) return null
  return {
    name: TOOLS_FIELD,
    label: 'Tools',
    type: 'multiselect',
    required: false,
    options: tools.map((t) => ({ value: t.name, label: t.name, description: t.description })),
  }
}

// The config fields the builder actually renders for an action: its Core-declared
// fields, plus the injected tools multiselect when the action carries
// available_tools. Used everywhere the field list drives behaviour (render,
// applicability, and the save filter) so the tools value round-trips.
function configFieldsFor(action: CatalogAction | undefined): CatalogActionField[] {
  const base = action?.config_fields ?? []
  const tools = toolsField(action)
  return tools == null ? base : [...base, tools]
}

// A select's options, guaranteeing the current value is always among them. A
// stored value outside the curated list (e.g. an agent's model that predates the
// list) is prepended so it stays visible and selected — otherwise the browser
// would silently reassign the select to its first option on load.
function selectOptions(
  field: CatalogActionField,
  current: string,
): { value: string; label: string }[] {
  const options = field.options ?? []
  if (current !== '' && !options.some((o) => o.value === current)) {
    return [{ value: current, label: `${current} (current)` }, ...options]
  }
  return options
}

// Seed a freshly-chosen action's config with its catalog defaults, so what the
// form shows is what gets saved.
function defaultConfig(action: CatalogAction | undefined): Config {
  const config: Config = {}
  for (const field of action?.config_fields ?? []) {
    if (field.default != null) config[field.name] = field.default
  }
  return config
}

export default function OrchestrationPage() {
  const { getIdToken } = useAuth()
  const client = useMemo(() => createApiClient(getIdToken), [getIdToken])

  const [workflows, setWorkflows] = useState<WorkflowDefinition[] | null>(null)
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null)
  const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null)
  // Library components available to reference from a parts field (ADR-0015).
  // Sourced from the prompt-library CRUD API, NOT the action catalog. A fetch
  // failure leaves this [] so the parts editor still renders (unknown refs warn).
  const [components, setComponents] = useState<PromptComponent[]>([])
  const [error, setError] = useState<string | null>(null)

  // Form state (create by default; `editingId` non-null while editing a row).
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [triggerKey, setTriggerKey] = useState('')
  const [triggerQuery, setTriggerQuery] = useState('')
  const [actionType, setActionType] = useState('')
  const [config, setConfig] = useState<Config>({})
  const [filterRows, setFilterRows] = useState<FilterRow[]>([])
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
    setFilterRows([])
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
      const [definitions, history] = await Promise.all([fetchWorkflows(client), fetchRuns(client)])
      setWorkflows(definitions)
      setRuns(history)
      setError(null)
    } catch (err: unknown) {
      setError(errorMessage(err))
    }
  }, [client])

  useEffect(() => {
    void reload()
  }, [reload])

  // Load the referenceable prompt components once. A failure is non-fatal to
  // the builder — the parts editor renders with no options and warns on any
  // unknown reference — so it does not clobber the page-level error banner.
  useEffect(() => {
    fetchPromptComponents(client)
      .then(setComponents)
      .catch(() => {
        setComponents([])
      })
  }, [client])

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
    setFilterRows(toFilterRows(w.trigger_filter))
    setEnabled(w.enabled)
  }

  async function submitForm() {
    if (busy) return
    const [trigger_source, trigger_detail_type] = triggerKey.split('|')
    // Save only the fields that apply, so switching e.g. WhatsApp text →
    // template doesn't leave the abandoned branch's values in action_config.
    // configFieldsFor (not raw config_fields) so the injected tools multiselect
    // is recognised and its list value round-trips.
    const fields = configFieldsFor(selectedAction)
    const applicable = Object.fromEntries(
      Object.entries(config).filter((entry) =>
        fields.some((f) => f.name === entry[0] && fieldApplies(fields, config, f)),
      ),
    )
    const body: WorkflowInput = {
      name: name.trim(),
      trigger_source: trigger_source ?? '',
      trigger_detail_type: trigger_detail_type ?? '',
      trigger_filter: toTriggerFilter(filterRows),
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

          <fieldset className="mt-4 rounded-lg border border-gray-200 p-3">
            <legend className="px-1 text-xs font-semibold text-gray-700">
              Only when… (optional)
            </legend>
            <p className="text-xs text-gray-500">
              Narrow a broad trigger. Every condition must match the event exactly — leave empty to
              run on every one.
            </p>
            <div className="mt-2 space-y-2">
              {filterRows.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    aria-label={`Condition ${String(i + 1)} field`}
                    value={row.field}
                    onChange={(e) => {
                      setFilterRows((rows) =>
                        rows.map((r, j) => (j === i ? { ...r, field: e.target.value } : r)),
                      )
                    }}
                    placeholder="status"
                    className="rounded border px-2 py-1 text-sm"
                  />
                  <span className="text-xs text-gray-400">is</span>
                  <input
                    aria-label={`Condition ${String(i + 1)} value`}
                    value={row.value}
                    onChange={(e) => {
                      setFilterRows((rows) =>
                        rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)),
                      )
                    }}
                    placeholder="won"
                    className="rounded border px-2 py-1 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setFilterRows((rows) => rows.filter((_, j) => j !== i))
                    }}
                    className="rounded border px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                setFilterRows((rows) => [...rows, { field: '', value: '' }])
              }}
              className="mt-2 rounded border px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
            >
              Add condition
            </button>
          </fieldset>

          {selectedAction != null &&
            (() => {
              const fields = configFieldsFor(selectedAction)
              // Agent action only: warn (never block) when a web-connected model
              // and the web_search tool are both selected — they duplicate.
              const redundantWebSearch =
                selectedAction.type === 'agent' && webSearchIsRedundant(config)
              return (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {fields
                    .filter((field) => fieldApplies(fields, config, field))
                    .map((field) =>
                      field.parts === true ? (
                        <PartsField
                          key={field.name}
                          label={field.label}
                          required={field.required}
                          components={components}
                          value={normalizeParts(config[field.name])}
                          onChange={(parts) => {
                            setConfig((c) => ({ ...c, [field.name]: parts }))
                          }}
                        />
                      ) : field.type === 'multiselect' ? (
                        <fieldset
                          key={field.name}
                          aria-label={field.label}
                          className="flex flex-col text-xs text-gray-600 sm:col-span-2"
                        >
                          <legend className="text-xs text-gray-600">{field.label}</legend>
                          <div className="mt-1 space-y-1.5 rounded border px-2 py-2">
                            {(field.options ?? []).map((option) => {
                              const selected = asList(config[field.name])
                              return (
                                <label
                                  key={option.value}
                                  className="flex items-start gap-2 text-sm text-gray-800"
                                >
                                  <input
                                    type="checkbox"
                                    className="mt-0.5"
                                    checked={selected.includes(option.value)}
                                    onChange={(e) => {
                                      setConfig((c) => {
                                        const current = asList(c[field.name])
                                        const next = e.target.checked
                                          ? [...current, option.value]
                                          : current.filter((v) => v !== option.value)
                                        return { ...c, [field.name]: next }
                                      })
                                    }}
                                  />
                                  <span>
                                    <span className="font-medium">{option.value}</span>
                                    {option.description != null && option.description !== '' && (
                                      <span className="block text-xs text-gray-500">
                                        {option.description}
                                      </span>
                                    )}
                                  </span>
                                </label>
                              )
                            })}
                          </div>
                        </fieldset>
                      ) : (
                        <label
                          key={field.name}
                          className={`flex flex-col text-xs text-gray-600 ${
                            field.type === 'textarea' ? 'sm:col-span-2' : ''
                          }`}
                        >
                          {field.label}
                          {field.type === 'textarea' ? (
                            <textarea
                              value={asString(config[field.name])}
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
                              value={effectiveValue(fields, config, field.name)}
                              onChange={(e) => {
                                setConfig((c) => ({ ...c, [field.name]: e.target.value }))
                              }}
                              className={inputClass}
                            >
                              {selectOptions(field, effectiveValue(fields, config, field.name)).map(
                                (option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ),
                              )}
                            </select>
                          ) : (
                            <input
                              type={inputType(field.type)}
                              value={asString(config[field.name])}
                              required={field.required}
                              onChange={(e) => {
                                setConfig((c) => ({ ...c, [field.name]: e.target.value }))
                              }}
                              className={inputClass}
                            />
                          )}
                        </label>
                      ),
                    )}
                  {redundantWebSearch && (
                    <p
                      role="status"
                      className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-800 sm:col-span-2"
                    >
                      This model is web-connected and already performs web search — the web_search
                      tool is redundant here.
                    </p>
                  )}
                </div>
              )
            })()}

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
                  <td className="px-4 py-2 text-gray-600">
                    {triggerLabel(w)}
                    {Object.keys(w.trigger_filter ?? {}).length > 0 && (
                      <span
                        className="ml-1.5 rounded bg-indigo-50 px-1.5 py-0.5 text-xs text-indigo-700"
                        title={Object.entries(w.trigger_filter ?? {})
                          .map(([f, v]) => `${f} is ${v}`)
                          .join(', ')}
                      >
                        filtered
                      </span>
                    )}
                  </td>
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

      <h2 className="mt-10 text-lg font-semibold text-gray-900">Recent runs</h2>
      <p className="mt-1 text-sm text-gray-600">
        Every time an event matched a workflow — what fired, when, and whether the action succeeded.
      </p>

      {runs != null && runs.length === 0 && (
        <div className="mt-4 rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center">
          <p className="text-sm font-medium text-gray-600">Nothing has run yet</p>
          <p className="mt-1 text-xs text-gray-400">
            Runs appear here the next time a matching event fires.
          </p>
        </div>
      )}

      {runs != null && runs.length > 0 && (
        <div className="mt-4 overflow-x-auto rounded-xl border bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">When</th>
                <th className="px-4 py-2">Workflow</th>
                <th className="px-4 py-2">Action</th>
                <th className="px-4 py-2">Outcome</th>
                <th className="px-4 py-2">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap px-4 py-2 text-gray-600">
                    {formatWhen(r.created_at)}
                  </td>
                  <td className="px-4 py-2 text-gray-800">
                    {r.definition_name ?? <span className="text-gray-400">(deleted)</span>}
                  </td>
                  <td className="px-4 py-2 text-gray-600">{r.logs.at(-1)?.action_type ?? '—'}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs ${
                        runStatusClass[r.status] ?? 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs text-rose-700">{runError(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
