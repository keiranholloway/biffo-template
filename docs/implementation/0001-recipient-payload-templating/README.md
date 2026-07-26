# Implementation Plan: Payload-Variable Templating for Recipient/Target Fields

**Status:** Implemented in biffo-template (Milestones 1–3: #598, #599, #600).
Milestone 4 (real-deployment E2E verification) is pending distribution to a
live instance — biffo-template itself is not deployed.
**Date:** 2026-07-26
**Source PRD:** inline (this conversation) — no separate ticket
**Data model sources consulted:** none required — no new tables, no persisted-schema change

## Context

The orchestration engine (workflow_definition → matched trigger → dispatch action)
already lets an email/Slack/Google Chat/WhatsApp action's **content** fields
(`subject`, `body`, `message`) reference the triggering event's payload via
`{field}` templating. It does not extend that to the **recipient/target**
fields — email's `to`, WhatsApp's `to`. Concretely: a `demo.requested` workflow
can template the email body with `{company}`, but cannot send that email to
`{email}` — the address that actually submitted the form. The only way to
notify the person who took the action (a welcome email, a confirmation) is
today impossible; `to` must be a fixed, literal address.

The goal is narrow: make `to` on email and WhatsApp templatable exactly like
`subject`/`body`/`message` already are, reusing the existing rendering
mechanism end to end, plus give the portal builder a way to insert an
available payload field into that box instead of expecting the operator to
memorize/guess field names.

## Current state (confirmed by reading the code)

- **Rendering already exists and already works for content fields.**
  `services/_plugins/orchestrator/src/orchestrator/actions.py:173` — `_render(template, payload)`
  does `template.format_map(defaultdict(str, payload))`, i.e. `{field}` syntax,
  missing keys → `""` (no crash). It's called for `subject`/`body` in
  `send_email` (line 203-204), `message` in `send_google_chat`/`send_slack`
  (lines 235, 263), `message`/`template_params` in WhatsApp (lines 282, 295).
- **The two recipient/target fields explicitly skip `_render`:**
  - `send_email` line 200: `to = _require(config, "email", "to")` — read verbatim.
  - `send_whatsapp` line 358: `to = _require(config, "whatsapp", "to")` — read verbatim.
  - Slack and Google Chat have **no per-run recipient field at all** — their
    "destination" is a tenant-level `webhook_url` (a secret, set once per
    workflow, not derived from event payload). So only email and WhatsApp are
    in scope; Slack/Google Chat need no change.
- **Core-API validation actively blocks templating `to` today.**
  `services/api/src/api/schemas/orchestration.py`:
  - `WORKFLOW_ACTIONS` catalog (line 172 on): email's `to` is `{"type": "email", required: True}`
    (line 178); WhatsApp's `to` is `{"type": "tel", required: True}` (line 241-245).
  - `_validate_action_config` (line 582): line 645-647 — `if field["type"] == "email"` and
    the value doesn't match `_EMAIL_RE`, it raises. `tel` has no format regex today (only
    `email`/`url` are format-checked at line 645-650), so WhatsApp's `to` is
    actually **already accepted as a template string** by validation — only
    the plugin-side skip (above) blocks it end to end. Email is the one field
    genuinely blocked by validation.
- **Payload field names per trigger are already known and already surfaced to
  the portal.** `services/api/src/api/events/registry.py` declares each event's
  payload shape (e.g. `demo.requested` → `email`, `company`); the `/catalog`
  endpoint exposes `selectedTrigger.fields` to the client, and the portal
  already consumes this today (`apps/portal/src/app/admin/orchestration/page.tsx`
  line 483-511: `selectedTrigger`, `triggerFields: CatalogTriggerField[]`,
  `findTriggerField` helper) to drive the existing trigger-filter row UI
  (lines 844-962). No new backend data plumbing is needed to know which
  field names are legal for the selected trigger — reuse `triggerFields`.
- **Portal rendering of `to`.** `fieldControl()` (page.tsx line 698-820): every
  field not `parts`/`multiselect`/`textarea`/`select` falls to the plain
  `<input type={inputType(field.type)}>` branch (line 800-816) — that's where
  email's `to` (`type: "email"`) and WhatsApp's `to` (`type: "tel"`) render
  today, as ordinary inputs with no variable-insertion affordance. There is a
  `PartsField` component (line 704, imported from `./parts-field`) but it's a
  **different, unrelated** double-brace `{{var}}` prompt-library system wired
  only to agent `instructions`/`goals` fields (`field.parts === true`) — not
  reusable as-is for single-brace event-payload fields, though its "insert a
  token" UX is the right shape to mirror.

## Scope

1. **Core API** (`services/api/src/api/schemas/orchestration.py`):
   - Add a new catalog field flag, e.g. `"payload_template": true`, to email's
     `to` (line 178) and WhatsApp's `to` (line 241-245).
   - In `_validate_action_config`, before the existing `field["type"] == "email"`
     regex check (line 645), if `field.get("payload_template")` and the value
     contains `{`/`}` (i.e. looks like a template, not a literal), skip the
     literal-format check — accept it as-is. A literal address with no braces
     still goes through the existing regex, so **plain email/phone values keep
     validating exactly as before** (backward compatible). Do not attempt to
     validate that referenced field names exist on the trigger's payload
     schema server-side — the portal-side picker (below) is the guardrail for
     authoring; a stricter server check would need per-trigger payload-schema
     awareness the validator doesn't have today and isn't worth adding for v1
     (an unmatched name already degrades gracefully to `""` via `_render`'s
     `defaultdict`, not a hard failure).
   - No new endpoint, no new table, no migration — this is a validation-branch
     change only.

2. **Plugin** (`services/_plugins/orchestrator/src/orchestrator/actions.py`):
   - `send_email`: change line 200 to `to = _render(_require(config, "email", "to"), payload)`.
   - `send_whatsapp`: change line 358 to `to = _render(_require(config, "whatsapp", "to"), payload)`.
   - Guard against a rendered-blank recipient: after rendering, if the result
     is empty/whitespace-only, raise `ActionError` (not `TransientActionError`
     — a missing payload field won't fix itself on retry) with a message
     naming the action and the original template, e.g.
     `"email action_config 'to' rendered empty — check the template references a field the trigger actually carries"`.
     This mirrors how `_require` already raises `ActionError` for a missing
     key, and prevents a silent send to `""`/an SES/WhatsApp-API error that's
     harder to diagnose than an explicit action_log failure.
   - No change to `send_slack`/`send_google_chat` (no per-run recipient field).

3. **Portal UI** (`apps/portal/src/app/admin/orchestration/page.tsx`):
   - Extend the `CatalogActionField` type (wherever it's declared/imported,
     likely `@/lib/trigger-catalog` or adjacent — confirm during build) to
     carry the new `payload_template?: boolean` flag from the catalog.
   - In `fieldControl()`'s plain-`<input>` branch (line 799-817), when
     `field.payload_template === true` and `triggerFields.length > 0`, render
     a small inline "insert field" affordance next to the input — e.g. a
     `<select>` of `triggerFields` (name + label, same data already driving
     the trigger-filter row at line 844-962) that on choose appends
     `{fieldName}` into the current input value at cursor/end, via the same
     `setField` callback already in scope. Keep it visually lightweight (not
     a full `PartsField` port) — a `+ Insert field ▾` button/select is
     sufficient; this is additive to the existing plain input, which keeps
     working for a literal address exactly as today.
   - When the selected trigger declares no fields (line 1197 handles this
     case elsewhere), simply omit the affordance — falls back to today's
     plain input, no dead-end UI.

4. **Backward compatibility** — explicitly verified by design, not just
   asserted: a literal `to`/`to` (whatsapp) with no braces (a) still matches
   `_EMAIL_RE`/passes tel's no-op format check in Core validation, (b) round-
   trips through `_render`/`format_map` unchanged (a string with no `{...}`
   placeholders is returned as-is), so every existing workflow definition
   keeps sending to the same fixed address with zero migration.

## Data model mapping

No table/columns touched. `action_config` is an opaque JSON blob on
`workflow_definition` already (validated, not schema-migrated) — this feature
only changes what values pass validation and how the plugin interprets a
string it already stores.

## Milestones

1. **Core API validation change** — add `payload_template` catalog flag to
   email/WhatsApp `to`, add the skip-format-check-when-templated branch in
   `_validate_action_config`. Unit tests: literal email still validates,
   literal malformed email still rejected, `{email}` template now accepted,
   `{email} extra text` also accepted (still just a string field).
2. **Plugin rendering + empty-guard** — apply `_render` to `to` in
   `send_email`/`send_whatsapp`; add the blank-after-render `ActionError`.
   Unit tests: `to="{email}"` with `payload={"email": "a@b.com"}"` renders and
   sends to `a@b.com`; `to="{missing}"` raises `ActionError` (not sent, not
   retried); `to="fixed@example.com"` unaffected.
3. **Portal picker UI** — extend `CatalogActionField` type, add the insert-
   field affordance in `fieldControl()`, gated on `payload_template` +
   non-empty `triggerFields`. Manual/E2E check: select `demo.requested`
   trigger + email action, confirm `email`/`company` appear as insertable
   options for `to`, confirm inserting produces `{email}` in the box, confirm
   save round-trips.
4. **End-to-end verification** (per `AGENTS.md` — reproduce/verify by the real
   route, not just unit tests): create a workflow on `demo.requested` with
   `to = "{email}"`, submit a real demo form on a dev deployment, confirm the
   email actually arrives at the submitted address (not a fixed test inbox)
   and `action_log` records success with the resolved address implicitly
   (via SES's own delivery, not necessarily stored — check whether
   `action_log` currently stores the rendered `to`; if not, note as a
   follow-on, not a blocker for this feature).

## Testing plan

- Core API: pytest cases in the existing orchestration schema test file for
  `_validate_action_config` covering the four cases in Milestone 1.
- Plugin: pytest cases in the existing actions test file covering the three
  cases in Milestone 2, using the existing fake `ses_client`/`http_client`
  fixtures already used for `send_email`/`send_whatsapp` tests.
- Portal: existing test setup for this page (check for a `page.test.tsx` or
  similar) — add a case that a `payload_template` field renders the picker
  when trigger fields exist and omits it otherwise.
- Manual E2E per Milestone 4, required by `[[e2e-testing-required]]` project
  convention — implementation is not "done" on green tests alone.

## Open questions / explicitly deferred

- Multi-recipient templating (e.g. `to` as a list where one entry is a
  template) — out of scope; today's `isinstance(to, str)` vs list branch in
  `send_email` is untouched, this feature only templates the single-string
  case the portal UI actually authors.
- Branching/conditional recipients — out of scope per original ask.
- Whether `action_log` should persist the *resolved* `to` for auditability —
  flagged in Milestone 4, not blocking; a follow-on issue if the answer is yes.
- Reusing/generalizing the double-brace `PartsField` component for this
  instead of a lighter bespoke picker — decided against for v1 (different
  templating syntax/semantics, not worth coupling); revisit only if a third
  single-brace-templatable field type appears.

## Rollout

Template-owned (`services/api/`, `services/_plugins/orchestrator/`) — build
and merge in `biffo-template` (this repo), then distribute to `tabsii-platform`
via `biffo core upgrade` per the project's existing distribution pattern
(prior orchestration-engine features #216-#221 all followed this path). Portal
page is user-owned (`apps/`) — copy-in to tabsii, same as prior orchestration
UI changes (#209/#120 precedent). No infra/Terraform change, no new migration,
so no special deploy sequencing beyond the normal core-upgrade → copy-in →
CI-green → merge flow.
