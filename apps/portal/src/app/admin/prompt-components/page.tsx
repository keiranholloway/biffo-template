'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/context/auth-context'
import { createApiClient } from '@/lib/api-client'
import {
  createPromptComponent,
  deletePromptComponent,
  fetchPromptComponents,
  updatePromptComponent,
  type PromptComponent,
  type PromptComponentInput,
  type PromptVariable,
} from '@/lib/prompt-components-api'
import { AssistantDrawer } from '@/components/assistant-drawer'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error'
}

const inputClass = 'mt-1 rounded border px-2 py-1 text-sm'

/** One editable variable row. Kept as a list (not a map) so a row mid-edit can
 *  have a blank name without collapsing into another. `description`/`default`
 *  are held as plain strings here and dropped when empty on submit — the Core
 *  schema omits them rather than storing empty strings. */
interface VariableRow {
  name: string
  description: string
  required: boolean
  default: string
}

function toVariableRows(variables: PromptVariable[]): VariableRow[] {
  return variables.map((v) => ({
    name: v.name,
    description: v.description ?? '',
    required: v.required,
    default: v.default ?? '',
  }))
}

/** Rows -> the API's variables list. A row with no name is dropped (it is an
 *  in-progress edit); optional description/default are omitted when blank so the
 *  stored shape is exactly what the server keeps. Correctness (identifier rules,
 *  uniqueness) is enforced server-side — this only shapes the payload. */
function toVariables(rows: VariableRow[]): PromptVariable[] {
  return rows
    .filter((r) => r.name.trim() !== '')
    .map((r) => {
      const variable: PromptVariable = { name: r.name.trim(), required: r.required }
      if (r.description.trim() !== '') variable.description = r.description.trim()
      if (r.default !== '') variable.default = r.default
      return variable
    })
}

export default function PromptComponentsPage() {
  const { getIdToken } = useAuth()
  const client = useMemo(() => createApiClient(getIdToken), [getIdToken])

  const [components, setComponents] = useState<PromptComponent[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Form state. `editingId` non-null while editing an existing component.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  const [variableRows, setVariableRows] = useState<VariableRow[]>([])
  const [busy, setBusy] = useState(false)
  // The "✨ Draft with AI" drawer for the Body field.
  const [assistOpen, setAssistOpen] = useState(false)

  const resetForm = useCallback(() => {
    setEditingId(null)
    setName('')
    setDescription('')
    setBody('')
    setVariableRows([])
  }, [])

  const reload = useCallback(async () => {
    try {
      const rows = await fetchPromptComponents(client)
      setComponents(rows)
      setError(null)
    } catch (err: unknown) {
      setError(errorMessage(err))
    }
  }, [client])

  useEffect(() => {
    void reload()
  }, [reload])

  function loadForEdit(c: PromptComponent) {
    setEditingId(c.id)
    setName(c.name)
    setDescription(c.description ?? '')
    setBody(c.body)
    setVariableRows(toVariableRows(c.variables))
  }

  // Run a mutation, surface any server error (409/422 included) rather than
  // swallow it, and refresh from the server on success.
  async function run(action: () => Promise<unknown>) {
    try {
      await action()
      await reload()
      return true
    } catch (err: unknown) {
      setError(errorMessage(err))
      return false
    }
  }

  async function submitForm() {
    if (busy) return
    const payload: PromptComponentInput = {
      name: name.trim(),
      description: description.trim() === '' ? null : description.trim(),
      body,
      variables: toVariables(variableRows),
    }
    setBusy(true)
    try {
      const ok = await run(async () => {
        if (editingId != null) {
          await updatePromptComponent(client, editingId, payload)
        } else {
          await createPromptComponent(client, payload)
        }
      })
      // Only clear the form on success — a 409/422 keeps the author's input so
      // they can fix it rather than lose it.
      if (ok) resetForm()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Prompt library</h1>
      <p className="mt-1 text-sm text-gray-600">
        Reusable prompt components (ADR-0015). Define a clause once and reference it from many
        agents — a shared house style (no variables), or a parameterised template with{' '}
        <code>{'{{placeholders}}'}</code> filled in per agent. Editing a component propagates to
        every agent that references it on its next run.
      </p>

      {error != null && (
        <div className="mt-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          {error}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submitForm()
        }}
        className="mt-6 rounded-xl border bg-white p-4 shadow-sm"
      >
        <h2 className="text-sm font-semibold text-gray-900">
          {editingId != null ? 'Edit component' : 'New component'}
        </h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col text-xs text-gray-600">
            Name
            <input
              required
              aria-label="Name"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
              }}
              placeholder="house-style"
              className={inputClass}
            />
          </label>
          <label className="flex flex-col text-xs text-gray-600">
            Description
            <input
              aria-label="Description"
              value={description}
              onChange={(e) => {
                setDescription(e.target.value)
              }}
              placeholder="What this component is for"
              className={inputClass}
            />
          </label>
          <label className="flex flex-col text-xs text-gray-600 sm:col-span-2">
            Body
            <textarea
              required
              aria-label="Body"
              value={body}
              onChange={(e) => {
                setBody(e.target.value)
              }}
              rows={4}
              placeholder="State confidence per claim. Cite sources. Score leads for {{region}}."
              className={inputClass}
            />
          </label>
          <div className="sm:col-span-2">
            <button
              type="button"
              onClick={() => {
                setAssistOpen(true)
              }}
              className="rounded border px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
            >
              ✨ Draft body with AI
            </button>
          </div>
        </div>

        <fieldset className="mt-4 rounded-lg border border-gray-200 p-3">
          <legend className="px-1 text-xs font-semibold text-gray-700">Variables (optional)</legend>
          <p className="text-xs text-gray-500">
            Declare a slot for each <code>{'{{name}}'}</code> in the body. Referencing agents supply
            a static value per slot. No variables = a shared house-style clause.
          </p>
          <div className="mt-2 space-y-2">
            {variableRows.map((row, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <input
                  aria-label={`Variable ${String(i + 1)} name`}
                  value={row.name}
                  onChange={(e) => {
                    setVariableRows((rows) =>
                      rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)),
                    )
                  }}
                  placeholder="region"
                  className="rounded border px-2 py-1 text-sm"
                />
                <input
                  aria-label={`Variable ${String(i + 1)} description`}
                  value={row.description}
                  onChange={(e) => {
                    setVariableRows((rows) =>
                      rows.map((r, j) => (j === i ? { ...r, description: e.target.value } : r)),
                    )
                  }}
                  placeholder="Description"
                  className="rounded border px-2 py-1 text-sm"
                />
                <input
                  aria-label={`Variable ${String(i + 1)} default`}
                  value={row.default}
                  onChange={(e) => {
                    setVariableRows((rows) =>
                      rows.map((r, j) => (j === i ? { ...r, default: e.target.value } : r)),
                    )
                  }}
                  placeholder="Default (optional)"
                  className="rounded border px-2 py-1 text-sm"
                />
                <label className="flex items-center gap-1 text-xs text-gray-700">
                  <input
                    type="checkbox"
                    aria-label={`Variable ${String(i + 1)} required`}
                    checked={row.required}
                    onChange={(e) => {
                      setVariableRows((rows) =>
                        rows.map((r, j) => (j === i ? { ...r, required: e.target.checked } : r)),
                      )
                    }}
                  />
                  Required
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setVariableRows((rows) => rows.filter((_, j) => j !== i))
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
              setVariableRows((rows) => [
                ...rows,
                { name: '', description: '', required: false, default: '' },
              ])
            }}
            className="mt-2 rounded border px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
          >
            Add variable
          </button>
        </fieldset>

        <div className="mt-4 flex gap-2">
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? 'Saving…' : editingId != null ? 'Save changes' : 'Add component'}
          </button>
          {editingId != null && (
            <button
              type="button"
              onClick={resetForm}
              className="rounded border px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
          )}
        </div>
      </form>

      {assistOpen && (
        <AssistantDrawer
          open
          onClose={() => {
            setAssistOpen(false)
          }}
          context={{ kind: 'component-body', componentName: name.trim() || undefined }}
          onAccept={(text) => {
            setBody(text)
            setAssistOpen(false)
          }}
        />
      )}

      {components == null && error == null && (
        <div className="mt-6 space-y-2" aria-label="Loading prompt components">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded bg-gray-100" />
          ))}
        </div>
      )}

      {components != null && components.length === 0 && (
        <div className="mt-8 rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center">
          <p className="text-sm font-medium text-gray-600">No prompt components yet</p>
          <p className="mt-1 text-xs text-gray-400">Create one above to reuse it across agents.</p>
        </div>
      )}

      {components != null && components.length > 0 && (
        <div className="mt-6 overflow-x-auto rounded-xl border bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Description</th>
                <th className="px-4 py-2">Variables</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {components.map((c) => (
                <tr key={c.id}>
                  <td className="px-4 py-2 font-medium text-gray-800">{c.name}</td>
                  <td className="px-4 py-2 text-gray-600">
                    {c.description ?? <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-4 py-2 text-gray-600">
                    {c.variables.length === 0 ? (
                      <span className="text-gray-400">none</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {c.variables.map((v) => (
                          <span
                            key={v.name}
                            className="rounded bg-indigo-50 px-1.5 py-0.5 text-xs text-indigo-700"
                            title={v.description ?? undefined}
                          >
                            {v.name}
                            {v.required && <span className="text-rose-600">*</span>}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          loadForEdit(c)
                        }}
                        className="rounded border px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void run(() => deletePromptComponent(client, c.id))
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
