import type { CatalogTrigger } from './orchestration-api'

/**
 * Presentation helpers for the workflow builder's trigger picker.
 *
 * The catalog is the union of the Core event registry (`origin: "declared"`)
 * and triggers observed on the event bus (`origin: "observed"`) — see the
 * `/orchestration/workflows/catalog` endpoint. Once more events exist a flat
 * dropdown stops scaling, so the builder groups by `source`, badges the
 * declared/observed distinction, and offers a text filter.
 *
 * These are pure functions on purpose: the grouping/filtering rules are the
 * part worth testing, and they should not require rendering the page.
 */

/** The `source|detail_type` composite the builder uses as a select value. */
export function triggerKeyOf(trigger: Pick<CatalogTrigger, 'source' | 'detail_type'>): string {
  return `${trigger.source}|${trigger.detail_type}`
}

/**
 * A trigger's origin, defaulting to `declared`.
 *
 * The field is optional in the TS type so a portal built from a newer template
 * still renders against an older Core API that predates `origin`. Anything not
 * explicitly observed is treated as declared.
 */
export function originOf(trigger: CatalogTrigger): 'declared' | 'observed' {
  return trigger.origin === 'observed' ? 'observed' : 'declared'
}

/** Case-insensitive match across every field a user might reasonably type. */
export function matchesQuery(trigger: CatalogTrigger, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return [
    trigger.label,
    trigger.source,
    trigger.detail_type,
    trigger.description,
    originOf(trigger),
  ]
    .join(' ')
    .toLowerCase()
    .includes(q)
}

/**
 * Filter by `query`, always retaining `keepKey` (the currently selected
 * trigger). Without that, typing a filter that excludes the current selection
 * would leave the `<select>` with a value none of its options carry — the
 * browser then silently reassigns it, changing the workflow the user is
 * editing behind their back.
 */
export function filterTriggers(
  triggers: CatalogTrigger[],
  query: string,
  keepKey?: string,
): CatalogTrigger[] {
  return triggers.filter((t) => matchesQuery(t, query) || triggerKeyOf(t) === keepKey)
}

export interface TriggerGroup {
  source: string
  triggers: CatalogTrigger[]
}

/**
 * Group by `source`, preserving the catalog's own ordering — both the order in
 * which sources first appear and the order of triggers within each source. The
 * API already emits a stable order (registry declarations first, then observed).
 */
export function groupTriggersBySource(triggers: CatalogTrigger[]): TriggerGroup[] {
  const groups: TriggerGroup[] = []
  const bySource = new Map<string, TriggerGroup>()
  for (const trigger of triggers) {
    let group = bySource.get(trigger.source)
    if (group == null) {
      group = { source: trigger.source, triggers: [] }
      bySource.set(trigger.source, group)
      groups.push(group)
    }
    group.triggers.push(trigger)
  }
  return groups
}

/**
 * The option text. Observed triggers are suffixed because a native `<option>`
 * cannot carry the styled badge — the badge itself is rendered beside the
 * select for whichever trigger is currently selected.
 */
export function optionLabel(trigger: CatalogTrigger): string {
  return originOf(trigger) === 'observed' ? `${trigger.label} (observed)` : trigger.label
}
