# Agentic workers — the mechanism, and what has been proven

ADR-0014 describes the architecture. This records what has actually been
executed against a deployed instance, what it exposed, and the rough edges an
operator will meet. It is deliberately about the **mechanism**, not about model
quality or prompt design — those are separable and come later.

Evidence throughout is six live runs on `tabsii-platform` dev, 2026-07-22.

## The chain

```
public form → POST /api/v1/public/demo-requests
  → Core commits the row, emits demo.requested            (post-commit buffer)
  → orchestrator matches a WorkflowDefinition
  → its `agent` action POSTs to /api/v1/internal/agent-runs  (SigV4, ADR-0009)
  → Core persists the run (status=pending), emits agent.run.requested
  → agent-runtime Lambda picks it up from EventBridge
  → resolves the OpenRouter key from SSM, calls the model
  → POSTs the result to /agent-runs/{id}/complete
  → Core persists and emits agent.run.completed
```

Every leg executed. End-to-end latency was 11–15s for a single-turn run.

## What this proved

- **The SigV4 hop works against a new internal route.** This was the leg most
  likely to fail and it did not: the orchestrator's Lambda role reaches
  `/api/v1/internal/agent-runs` through the ADR-0009 allowlist.
- **Core emits, the runtime never does** (ADR-0014 §5). Both events originate
  from Core's post-commit buffer.
- **Events carry a reference, not the payload.** Observed on the bus:
  `{run_id, agent, status, causation_id, depth}` — no assessment text, no
  transcript. The claim-check holds in practice, not just in tests.
- **The loop guard threads correctly.** `depth: 0`, `causation_id: null` on a
  root run, which is what makes the Core-side ceiling reachable at all.
- **Run provenance is real.** Every run recorded the resolved model, turn count,
  finish reason, token counts and cost. This is what caught the defect below,
  and it cannot be reconstructed after the fact (§10).
- **Cost is visible per run.** ~$0.018 single-turn without search; ~$0.029–0.037
  with `:online`, driven almost entirely by input tokens (349 → ~1900).

## Rough edges an operator will meet

### A disabled workflow fails silently

The sharpest one. A workflow that stops matching — disabled, or its trigger
edited — produces **no signal at all**: the triggering event still arrives at the
orchestrator, which logs `Received event` and nothing further. No error, no
warning, no run row. Both deploy workflows stay green.

Observed twice in one session: a definition was inadvertently disabled during an
edit, and two subsequent requests produced no run, with no trace beyond their
absence. Diagnosing it required reading orchestrator logs and noticing that
`agent.run.requested` never followed `demo.requested`.

Editing a definition while events are in flight drops those events for the same
reason.

**What this does and does not cost.** The triggering record is safe — it was
committed before the event was emitted — and any *other* workflow on the same
trigger still fires, so a notification path is unaffected by an unrelated
definition being disabled. For an enrichment worker, what is lost is an
enhancement to a record that is stored and surfaced elsewhere.

The reason to care anyway is that the mechanism is workflow-agnostic while the
blast radius is not: the same silent failure on a workflow that is the *only*
path by which a human learns something gives exactly the same signal — none.
And the diagnostic cost applies either way, because every surface an operator
normally checks reports healthy. Tracked as #418.

### `:online` bypasses the tool loop entirely

Appending `:online` to an OpenRouter model slug adds web search with **no code
change** — the runtime passes the model string through untouched. It is the
cheapest possible way to find out whether search helps.

But search happens inside OpenRouter, before the model sees the prompt, so:

- `finish_reason` is `stop` and `turns` is 1 — the runtime's tool seam is never
  exercised, and nothing about the M3 tool design is validated by using it.
- Results are injected as trusted context. They cannot be wrapped in the
  `<untrusted-context>` fencing the runtime applies to the triggering payload,
  even though a search result is at least as attacker-influenceable as a form
  field. This is the gap the M3 `web_search` tool closes: a result that arrives
  through the tool loop is fenced as `<untrusted-tool-result tool="…">`,
  redacted, and framed as untrusted in the system message. A result injected by
  `:online` is none of those things, because the runtime never sees it.
- Input size is not observable or boundable. With a 1M-token context and
  server-side injection, the §8 token ceiling has a blind spot specific to this
  mode.

Fine as an experiment. Not a design to ship behind anything that acts on the
output.

### A run's full output is not readable from logs

CloudWatch shows the head and tail of a completion but truncates the middle —
SQLAlchemy's logger caps bound-parameter length. Reading an entire assessment
needs the API or the run-inspection UI (ADR-0014 M5), neither of which exists
yet. Expect to see `... (1770 characters truncated) ...` in the middle of the
thing you most want to read.

Log lag is also real: completion rows took 45–70s to surface after the run had
demonstrably finished on the bus.

### The model field defaults to the most expensive option

`model` is `required` **with a default**, and Core's validator treats a default
as satisfying required — so a blank field silently runs and bills the default.
The first live run used Claude Opus when Kimi K3 had been chosen, with nothing
surfacing that a choice had been made on the operator's behalf. Tracked as #414.

This is only detectable through the run snapshot or the invoice, because the
output is *correct*, just more expensive.

## Operating notes

- **Verify a workflow dispatches after editing it.** Fire one event and confirm
  `agent.run.requested` follows `demo.requested` in the orchestrator log. Given
  the silent-disable behaviour above, this is the only reliable check.
- **Read the run's recorded model**, not the workflow form, to know what ran.
- **Watch input tokens, not output,** when search is involved — that is where the
  cost moves.

## What remains unexercised

Recorded so nobody mistakes M1 for more than it is:

- The **tool seam** is implemented as of M3 — a registry, a `web_search` tool and
  fenced tool results — and is covered by tests, but **no live run has exercised
  it**. The evidence above is all M1, and nothing here should be read as saying
  a real model called a real tool against a deployed instance. That takes a
  Brave key in SSM, a worker declaring `tools: ["web_search"]` with `max_turns`
  of at least 2, and someone watching a run.
- **Multi-turn.** Every run so far is `turns: 1`.
- **§7's read-scope ceiling.** No worker has read a Core table; the payload
  arrives in the event. The permission model is designed and deployed but
  unexercised.
- **`run_as: user`.** Every run is `system`.
