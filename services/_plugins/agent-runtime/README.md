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

## What M1 is, and what the shape already allows

M1 is a walking skeleton: **one LLM call, no tools, no memory** (§9 defers all
of it). The _shape_ is not provisional, because §6 lists the choices that are
cheap now and expensive later:

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
  model wants another; M3 fills the tool-execution seam inside it.

## Configuration

| Env var                        | Set by                            | Purpose                                                       |
| ------------------------------ | --------------------------------- | ------------------------------------------------------------- |
| `BIFFO_CORE_API_URL`           | Terraform                         | Core API base URL for the signed client.                       |
| `OPENROUTER_API_KEY_PARAMETER` | Terraform (`terraform/`)          | SSM SecureString parameter *name*; read at first use, cached.  |
| `OPENROUTER_API_KEY`           | local runs / tests only           | Direct key. Takes precedence; never set this in a deployment.  |
| `AGENT_RUNTIME_MAX_SECONDS`    | Terraform (`run_timeout_seconds`) | Deployment wall-clock ceiling (§8). Default 240.               |
| `AGENT_RUNTIME_MAX_TURNS`      | Terraform (`max_turns_ceiling`)   | Deployment turn ceiling (§8). Default 10.                      |

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

## Security posture

- **Untrusted input is structurally separated from instructions.** The trigger
  payload comes from a public form, so it lands in its own fenced `user` message
  and is never concatenated into the system prompt. See `messages.py`.
- **Email addresses are redacted before anything leaves the platform**, in the
  runtime rather than in a prompt, "so it cannot be forgotten in a prompt"
  (§ Security model). See `redaction.py`. Name, company and role survive
  redaction and remain personal data.
- **No write surface** (§7). The runtime's only write is completing its own run,
  through a purpose-built internal route. It never touches business tables.

## Known gaps (recorded, not hidden)

- **The `pending → running` transition is runtime-local.** Core's internal
  agent-run API is create / read / complete — there is no claim route — so the
  row stays `pending` until the run terminates. Consequences: a duplicate event
  delivery cannot be de-duplicated across invocations, and a runtime killed
  mid-run leaves the row `pending` rather than `running`. This is the same class
  as §5's "second divergence point" and needs a Core claim route plus the
  stale-run reaper §5 already calls for.
- **A completion POST that fails strands the run** — the model work is paid for
  and Core holds no result. Logged at error level (`run is stranded`) so it can
  be alarmed on, which is what §5 asks for pending a retry/outbox.

## Layout

- `src/agent_runtime/main.py` — Lambda entrypoint (EventBridge → `BiffoEvent` → dispatch).
- `src/agent_runtime/plugin.py` — claim, execute, report. The flow.
- `src/agent_runtime/loop.py` — the turn loop, its events, and the §8 hard stops.
- `src/agent_runtime/messages.py` — the message array and the untrusted-context channel.
- `src/agent_runtime/redaction.py` — email redaction on the path to the model.
- `src/agent_runtime/openrouter.py` — the provider boundary and credential resolution.
- `src/agent_runtime/state.py` — the run state machine.
- `terraform/` — Lambda, IAM (Core API + one secret), EventBridge rule.
- `tests/` — fakes only; no live network, no real AWS, no real provider.
