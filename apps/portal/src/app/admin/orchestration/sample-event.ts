import type { CatalogTriggerField } from '@/lib/orchestration-api'

/**
 * Build a sample event payload from a trigger's declared fields (#505), so the
 * builder's "Test workflow" can run against a realistic payload instead of a
 * blank object. Each field becomes one key with an example value inferred from
 * its type: an `enum`'s first value, a representative number/boolean, or a
 * human-readable placeholder string. The result is editable in the UI — this is
 * only the starting point.
 *
 * A trigger with no declared fields (an observed event, or a Core API predating
 * the metadata) yields `{}`; the author fills the sample in by hand.
 */
export function buildSampleEvent(fields: CatalogTriggerField[]): Record<string, unknown> {
  const event: Record<string, unknown> = {}
  for (const field of fields) {
    event[field.name] = sampleValue(field)
  }
  return event
}

function sampleValue(field: CatalogTriggerField): unknown {
  switch (field.type) {
    case 'enum':
      // First declared value is the most representative example.
      return field.values[0] ?? `example ${field.name}`
    case 'number':
      return 42
    case 'boolean':
      return true
    case 'string':
      return `example ${field.name}`
  }
}

/** Pretty-print a sample event for the editable JSON textarea. */
export function formatSampleEvent(event: Record<string, unknown>): string {
  return JSON.stringify(event, null, 2)
}

/**
 * Parse the editable JSON back into an object for the dry-run request. Returns
 * an error message instead of throwing so the panel can show it inline; an empty
 * string is treated as an empty event (`{}`), not an error.
 */
export function parseSampleEvent(
  text: string,
): { event: Record<string, unknown>; error: null } | { event: null; error: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { event: {}, error: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { event: null, error: 'Sample input data is not valid JSON.' }
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { event: null, error: 'Sample input data must be a JSON object.' }
  }
  return { event: parsed as Record<string, unknown>, error: null }
}
