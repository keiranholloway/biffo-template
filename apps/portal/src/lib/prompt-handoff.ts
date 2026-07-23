/**
 * "Use this" handoff (ADR-0016 Phase 3). Carries a chunk of assistant-authored
 * prose from the prompt-assistant chat into an authoring surface — a prompt
 * component's body, or an agent action's instructions/goals.
 *
 * The portal is a static export (`output: 'export'`), so there is no server to
 * hold state across a navigation, and prompt bodies can be long — too long to
 * put in a query string cleanly. So the source page stashes the text in
 * `sessionStorage` under one well-known key and navigates to the target page;
 * the target page, on mount, reads-and-clears the key and pre-fills the relevant
 * field. sessionStorage (not localStorage) so the handoff is scoped to the tab
 * and never outlives the session.
 */

/** The authoring surface a handoff is destined for. */
export type HandoffTarget = 'prompt-component-body' | 'agent-instructions' | 'agent-goals'

export interface PromptHandoff {
  target: HandoffTarget
  text: string
}

/** Single well-known key. Namespaced so it never collides with other portal state. */
export const HANDOFF_KEY = 'biffo:prompt-handoff'

/** The route each target's authoring page lives at (trailing slash — the export
 *  uses `trailingSlash: true`). */
export const HANDOFF_ROUTE: Record<HandoffTarget, string> = {
  'prompt-component-body': '/admin/prompt-components/',
  'agent-instructions': '/admin/orchestration/',
  'agent-goals': '/admin/orchestration/',
}

function storage(): Storage | null {
  // Guard for SSR/prerender: the export build has no `window`.
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

/** Stash a handoff for the target page to pick up. Silently no-ops if storage
 *  is unavailable (private-mode edge, SSR). */
export function stashHandoff(handoff: PromptHandoff): void {
  storage()?.setItem(HANDOFF_KEY, JSON.stringify(handoff))
}

function parse(raw: string | null): PromptHandoff | null {
  if (raw == null) return null
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    const { target, text } = obj
    if (
      (target === 'prompt-component-body' ||
        target === 'agent-instructions' ||
        target === 'agent-goals') &&
      typeof text === 'string'
    ) {
      return { target, text }
    }
  } catch {
    // Corrupt payload — treat as absent.
  }
  return null
}

/**
 * Read a pending handoff if its target is one this page accepts, clearing it so
 * it is consumed exactly once. Returns `null` when nothing is pending or the
 * stored target is not accepted here (left in place for the page that owns it).
 */
export function consumeHandoff(accepted: HandoffTarget | HandoffTarget[]): PromptHandoff | null {
  const store = storage()
  if (store == null) return null
  const handoff = parse(store.getItem(HANDOFF_KEY))
  if (handoff == null) return null
  const targets = Array.isArray(accepted) ? accepted : [accepted]
  if (!targets.includes(handoff.target)) return null
  store.removeItem(HANDOFF_KEY)
  return handoff
}
