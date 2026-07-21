# Orchestrator plugin

Event-driven orchestration engine (ADR-0003 plugin). It subscribes to platform
EventBridge events and dispatches actions (email, Google Chat, WhatsApp today;
more channels later) based on **workflow definitions stored in the Core API**.

Actions are registered in `src/orchestrator/actions.py` (`ACTION_HANDLERS`) and
must have a matching entry in the Core builder catalog
(`services/api/.../schemas/orchestration.WORKFLOW_ACTIONS`) so they can be
configured in the portal.

### WhatsApp credentials come from SSM

WhatsApp needs account credentials, and the Lambda carries only their **SSM
parameter names** — `WHATSAPP_ACCESS_TOKEN_PARAMETER` and
`WHATSAPP_PHONE_NUMBER_ID_PARAMETER` (Terraform vars
`whatsapp_access_token_parameter` / `whatsapp_phone_number_id_parameter`). The
engine resolves them once per cold start. A token passed as a Terraform variable
would sit in state and in the function's configuration; a parameter name does
neither. Store the token as a `SecureString`:

```bash
aws ssm put-parameter --type SecureString \
  --name /myproject/dev/whatsapp/access-token --value "<token>"
aws ssm put-parameter --type String \
  --name /myproject/dev/whatsapp/phone-number-id --value "<phone-number-id>"
```

The module grants `ssm:GetParameter` on exactly those two parameters, plus
`kms:Decrypt` fenced by a `kms:ViaService` condition so it grants nothing
outside an SSM fetch. Leave the names empty to disable WhatsApp; a fetch that
fails (missing parameter, denied permission) is logged and leaves the action
reporting itself unconfigured, so a broken WhatsApp setup never stops email,
Chat or agent workflows.

### WhatsApp: text vs template

The `whatsapp` action's `message_type` picks the shape Meta receives:

| `message_type`   | Config                                                                | When it delivers                                                             |
| ---------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `text` (default) | `message` (a `{field}` template)                                      | Only inside an **open 24-hour customer service window** — i.e. replies only. |
| `template`       | `template_name`, `language_code` (default `en_US`), `template_params` | Any time, including **proactive/business-initiated** sends.                  |

`template_params` is the template's ordered body variables — a comma-separated
list (or a JSON array via the API), each entry a `{field}` template filled from
the event payload. They map positionally onto the template's `{{1}}`, `{{2}}`, …
placeholders, so **order matters** and the count must match what the approved
template declares; Meta rejects a mismatch.

**Prerequisite: the template must already be approved in Meta.** Create it in
WhatsApp Manager (Account tools → Message templates) and wait for approval
before pointing a workflow at it — this action only _sends_ templates, it cannot
create or submit one. A `template_name` that does not exist, is not approved, or
is approved in a different language than `language_code` comes back as a 400 from
the Cloud API and is recorded as a failed run.

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
- **Transient action failures are retried in-process** — 3 attempts, 0.5s then
  1.0s backoff. It has to be in-process: the run is claimed in Core _before_ the
  action executes, so a redelivered event comes back `created=false` and is
  skipped. EventBridge retry and the DLQ only ever covered the Core call, never
  the action. Only a `TransientActionError` retries (throttling, 429/5xx, a
  connection that never completed); a permanent failure — a rejected recipient,
  a missing config key, a revoked webhook's 403, Core's 409 depth-ceiling
  refusal — fails on the first attempt. The attempt count is recorded on the
  action log, so a flaky channel is visible in history.

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
4. **WhatsApp (optional)**: put the credentials in SSM and pass
   `whatsapp_access_token_parameter` / `whatsapp_phone_number_id_parameter`.
   These replaced the old `whatsapp_access_token` / `whatsapp_phone_number_id`
   variables, which put the token in Terraform state — an instance still wiring
   those must switch, or `terraform plan` fails on an unsupported argument.
5. **Seed** at least one workflow definition (DDL import) matching a live event.

## Tests

`uv run pytest services/_plugins/orchestrator/tests` — signing, the email action, the full
event→claim→act→record flow (Core API and SES faked), idempotent replay skip, and
failure recording.
