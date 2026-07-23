/**
 * Ordered-parts prompt composition — the portal-side mirror of Core's
 * `prompt_parts.py` (ADR-0015 §2). A prompt field (`instructions`/`goals` on the
 * agent action, flagged `parts: true` in the catalog) is an ordered list of
 * parts, each either:
 *
 * - `{ inline: "<text>" }` — bespoke text authored on this definition, or
 * - `{ component: "<name>", values: { <var>: <value> } }` — a reference to a
 *   library component with author-time values for its declared variables.
 *
 * A plain string is accepted as sugar for a single inline part, so a definition
 * authored before the library existed still loads and round-trips unchanged.
 *
 * **Trust boundary (ADR-0015 §5):** `values` are static, author-time strings
 * only. There is no path here — and must never be one — for sourcing a value
 * from runtime/event data; that would inject untrusted input into the
 * instruction channel. Core resolves and validates; this module only shapes the
 * editor's data.
 */

export interface InlinePart {
  inline: string
}

export interface ComponentPart {
  component: string
  values: Record<string, string>
}

export type PromptPart = InlinePart | ComponentPart

export function isComponentPart(part: PromptPart): part is ComponentPart {
  return 'component' in part
}

export function isInlinePart(part: PromptPart): part is InlinePart {
  return 'inline' in part
}

function normalizePart(raw: unknown): PromptPart | null {
  if (raw == null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (typeof obj['inline'] === 'string') return { inline: obj['inline'] }
  if (typeof obj['component'] === 'string') {
    const values: Record<string, string> = {}
    const rawValues = obj['values']
    if (rawValues != null && typeof rawValues === 'object') {
      for (const [key, value] of Object.entries(rawValues)) {
        if (typeof value === 'string') values[key] = value
      }
    }
    return { component: obj['component'], values }
  }
  return null
}

/**
 * Normalise a stored field value into an ordered-parts list. `null`/blank
 * strings become `[]`; a non-blank string becomes a single inline part (the
 * pre-library shape); an array is validated part-by-part, dropping anything
 * malformed. Core is the authority on validity — this is the loose,
 * display-side coercion so the editor always has a clean `PromptPart[]`.
 */
export function normalizeParts(raw: unknown): PromptPart[] {
  if (raw == null) return []
  if (typeof raw === 'string') return raw.trim() === '' ? [] : [{ inline: raw }]
  if (Array.isArray(raw)) {
    return raw.map(normalizePart).filter((part): part is PromptPart => part !== null)
  }
  return []
}
