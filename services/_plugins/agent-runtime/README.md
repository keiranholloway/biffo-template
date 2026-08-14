# Agent runtime plugin

The **execution half** of the agentic-worker framework ([ADR-0014](../../../docs/ADR/0014-agentic-worker-framework.md)).
It subscribes to one event, runs one agent run, and reports the outcome to Core.

The framework is first-party platform capability split across three homes, and
this is the third:

| Concern                                    | Where                                        |
| ------------------------------------------ | -------------------------------------------- |
| Agent definitions, runs (tables + API)     | `services/api/` — core                       |
| Authoring and run-inspection UI            | `apps/portal/` — core portal                 |
| **The execution runtime (LLM loop)**       | **`services/_plugins/agent-runtime/` — here** |

It is plugin-_shaped_, not a marketplace plugin: `services/_plugins/` is
template-owned, so it is distributed by `biffo core upgrade` (ADR-0006, #243),
never `biffo plugin install`.

## How it fits together

```
EventBridge (biffo.core / agent.run.requested)  ──►  Agent runtime Lambda (this plugin)
  emitted by Core when the orchestrator's           1. GET  /api/v1/internal/agent-runs/{id}   (SigV4)
  `agent` action requests a run                        → the resolved definition + input to execute
                                                    2. one turn loop against OpenRouter
                                                       model from the run's definition_snapshot
                                                    3. POST /agent-runs/{id}/complete           (SigV4)
                                                              │
                                                              ▼
                                                        Core API  — persists the run and emits
                                                        agent.run.completed (§5: Core emits, not us)
```

- **Owns no data** (ADR-0002). No tables, no API routes, no database client;
  every byte of run state is Core's.
- **Auth is IAM SigV4** (ADR-0009), via the SDK's `SignedCoreClient`. No bearer
  token, nothing to rotate.
- **Invocation is EventBridge and only EventBridge** (§4). There is no
  synchronous entry point, and re-running a worker means emitting an event.

## What M1 was, and what the shape already allowed

M1 was a walking skeleton: **one LLM call, no tools, no memory** (§9 still defers
memory). M3 filled the tool seam without touching the control flow, which is the
evidence for the claim below rather than a restatement of it. The _shape_ is not
provisional, because §6 lists the choices that are cheap now and expensive later:

- **A message array, not a prompt/response pair.** `messages.py` builds an
  ordered list the run persists; thread history and streaming are both "append
  to this list".
- **An explicit state machine.** `state.py` is the transition table:
  `pending → running → completed | failed`. A run is executable only from
  `pending`, and terminal states have no exits.
- **An internally incremental loop.** `AgentLoop.stream` yields a `TurnEvent`
  per step; `collect()` folds them into the completion body. Streaming (§6.3)
  becomes a second consumer, not a rewrite. `max_turns > 1` is a config change —
  the loop is already a bounded `while` that asks after each turn whether the
  model wants another; M3 filled the tool-execution seam inside it, adding a
  branch rather than a rewrite.

## Configuration

| Env var                          | Set by                            | Purpose                                                                |
| -------------------------------- | --------------------------------- | ---------------------------------------------------------------------- |
| `BIFFO_CORE_API_URL`             | Terraform                         | Core API base URL for the signed client.                                |
| `OPENROUTER_API_KEY_PARAMETER`   | Terraform (`terraform/`)          | SSM SecureString parameter *name*; read at first use, cached.           |
| `OPENROUTER_API_KEY`             | local runs / tests only           | Direct key. Takes precedence; never set this in a deployment.           |
| `BRAVE_SEARCH_API_KEY_PARAMETER` | Terraform (`terraform/`)          | Likewise for `web_search`. Unset ⇒ the tool is not offered at all.      |
| `BRAVE_SEARCH_API_KEY`           | local runs / tests only           | Direct key. Takes precedence; never set this in a deployment.           |
| `AGENT_RUNTIME_MAX_SECONDS`      | Terraform (`run_timeout_seconds`) | Deployment wall-clock ceiling (§8). Default 300.                        |
| `AGENT_RUNTIME_MAX_TURNS`        | Terraform (`max_turns_ceiling`)   | Deployment turn ceiling (§8). Default 10.                               |

**The key is never committed and never logged.** Terraform takes a parameter
name, not a value, so the credential is absent from state and from the Lambda's
environment, and rotates without a deploy. A worker definition never sees it —
it names a model, and provider access stays behind this runtime's client (§1).

### The credential lives in SSM Parameter Store, not Secrets Manager

Deliberate; don't "fix" it back. This is a single API key read once per cold
start, so the features Secrets Manager adds — rotation, versioning,
cross-account resource policies — are all unused, while a secret bills roughly
$0.40/month and a SecureString on the AWS-managed key is free at standard tier.
It also makes the two plugin third-party credentials consistent: the
orchestrator's WhatsApp token already works exactly this way.

Follow the platform's `/<project>/<env>/<component>/<secret>` naming (the same
shape as `db/credentials` and `pr-signer/github-app-key`):

```bash
aws ssm put-parameter --type SecureString \
  --name /myproject/dev/agent-runtime/openrouter-api-key --value "<key>"
```

then pass that name as the module's `openrouter_api_key_parameter`. The module
grants `ssm:GetParameter` on exactly that parameter plus `kms:Decrypt` fenced by
a `kms:ViaService` condition, so the grant is useless outside an SSM fetch — and
is absent entirely when no parameter is configured. Because a SecureString
holding one key is just a string, the runtime does no JSON unwrapping: whatever
the parameter holds *is* the key.

A worker's own `max_turns` / `timeout_seconds` are read from the run's
`definition_snapshot` and **clamped into** the ceilings above, so editing a
definition can never widen what the runtime will spend. Both are hard stops:
hitting either terminates the run as `failed`, with the transcript so far
attached, because §5 requires a subscriber to tell a finished run from a
curtailed one.

## Tools (M3)

A worker declares the tools it uses in its `definition_snapshot`, **defaulting to
none** (§7):

```json
{ "agent_name": "demo-enricher", "model": "…", "max_turns": 4, "tools": ["web_search"] }
```

- **The registry is the ceiling** (`tools.py`). Tool names resolve against
  `TOOL_REGISTRY` and nowhere else, so adding a capability is a reviewed code
  change — the same shape as the orchestrator's `ACTION_HANDLERS`.
- **A declared tool this build does not register fails the run**, before the
  first model call. Dropping it silently would look identical to a model
  choosing not to call it.
- **A registered tool that is not configured is not offered.** No Brave key ⇒ no
  `web_search` in the request, and the run proceeds without it.
- **`max_turns` must be at least 2** for a tool to be useful: turn 1 asks, turn 2
  uses the answer. A worker offering tools with `max_turns: 1` logs a warning and
  will hit the §8 hard stop.

Two rules bind anything added to the registry, and both are enforced rather than
merely documented — see `tools.py`'s docstring before adding a tool:

1. **Tools are read-only.** An executor receives only its parsed arguments — no
   Core client, no credentials, no session.
2. **No tool may take model-generated text and send it outward.** Registration
   refuses unbounded or oversized string parameters and refuses object/array
   parameters outright; arguments are truncated to the declared bound before the
   executor runs. Web search is the accepted low-bandwidth exception. A
   "fetch this URL" tool is not, and never will be.

## Security posture

- **Untrusted input is structurally separated from instructions.** The trigger
  payload comes from a public form, so it lands in its own fenced `user` message
  and is never concatenated into the system prompt. See `messages.py`.
- **Tool results are fenced too, and treated as more dangerous.** A result comes
  back on the `tool` role the protocol requires, but its content is wrapped in
  `<untrusted-tool-result tool="…">`, redacted, and stripped of anything that
  looks like a fence marker — an attacker authors the *whole* document, it
  arrives after the model is primed, and the `tool` role reads as authoritative.
  `CONTEXT_FRAMING` says so in fixed runtime text a worker cannot edit away.
- **Email addresses are redacted before anything leaves the platform**, in the
  runtime rather than in a prompt, "so it cannot be forgotten in a prompt"
  (§ Security model). See `redaction.py`. Name, company and role survive
  redaction and remain personal data.
- **No write surface** (§7). The runtime's only write is completing its own run,
  through a purpose-built internal route. It never touches business tables.

## Known gaps (recorded, not hidden)

- **A reaped run's cost is not recovered.** The sweep records the run as failed,
  but the tokens it spent before dying are unaccounted — `input_tokens`,
  `output_tokens` and `cost_usd` stay null, because nothing reported them. Spend
  attributed to a reaped run is therefore under-counted.
- **A completion POST that fails is reaped rather than retried.** The model work
  is paid for and Core holds no result, so the sweep eventually fails the run —
  correct for the waiting subscriber, but the *result* is still lost. A
  completion retry or outbox is what would actually save it (§5).

### Closed

- ~~A run killed after claiming never terminates~~ — closed by the scheduled
  sweep (issue #402). `POST /agent-runs/reap` fails runs left in `running` past
  `agent_run_stale_after_seconds` and emits `agent.run.completed` for each, so a
  subscriber is released rather than waiting for ever. Triggered by this
  plugin's own `rate(15 minutes)` EventBridge rule (`terraform/`), on the
  default bus because that is the only one that supports schedules.
- ~~The `pending → running` transition is runtime-local~~ — closed by
  `POST /agent-runs/{id}/claim` (issue #371). Core now arbitrates: a single
  conditional `UPDATE ... WHERE status = 'pending'` means exactly one of N
  concurrent deliveries proceeds, and the losers get 409 **before** the first
  model call. Previously both duplicates called the provider and both were
  billed; only the second *completion* was refused, so the recorded outcome was
  right and the invoice was not.

## Layout

- `src/agent_runtime/main.py` — Lambda entrypoint (EventBridge → `BiffoEvent` → dispatch).
- `src/agent_runtime/plugin.py` — claim, execute, report. The flow.
- `src/agent_runtime/loop.py` — the turn loop, its events, and the §8 hard stops.
- `src/agent_runtime/messages.py` — the message array and the untrusted-context channel.
- `src/agent_runtime/tools.py` — the tool registry, its two rules, and how each failure is loud.
- `src/agent_runtime/search.py` — the `web_search` tool (Brave) and its credential.
- `src/agent_runtime/redaction.py` — email redaction on the path to the model.
- `src/agent_runtime/openrouter.py` — the provider boundary and credential resolution.
- `src/agent_runtime/state.py` — the run state machine.
- `terraform/` — Lambda, IAM (Core API + one secret), EventBridge rule.
- `tests/` — fakes only; no live network, no real AWS, no real provider.
