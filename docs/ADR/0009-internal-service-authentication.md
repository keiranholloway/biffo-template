# ADR-0009: Internal Service-to-Service Authentication (inbound, IAM SigV4)

**Status:** Accepted
**Date:** 2026-07-06
**Amended:** 2026-07-19 — see [Amendment history](#amendment-history)
**Deciders:** Keiran Holloway (Technical Architect)

---

## Context

ADR-0003 plugins run their non-CRUD/event/background logic in their **own**
Lambda, separate from the Core API. Some of those plugins — the orchestration
engine being the first (see the orchestration feature) — must **call into** the
Core API to read and mutate state, because ADR-0002 forbids any component but
the Core API from touching the database. They are **machine callers with no
Cognito user identity**: they react to EventBridge events, not to a logged-in
user's request, so they have no ID token to present.

Today there is **no way for such a caller to authenticate to the Core API.** The
SDK's `BiffoAPIClient` expects a `BIFFO_JWT_TOKEN` bearer token that nothing
issues or wires (the `modules/plugins/_template` Terraform never sets it). Every protected
Core route sits behind API Gateway's Cognito **JWT** authorizer, which only
accepts user pool ID tokens.

The obvious fix — Cognito **machine-to-machine** (client-credentials) tokens — is
**blocked in the `dev` environment**: client-credentials tokens are issued only
from the user pool's hosted **domain** (`/oauth2/token`), but `dev` deliberately
has **no domain** (`modules/cloud/aws/auth/main.tf`, `count = ... "dev" ? 0 : 1`)
because a domain disables the `cognito-idp` PrivateLink endpoint the NAT-less dev
VPC relies on for Cognito admin calls. dev is the environment the platform is
exercised in, so an auth mechanism that can't work there is a non-starter.

This ADR decides how a background actor authenticates **into** the Core API. It
is the inbound complement to ADR-0008's outbound decision (Core API → PR-signer),
and it reuses that ADR's core principle: **internal trust is IAM, not a shared
secret.**

## Decision

Add a dedicated internal surface on the Core API authenticated with **AWS SigV4
(IAM)**, not Cognito:

1. **Dedicated routes.** Service-only endpoints live under `/api/v1/internal/*`.
   API Gateway protects them with `authorization_type = AWS_IAM` (a single
   greedy route `ANY /api/v1/internal/{proxy+}`), which is more specific than the
   Cognito-JWT `$default` route and so takes precedence for that prefix. The
   caller signs each request with SigV4; API Gateway verifies the signature and
   resolves the caller's IAM principal **before** invoking the Lambda.

2. **Least-privilege grant.** A calling plugin's Lambda **execution role** is
   granted `execute-api:Invoke` scoped to `.../api/v1/internal/*` on the Core
   API and nothing else. Only principals the instance has explicitly granted can
   even reach these routes. The grant lives in the _caller's_ Terraform (the
   plugin), not the Core API.

3. **Identity + allowlist at the boundary.** The Core API reads the
   SigV4-verified principal from `requestContext.authorizer.iam.userArn` (exposed
   to FastAPI via Mangum's `request.scope["aws.event"]`) and turns it into a
   `ServicePrincipal`. It additionally checks the ARN against a configured
   **allowlist** (`BIFFO_SERVICE_PRINCIPAL_ARN_ALLOWLIST`), so authorization is
   defense-in-depth: API Gateway IAM is the gate, and the app re-checks which
   principal got through. The allowlist **fails closed** — empty means no service
   caller is accepted.

`ServicePrincipal` is tenant-scoped to `"default"` (ADR-0001) and carries no
Cognito groups; internal routes authorize by _being_ an allowlisted service, not
by role membership. `require_service_principal` is the single FastAPI dependency
every internal route depends on — the one seam where service authorization is
enforced.

## Options Considered

### Cognito M2M (client-credentials) — rejected

The "textbook" answer, and it works on staging/prod. **Rejected** because it
cannot work on `dev` (no user pool domain, see Context), and dev is where the
platform is exercised and E2E-tested. Adding a domain to dev to enable it would
disable the `cognito-idp` PrivateLink endpoint dev depends on — regressing user
management to fix service auth. A mechanism uniform across all environments is
worth more than reusing the Cognito token path.

### Direct Lambda invoke (IAM) — rejected

The caller invokes the Core API Lambda directly (`lambda:InvokeFunction`) with a
synthetic event, like the existing `biffo:db-init` / `biffo:ddl-import` branches.
Fully IAM-secured and domain-free. **Rejected** as the default because it is
RPC-shaped, bypasses API Gateway (and thus the HTTP/router/observability surface
the rest of the platform uses), and would fork the plugin call path away from the
HTTP `BiffoAPIClient` model. Kept in mind as a fallback for calls that must avoid
API Gateway.

### Shared secret (Secrets Manager) — rejected

An `X-Biffo-Service-Token` header on `authorization_type = NONE` routes, verified
against a Secrets Manager secret. Simplest code, works on dev. **Rejected**
because it introduces a long-lived shared secret (rotation burden, logging/leak
risk) and internet-exposed unauthenticated-at-the-edge routes — strictly weaker
than IAM, and inconsistent with ADR-0008's "IAM, not a shared secret" principle.

## Rationale

IAM SigV4 is the only option that is **uniform across every environment**
(no dependency on a Cognito domain), uses **AWS-native identity with no
long-lived secret to store, rotate, or leak**, keeps the plugin→Core path as
ordinary **HTTP through API Gateway** (so the SDK client, routing, and access
logs all still apply), and is **consistent with ADR-0008** (internal trust is
IAM). The app-level allowlist adds defense in depth so the blast radius of a
misconfigured IAM grant is bounded.

## Consequences

### Positive

- Resolves the platform's missing plugin→Core auth with one reusable
  mechanism every future plugin can adopt. _(As originally accepted this was
  aspirational — the signing code existed only inside the orchestrator. It
  became true on 2026-07-19; see [Amendment history](#amendment-history).)_
- No secret to manage; identity is the caller's IAM role. Works identically on
  dev, staging, and prod.
- Internal surface is explicitly separated (`/api/v1/internal/*`) from the
  user-facing API, so its threat model and audit are distinct.

### Negative / Trade-offs

- The caller must SigV4-sign its requests (a small amount of signing code / a
  signing dependency) rather than attaching a bearer token.
- Reading the IAM principal couples the internal dependency to the Mangum/API
  Gateway event shape (`request.scope["aws.event"]`). Encapsulated in one helper.
- Local development / tests have no `aws.event`, so `require_service_principal`
  fails closed there; internal routes are exercised via dependency override in
  tests and via real IAM in deployed environments.

### Neutral

- The `/api/v1/internal/{proxy+}` IAM route is always created by the api-gateway
  module but is inert until (a) the Core API mounts an internal route and (b) a
  caller is both granted `execute-api:Invoke` and added to the allowlist.

## Security model

- **Edge gate is IAM.** API Gateway verifies SigV4 and the caller's
  `execute-api:Invoke` permission before the Lambda runs. An unsigned or
  unauthorized request never reaches application code.
- **App re-checks the principal.** `require_service_principal` independently
  confirms the resolved `userArn` is on the allowlist; a grant added by mistake
  still doesn't authorize a caller the allowlist doesn't name. Fails closed on an
  empty allowlist or a missing IAM context.
- **No secret material.** There is no bearer token, API key, or shared secret in
  env vars, logs, or the repo — the credential is the caller's IAM role, assumed
  at runtime by AWS.
- **Least privilege.** Callers are granted `execute-api:Invoke` on the
  `/api/v1/internal/*` prefix only, not the whole API, and hold no DB credential
  (ADR-0002).
- **Separated surface.** Internal routes are namespaced and IAM-only; the
  user-facing API remains Cognito-JWT-only. Neither authorizer can satisfy the
  other's routes.

## Related Decisions

- [ADR-0008](0008-endpoint-control-plane.md) — outbound internal trust (Core API
  → PR-signer) over IAM; this ADR is the inbound complement and shares the
  "IAM, not a shared secret" principle.
- [ADR-0002](0002-api-only-data-integration-pattern.md) — why a plugin must call
  the Core API at all (it may not touch the database); this ADR is how it does so
  as a machine caller.
- [ADR-0003](0003-plugin-system-and-marketplace.md) — plugins whose background
  Lambda needs to call the Core API; the `BiffoAPIClient` `BIFFO_JWT_TOKEN` gap
  this closes. `BIFFO_JWT_TOKEN` was removed from the SDK on 2026-07-19 rather
  than left as a never-issued fallback; see [Amendment history](#amendment-history).
- [ADR-0001](0001-single-tenant-architecture-with-multi-tenant-seam.md) — the
  `ServicePrincipal` is tenant-scoped to `"default"` like every other identity.

## Amendment history

### 2026-07-19 — the "reusable mechanism" is now actually reusable

**What was wrong.** As accepted, this ADR read as though plugin→Core auth was
solved platform-wide. Two claims were false in the code:

- _Consequences → Positive_: "one reusable mechanism every future plugin can
  adopt". The signing implementation was written once, inside
  `services/orchestrator/src/orchestrator/signed_client.py`, and never promoted.
  `packages/python-sdk/` contained no SigV4 or `botocore` reference at all, so
  "every future plugin" would have had to re-implement request signing.
- _Related Decisions_: the `BIFFO_JWT_TOKEN` gap "this closes". It closed for the
  orchestrator only. Every other SDK consumer still got `self.token = None`,
  `_auth_headers()` returning `{}`, and unauthenticated calls against a
  protected API — while `client.py`'s own docstring claimed the CLI set that
  token during `biffo plugin install`, which no CLI code has ever done.

An Accepted ADR asserting a security mechanism the code contradicts is the worst
form of this drift: a reader concludes machine callers have working auth, and the
code they get does not. Issues #194 and #197 both traced back to it.

**What changed (issue #197).** The claims were made true rather than downgraded:

1. `SignedCoreClient` moved from `services/orchestrator/` into
   `packages/python-sdk/src/biffo_plugin_sdk/signed_client.py` and is exported
   from `biffo_plugin_sdk`. The orchestrator now imports it from the SDK — there
   is exactly one implementation.
2. `botocore` is an optional extra (`biffo-plugin-sdk[sigv4]`), imported lazily.
   It is preinstalled in the AWS Lambda Python runtime, so deployed plugins gain
   no runtime dependency and `import biffo_plugin_sdk` still works without it.
3. **SigV4 is the default, not an opt-in.** `create_core_client()` builds a
   `SignedCoreClient` unless `BIFFO_CORE_AUTH_MODE=none`, and
   `BiffoPluginBase.__init__` uses it for `self.api`. A plugin author who does
   nothing now gets a signing client. An opt-in class would have left the
   default path silently unauthenticated — the exact trap this amendment exists
   to remove.
4. `BIFFO_JWT_TOKEN` is **no longer read from the environment**. A bearer token
   nothing issues is not a fallback, it is a trap on the SDK's public surface:
   it made an unauthenticated client look authenticated. `token=` survives as an
   explicit constructor argument for the distinct case of calling a _user-facing_
   Cognito-protected route with a JWT the caller already holds. The false
   docstring at `client.py:35-38` is gone.
5. `modules/plugins/_template` gained an optional `core_api_execution_arn` input
   that grants the plugin's Lambda role `execute-api:Invoke` scoped to
   `/api/v1/internal/*`, plus a `role_name` output and documentation for the
   `BIFFO_SERVICE_PRINCIPAL_ARN_ALLOWLIST` entry.

**What remains open.** The allowlist side is still **manual**. The Core API's
`BIFFO_SERVICE_PRINCIPAL_ARN_ALLOWLIST` must be populated by the instance with a
static assumed-role glob (`arn:aws:sts::<acct>:assumed-role/<project>-<env>-plugin-<name>-role/*`),
not wired from the plugin module's `role_arn` output. Doing the latter would
create the Terraform dependency cycle `core_api → api_gateway → plugin →
core_api` tracked in issue #201. Until #201 resolves that, step 3 of the
mechanism is a documented human step, and a plugin that skips it gets a `403`
from `require_service_principal` — failing closed, which is the correct
direction, but not zero-configuration.
