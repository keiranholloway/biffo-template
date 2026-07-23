import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const CATALOG_FILE = 'services/api/src/api/schemas/orchestration.py'
const HANDLERS_FILE = 'services/_plugins/orchestrator/src/orchestrator/actions.py'

/**
 * The workflow-builder catalog and the engine's action registry are two
 * hand-maintained lists that MUST agree, in different packages that do not
 * import each other (#364):
 *
 *   - WORKFLOW_ACTIONS — services/api/.../schemas/orchestration.py — what the
 *     builder UI offers.
 *   - ACTION_HANDLERS — services/_plugins/orchestrator/.../actions.py — what the
 *     engine can actually dispatch.
 *
 * A catalog entry with no handler is an action the builder offers that fails at
 * dispatch; a handler with no catalog entry is a dead capability unreachable
 * through the UI. Nothing else compares them — both drift directions ship green
 * — so this is the guard, reading each file as source from the repo root exactly
 * like core-plugins-sync.test.ts, because no single assertion can span the
 * package boundary. Adding an action means editing both files; this fails until
 * they match.
 */

/** The `"type"` values of the top-level entries in WORKFLOW_ACTIONS. */
function catalogActionTypes(): string[] {
  const src = readFileSync(join(repoRoot, CATALOG_FILE), 'utf8')
  // Isolate the WORKFLOW_ACTIONS list literal (from `= [` to the `]` that
  // closes it at column 0) so nothing outside it can be mistaken for an action.
  const block = /^WORKFLOW_ACTIONS\b[^\n]*=\s*\[([\s\S]*?)^\]/m.exec(src)?.[1]
  if (block === undefined) {
    throw new Error(`action-registry sync guard: no WORKFLOW_ACTIONS list found in ${CATALOG_FILE}`)
  }
  // Each entry is a dict whose top-level `"type"` key sits at exactly 8 spaces
  // of indentation. Field-level `"type"` keys (inside config_fields) are either
  // mid-line or indented deeper, so anchoring to 8 spaces selects only the
  // action types.
  return [...block.matchAll(/^ {8}"type":\s*"([a-z_]+)"/gm)].map((m) => m[1]!).sort()
}

/** The keys registered in the ACTION_HANDLERS dict. */
function handlerActionTypes(): string[] {
  const src = readFileSync(join(repoRoot, HANDLERS_FILE), 'utf8')
  // Isolate the ACTION_HANDLERS dict literal (from `= {` to the `}` that closes
  // it at column 0).
  const block = /^ACTION_HANDLERS\b[^\n]*=\s*\{([\s\S]*?)^\}/m.exec(src)?.[1]
  if (block === undefined) {
    throw new Error(`action-registry sync guard: no ACTION_HANDLERS dict found in ${HANDLERS_FILE}`)
  }
  // Each mapping is `"<action_type>": <handler>,` — the key is the action type.
  return [...block.matchAll(/"([a-z_]+)":/g)].map((m) => m[1]!).sort()
}

describe('WORKFLOW_ACTIONS and ACTION_HANDLERS stay in step across the package boundary', () => {
  it('the catalog offers a non-empty set of actions', () => {
    expect(catalogActionTypes().length).toBeGreaterThan(0)
  })

  it('the engine registers a non-empty set of handlers', () => {
    expect(handlerActionTypes().length).toBeGreaterThan(0)
  })

  it('every catalog action has a handler and every handler has a catalog action', () => {
    const catalog = catalogActionTypes()
    const handlers = handlerActionTypes()
    const missingHandler = catalog.filter((t) => !handlers.includes(t))
    const missingCatalog = handlers.filter((t) => !catalog.includes(t))
    expect(
      { missingHandler, missingCatalog },
      [
        'WORKFLOW_ACTIONS and ACTION_HANDLERS have drifted.',
        missingHandler.length > 0
          ? `Catalog action(s) with NO handler (offered in the builder, would fail at dispatch): ${missingHandler.join(', ')}`
          : '',
        missingCatalog.length > 0
          ? `Handler(s) with NO catalog entry (dead, unreachable from the UI): ${missingCatalog.join(', ')}`
          : '',
        `Reconcile ${CATALOG_FILE} (WORKFLOW_ACTIONS) with ${HANDLERS_FILE} (ACTION_HANDLERS).`,
      ]
        .filter(Boolean)
        .join('\n'),
    ).toEqual({ missingHandler: [], missingCatalog: [] })
  })

  it('is the expected action set today (email, google_chat, whatsapp, agent)', () => {
    // A change here is intentional and should move with a real action addition,
    // edited in lockstep across both files above.
    const expected = ['agent', 'email', 'google_chat', 'whatsapp']
    expect(catalogActionTypes()).toEqual(expected)
    expect(handlerActionTypes()).toEqual(expected)
  })
})
