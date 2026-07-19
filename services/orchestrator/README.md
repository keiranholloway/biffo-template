# Orchestrator plugin

Event-driven orchestration engine (ADR-0003 plugin). It subscribes to platform
EventBridge events and dispatches actions (email, Google Chat, WhatsApp today;
more channels later) based on **workflow definitions stored in the Core API**.

Actions are registered in `src/orchestrator/actions.py` (`ACTION_HANDLERS`) and
must have a matching entry in the Core builder catalog
(`services/api/.../schemas/orchestration.WORKFLOW_ACTIONS`) so they can be
configured in the portal. WhatsApp needs account credentials on the Lambda:
set `WHATSAPP_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` (Terraform vars
`whatsapp_access_token` / `whatsapp_phone_number_id`); empty disables it. Text
messages only deliver inside an open 24-hour session — proactive template
messages are a follow-up.

## How it fits together

```
EventBridge (biffo.core)  ──►  Orchestrator Lambda (this plugin)
  demo.requested                 1. POST /api/v1/internal/orchestration/events   (SigV4)
                                    → Core matches enabled definitions, claims a run per match (idempotent)
                                 2. run the action for each newly-claimed run     (SES email)
                                 3. POST /runs/{id}/result                        (SigV4)
                                          │
                                          ▼
                                    Core API  (owns all state — definitions, runs, action_log)
```

- **State lives in Core** (ADR-0002). This plugin holds no database; it reads and
  writes through the Core API only.
- **Auth is IAM SigV4** (ADR-0009). The engine calls the Core API's internal
  routes (`/api/v1/internal/*`), which API Gateway protects with `AWS_IAM`. The
  Lambda role signs each request; there is no bearer token or shared secret.
- **Idempotent.** Core claims one run per (definition, event) on a unique dedupe
  key, so an at-least-once / replayed event fires each action exactly once. The
  engine skips runs Core reports as already claimed (`created=false`).

## Layout

- `src/orchestrator/main.py` — Lambda entrypoint (EventBridge → `BiffoEvent` → dispatch).
- `src/orchestrator/plugin.py` — `OrchestratorPlugin`: the event→claim→act→record flow.
- SigV4 signing lives in the shared plugin SDK (`biffo_plugin_sdk.SignedCoreClient`), not here — see ADR-0009 and `packages/python-sdk/`.
- `src/orchestrator/actions.py` — action handler registry; `send_email` (SES) is the wedge.
- `terraform/` — the plugin's infra (copied to `modules/plugins/orchestrator/` on install).

## Workflow definitions

A definition is a row in Core's `orchestration_workflow_definitions`:

| field                 | example                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `trigger_source`      | `biffo.core`                                                                                        |
| `trigger_detail_type` | `demo.requested`                                                                                    |
| `action_type`         | `email`                                                                                             |
| `action_config`       | `{"from":"no-reply@…","to":"sales@…","subject":"New demo from {company}","body":"Contact {email}"}` |
| `enabled`             | `true`                                                                                              |

`{field}` placeholders in `subject`/`body` are filled from the event payload
(missing fields render empty). These are not exposed as generic CRUD yet — seed
them via a DDL import (ADR-0005) until the editing UI lands.

## Instance wiring (what `biffo plugin install` + the instance must set up)

1. **Terraform inputs** for the `module "plugin_orchestrator"` block: `core_api_url`,
   `core_api_execution_arn` (the Core API's `execution_arn`), `event_bus_name`, and
   optionally `ses_identity_arn` (scope to a verified identity).
2. **Allowlist the engine role** on the Core API: add this module's `role_arn`
   output to `BIFFO_SERVICE_PRINCIPAL_ARN_ALLOWLIST` (glob the assumed-role form,
   e.g. `arn:aws:sts::<acct>:assumed-role/<role-name>/*`) — see ADR-0009.
3. **SES**: verify a sending identity for `action_config.from`. In the SES sandbox
   (default on new accounts / dev), also verify each recipient or request
   production access.
4. **Seed** at least one workflow definition (DDL import) matching a live event.

## Tests

`uv run pytest services/orchestrator/tests` — signing, the email action, the full
event→claim→act→record flow (Core API and SES faked), idempotent replay skip, and
failure recording.
