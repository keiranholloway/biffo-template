'use client'

import type { PromptComponent } from '@/lib/prompt-components-api'
import { isComponentPart, type ComponentPart, type PromptPart } from '@/lib/prompt-parts'

const inputClass = 'mt-1 rounded border px-2 py-1 text-sm'

interface PartsFieldProps {
  /** Human label of the underlying config field (e.g. "Instructions"). Used to
   *  disambiguate control labels when two parts fields render on one form. */
  label: string
  value: PromptPart[]
  onChange: (parts: PromptPart[]) => void
  /** Components available to reference, from the prompt-library CRUD API (NOT the
   *  action catalog). May be empty — the editor still renders. */
  components: PromptComponent[]
  required?: boolean
}

/**
 * The ordered-parts editor for a `parts: true` prompt field (ADR-0015 §2).
 * Renders `instructions`/`goals` as an ordered list of parts — inline text or a
 * reference to a library component — instead of a plain textarea. Supports
 * add / remove / reorder. A component reference renders inputs for THAT
 * component's declared variables, collecting **static author-time strings**
 * only (ADR-0015 §5): there is deliberately no affordance to source a value
 * from runtime/event data. Correctness is enforced server-side; this pre-warns
 * (unset required variable, unknown component) for UX only.
 */
export function PartsField({ label, value, onChange, components, required }: PartsFieldProps) {
  function updateAt(index: number, part: PromptPart) {
    onChange(value.map((p, i) => (i === index ? part : p)))
  }

  function removeAt(index: number) {
    onChange(value.filter((_, i) => i !== index))
  }

  function move(index: number, delta: number) {
    const target = index + delta
    if (target < 0 || target >= value.length) return
    const next = [...value]
    const moved = next[index]
    if (moved === undefined) return
    next.splice(index, 1)
    next.splice(target, 0, moved)
    onChange(next)
  }

  function addInline() {
    onChange([...value, { inline: '' }])
  }

  function addComponent() {
    // Seed with the first available component when there is one, so the picker
    // shows a real choice rather than an empty selection.
    onChange([...value, { component: components[0]?.name ?? '', values: {} }])
  }

  return (
    <fieldset aria-label={label} className="flex flex-col text-xs text-gray-600 sm:col-span-2">
      <legend className="text-xs text-gray-600">
        {label}
        {required === true && <span className="text-rose-600"> *</span>}
      </legend>
      <p className="mt-1 text-xs text-gray-500">
        Compose the prompt from ordered parts: bespoke text, or a reusable library component. Parts
        apply top to bottom.
      </p>

      <div className="mt-2 space-y-2">
        {value.length === 0 && (
          <p className="rounded border border-dashed border-gray-300 px-3 py-2 text-xs text-gray-400">
            No parts yet. Add inline text or a component below.
          </p>
        )}
        {value.map((part, index) => (
          <div key={index} className="rounded border border-gray-200 p-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-600">
                {isComponentPart(part) ? 'Component' : 'Inline text'} · part {index + 1}
              </span>
              <div className="flex gap-1">
                <button
                  type="button"
                  aria-label={`Move ${label} part ${String(index + 1)} up`}
                  disabled={index === 0}
                  onClick={() => {
                    move(index, -1)
                  }}
                  className="rounded border px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Move ${label} part ${String(index + 1)} down`}
                  disabled={index === value.length - 1}
                  onClick={() => {
                    move(index, 1)
                  }}
                  className="rounded border px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                >
                  ↓
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${label} part ${String(index + 1)}`}
                  onClick={() => {
                    removeAt(index)
                  }}
                  className="rounded border px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50"
                >
                  Remove
                </button>
              </div>
            </div>

            {isComponentPart(part) ? (
              <ComponentPartEditor
                label={label}
                index={index}
                part={part}
                components={components}
                onChange={(next) => {
                  updateAt(index, next)
                }}
              />
            ) : (
              <textarea
                aria-label={`${label} part ${String(index + 1)} text`}
                value={part.inline}
                rows={3}
                onChange={(e) => {
                  updateAt(index, { inline: e.target.value })
                }}
                className={`${inputClass} w-full`}
              />
            )}
          </div>
        ))}
      </div>

      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={addInline}
          className="rounded border px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
        >
          Add text
        </button>
        <button
          type="button"
          onClick={addComponent}
          className="rounded border px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
        >
          Add component
        </button>
      </div>
      {components.length === 0 && (
        <p className="mt-1 text-xs text-gray-400">
          No components in the library yet. Create one under “Prompt library” to reference it here.
        </p>
      )}
    </fieldset>
  )
}

interface ComponentPartEditorProps {
  label: string
  index: number
  part: ComponentPart
  components: PromptComponent[]
  onChange: (part: ComponentPart) => void
}

function ComponentPartEditor({
  label,
  index,
  part,
  components,
  onChange,
}: ComponentPartEditorProps) {
  const selected = components.find((c) => c.name === part.component)
  const unknown = part.component !== '' && selected == null

  return (
    <div className="mt-1 space-y-2">
      <select
        aria-label={`${label} part ${String(index + 1)} component`}
        value={part.component}
        onChange={(e) => {
          // Switching component drops values that the new component doesn't
          // declare; a stale value for an undeclared variable is a 422 at save.
          onChange({ component: e.target.value, values: {} })
        }}
        className={inputClass}
      >
        <option value="">— Select a component —</option>
        {/* Keep an unknown stored name visible/selected rather than let the
            browser silently reassign the select to its first option. */}
        {unknown && <option value={part.component}>{part.component} (unknown)</option>}
        {components.map((c) => (
          <option key={c.id} value={c.name}>
            {c.name}
          </option>
        ))}
      </select>

      {unknown && (
        <p role="status" className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
          Component “{part.component}” is not in the library. The run will fail unless it exists at
          run time.
        </p>
      )}

      {selected != null && selected.description != null && selected.description !== '' && (
        <p className="text-xs text-gray-500">{selected.description}</p>
      )}

      {selected != null && selected.variables.length > 0 && (
        <div className="space-y-1.5">
          {selected.variables.map((variable) => {
            const current = part.values[variable.name] ?? ''
            const missingRequired =
              variable.required && current.trim() === '' && variable.default == null
            return (
              <label key={variable.name} className="flex flex-col text-xs text-gray-600">
                <span>
                  {variable.name}
                  {variable.required && <span className="text-rose-600"> *</span>}
                  {variable.description != null && variable.description !== '' && (
                    <span className="ml-1 font-normal text-gray-400">— {variable.description}</span>
                  )}
                </span>
                <input
                  aria-label={`${label} part ${String(index + 1)} value for ${variable.name}`}
                  value={current}
                  placeholder={variable.default != null ? `Default: ${variable.default}` : 'Value'}
                  onChange={(e) => {
                    onChange({
                      ...part,
                      values: { ...part.values, [variable.name]: e.target.value },
                    })
                  }}
                  className={inputClass}
                />
                {missingRequired && (
                  <span role="status" className="mt-0.5 text-xs text-amber-700">
                    Required — set a value or the run will fail.
                  </span>
                )}
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}
