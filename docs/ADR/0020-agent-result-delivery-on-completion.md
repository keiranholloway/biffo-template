# ADR-0020: Deliver an agent's result on completion

**Status:** Accepted  
**Date:** 2026-07-24  
**Deciders:** Core team

---

## Context

An agent workflow (ADR-0014) runs an agentic worker and records its result on the
`AgentRun`, but the result goes nowhere a human sees. A founder who builds an
agent to triage inbound demos, or to draft a reply, wants the outcome delivered —
to their inbox, to a Slack channel, to Google Chat — the moment the run finishes.

The orchestration engine already has everything the plumbing needs:

- **Delivery executors.** The engine ships `email` / `google_chat` / `whatsapp`
  action handlers that take a config and send a templated message
  (`services/_plugins/orchestrator/.../actions.py`).
- **A completion event.** Every agent run emits `agent.run.completed` (success
  *and* failure) from `POST /api/v1/internal/agent-runs/{id}/complete`
  (ADR-0014 §5). The engine already subscribes to every event.
- **An authenticated read path.** The completion event carries only a *reference*
  (`{run_id, agent, status, causation_id, depth}`) — the transcript and output are
  LLM-derived from attacker-influenceable input and stay behind the internal API
  (ADR-0014 §5, security model). The engine already reaches that API over IAM
  SigV4 (ADR-0009).

So "deliver the result somewhere" needs a contract for *where*, and a reaction
that wires the completion event to the existing executors. It does **not** need
new run-lifecycle plumbing, and it should not become a general multi-step workflow
engine before we know we need one.

The decided shape (confirmed with the owner) is **delivery as a property of the
agent action**, not a second workflow step.

## Decision

Deliver an agent run's result to a configured destination when the run **succeeds**,
as an optional sub-config of the agent action.

1. **`delivery` sub-config on the agent action.** The agent action's
   `action_config` gains an optional `delivery` of the shape
   `{ "type": <destination>, "config": { … } }`. `type` is one of the delivery
   destinations (`email`, `slack`, `google_chat`, `whatsapp`); `config` is
   validated against **that destination's own `config_fields`** — reused, not
   duplicated. Absent ⇒ no delivery (today's behaviour, unchanged). The whole
   resolved config, `delivery` included, is snapshotted onto the run
   (`definition_snapshot`, ADR-0014 §10), so a run records the destination it was
   asked to deliver to.

2. **`{output}` templating.** The destination's message field (its `output_body`:
   `body` for email, `message` for the webhook channels) supports an `{output}`
   placeholder for the agent's result. In a delivery it is **optional** and
   defaults to `{output}` — so a delivery with no template sends the raw result.
   Rendering reuses the executors' existing `{field}` substitution, with a payload
   that exposes `{output}`, `{agent}`, `{run_id}`, `{status}`.

3. **Reaction on `agent.run.completed`.** The orchestrator subscribes to
   `agent.run.completed`. For a **succeeded** run it fetches the run over the
   internal API (the event is a reference only), reads `definition_snapshot.delivery`
   and the run's `result.output`, renders the message, and invokes the matching
   executor. No delivery config, or a run that did not succeed, delivers nothing.

4. **Add a Slack executor, reuse the rest.** A new `slack` executor posts
   `{"text": …}` to a Slack incoming-webhook URL, mirroring `google_chat`. It is
   registered in the engine's `ACTION_HANDLERS` and exposed as a standalone action
   type too, so Slack is available both as a workflow action and as a delivery
   destination. The webhook URL is a `secret: True` config field, redacted on every
   read like the Google Chat webhook (#432) — including when it lives nested inside
   a `delivery.config`.

## Options Considered

### Option A — General multi-step workflows

Make delivery a second step in a workflow: `trigger → run agent → deliver result`,
with the engine carrying an output between steps.

**Pros:**

- Fully general: any action could consume any prior action's output; delivery is
  just one case.
- No special-casing of the agent action.

**Cons:**

- A workflow today is one trigger → one action → one run. Multi-step means a step
  graph, inter-step data flow, partial-failure semantics, and a much larger portal
  surface — none of which the current builder or run model expresses.
- It is a speculative generalisation: we want *deliver the result*, and we don't
  yet have a second, different multi-step need to validate the abstraction against.
- It would delay the concrete capability behind a large, uncertain redesign.

### Option B — Delivery as a sub-config of the agent action (chosen)

Delivery is a property of the agent action, executed by reacting to the run's
existing completion event and reusing the existing executors.

**Pros:**

- Small and concrete: no new run-lifecycle plumbing, no step graph. It reuses the
  completion event, the internal read path, and the executors that already exist.
- One workflow, one run — the mental model the builder already presents. "This
  agent, and when it's done, tell me here."
- The `delivery` contract is a clean, self-contained thing a portal PR can consume,
  and a future Option-A generalisation can still supersede it.

**Cons:**

- Delivery is coupled to the agent action rather than being a first-class step.
- Only the agent action gets delivery; a non-agent action wanting the same would
  need its own seam or the Option-A generalisation.

## Rationale

Option B ships the capability the owner asked for against machinery that already
exists, with a validation contract precise enough for the portal to build on — and
it does not foreclose Option A. The deciding factor was that every piece Option B
needs (completion event, authenticated fetch, executors) is already in place, so the
work is a contract plus a reaction, not a new engine. A general step engine is a
real future option, but building it now would be a speculative abstraction with one
example.

Delivering only on **success** for the MVP keeps the first cut unambiguous. Failure
notification is a genuinely different UX (what do you say, and to whom, when a run
fails?) and is deferred behind a clean seam rather than half-built.

## Consequences

### Positive

- A founder gets the agent's result where they work — inbox, Slack, Chat, WhatsApp
  — by configuring one field on the agent, with no code.
- Reuses the completion event and the executors; the only new executor is Slack,
  which mirrors an existing one.
- The `delivery` config is a defined contract (`{type, config}` + `{output}`
  templating) that the portal builds against precisely.
- Nested delivery webhooks are redacted through the same single funnel as top-level
  secrets (#432), so the security posture does not regress through the new seam.

### Negative / Trade-offs

- Delivery is out-of-band of the workflow-run audit log: there is no `WorkflowRun`
  for a delivery, so its outcome is logged, not recorded as an auditable run.
- `agent.run.completed` delivery is **at-least-once**: EventBridge may redeliver the
  completion event, and delivery has no claim/dedupe of its own, so a rare
  redelivery can send a duplicate message. Acceptable for the MVP; a delivery-claim
  record would close it if it proves a problem.
- Delivery is coupled to the agent action (see Option B cons).

### Neutral

- **Internal-inbox destination — deferred.** An in-product inbox is a separate
  surface (its own storage and read model) and is explicitly not built here.
- **Failure notification — deferred.** The MVP delivers only on a succeeded run.
  The reaction has a marked seam (`deliver_on_completion`, the status gate) where
  on-failure handling will branch; there is no failure-notify logic today.
- A future Option-A multi-step generalisation remains open and could subsume this
  sub-config.

## Compliance

- **Contract validation.** `WorkflowDefinitionBody` validates a `delivery` sub-config
  on create/update against `DELIVERY_ACTION_TYPES` and the destination's
  `config_fields` (`services/api/src/api/schemas/orchestration.py`). A malformed
  delivery is a 422.
- **Secret redaction (#432).** `redact_secrets` / `resolve_write_secrets` recurse into
  `delivery.config`, so a Slack or Google Chat webhook stored inside a delivery is
  masked on every read and kept-on-unchanged on write, exactly like a top-level one.
- **Handler/catalog parity.** The Slack executor is registered in `ACTION_HANDLERS`
  and declared in `WORKFLOW_ACTIONS`; the orchestrator's `agent.run.completed`
  reaction (`deliver_on_completion`) delivers only on `status == "completed"` and only
  when the snapshot carries a `delivery`.
- **Tests.** Delivery config validation per type and rejection of malformed configs,
  the succeeded/failed/no-delivery paths, the Slack webhook payload, nested-secret
  redaction, and tenant isolation are covered in the Core and orchestrator suites.

## Related Decisions

- **ADR-0014** (Agentic worker framework) — the agent action, the run lifecycle, the
  `agent.run.completed` reference event, and the `definition_snapshot`.
- **ADR-0009** (Internal service authentication) — the SigV4 path the orchestrator
  uses to fetch the run.
- **ADR-0010** (Event registry) — the engine's generic event forwarding, alongside
  which this dedicated subscription runs.
- **ADR-0002** (API-only data integration) — the orchestrator holds no state and
  reads the run over the API, not the database.
