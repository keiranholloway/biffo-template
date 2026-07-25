# ADR-0018: User-facing plugin hosting — a marketplace plugin as an authenticated sibling

**Status:** Accepted
**Date:** 2026-07-24
**Deciders:** Keiran Holloway (Technical Architect)

> **Superseded in part by [ADR-0021](0021-shared-plugin-hosting.md):**
> the backend hosting shape (§1, per-plugin Lambda) is **superseded** by the shared
> plugin host; see ADR-0021 for the current backend design. The frontend hosting
> pattern (§2, path-routed S3 + CloudFront) remains current and is reused by
> ADR-0021; full retirement of this ADR's per-plugin backend hosting is tracked in
> [#558](https://github.com/keiranholloway/biffo-template/issues/558).

---

## Context

ADR-0017 decided that a user-facing agentic module (the Ideation Engine is the
first) is a **marketplace plugin that runs its own Lambda** and rents Core's
capabilities across authenticated seams — it never runs code inside Core and never
touches the database. Those seams are now built and merged (Phases 1–5, plus the
thread-messages read): the plugin's `CoreGateway` adapter already binds to them.

What ADR-0017 *assumed* but did not specify is **how that plugin Lambda and its
frontend are hosted and reached by a founder**. Two things are missing:

1. **An authenticated ingress for the plugin's own Lambda.** ADR-0013 designed
   `http_ingress`, but only the *public webhook* variant (a Stripe callback): a
   Function URL or gateway route with no authentication, for a machine caller. A
   user-facing module needs the opposite — an ingress a **logged-in founder**
   reaches from a browser, gated to a Cognito group, with the founder's token
   available to forward to Core (ADR-0017 §3/§5).

2. **A user-facing frontend host.** The module ships a static app (chat + live
   scorecard/PRD). Nothing today serves a plugin's own frontend.

Both already exist for **siblings** (ADR-0007): a sibling gets a path-routed S3
origin and an `ordered_cache_behavior` (`<name>/*`) on the core's shared
CloudFront, and shares the *exact same* Cognito User Pool and App Client as the
portal — so a founder logged into the portal is logged into the sibling with no
second sign-in. A sibling's backend reaches Core server-side over a documented
HTTP contract.

A user-facing plugin is, structurally, **a sibling that happens to be
marketplace-installed**: a path-routed frontend + a backend Lambda, on the shared
CDN and Cognito, talking to Core over HTTP. The gap is not a new hosting shape — it
is *reusing the sibling shape for an installed plugin*, with the plugin's Lambda as
the authenticated backend, and provisioning it through the plugin install/review
flow (ADR-0003/0013) rather than by hand.

## Decision

**Host a user-facing plugin as an authenticated sibling.** The plugin declares a
`user_frontend` and a `user_ingress` in its manifest; `biffo plugin install`
provisions both on the shared CloudFront + Cognito, reusing the ADR-0007 sibling
mechanism. Concretely:

### 1. `user_ingress` — the plugin's authenticated Lambda, group-gated

The plugin declares:

```jsonc
"user_ingress": {
  "path": "api",                 // reached at  <base>/<plugin>/api/*
  "required_group": "founder",   // the Cognito group a caller must be in
  "handler": "ideation.lambda.handler"
}
```

Install provisions the plugin's Lambda with a **Function URL** (AWS_IAM disabled;
the auth is the plugin's own, below) and adds one `ordered_cache_behavior`
(`path_pattern = "<plugin>/api/*"`) on the shared CloudFront pointing at it. The
Lambda is a FastAPI + Mangum app that, on **every** request:

1. **Verifies the shared-Cognito JWT itself** using `packages/cognito-auth` (#492)
   — the same verifier Core uses — and **rejects a caller not in
   `required_group`** (403). Auth is the plugin's, at its own edge, mirroring how
   Core gates `/agent-chat/{agent_key}`; the group is declared, reviewed at
   install, and enforced in code.
2. Holds **no data** (ADR-0002): it calls Core only through the `CoreGateway`
   adapter over the internal seams, SigV4-signed as its service principal and
   **forwarding the founder's token** so Core re-verifies identity and owner-scopes
   (ADR-0017 §3/§5). The plugin gate is defence-in-depth; Core is the authority.

The Function URL is a first-class security surface (ADR-0013 §7): declared,
prominent in the install diff, and — unlike the webhook variant — never public,
because the handler rejects any request without a valid founder token.

### 2. `user_frontend` — a path-routed static app under shared Cognito SSO

The plugin declares:

```jsonc
"user_frontend": { "dir": "web/dist", "required_group": "founder" }
```

Install deploys the built static export to a new S3 origin and adds the sibling
`ordered_cache_behavior` (`path_pattern = "<plugin>/*"`) on the shared CloudFront
(reusing `modules/cloud/aws/cdn`'s `sibling_origins`). The frontend uses the *same*
Cognito User Pool and App Client as the portal, so the founder's existing session
carries over with no second sign-in (ADR-0007 §3), and calls its own
`<plugin>/api/*` ingress with the session's token. `required_group` gates the UI
client-side (a non-founder is bounced) — the real enforcement is the ingress and
Core, never the client.

### 3. Provisioned by install, from the manifest, reviewably

`biffo plugin install` (ADR-0003) reads these declarations and opens a PR that adds
the Lambda + Function URL, the two CloudFront behaviours, the S3 origin, and the
group wiring — the same declare → review → enforce flow ADR-0013 established, now
covering the authenticated user-facing surfaces. Nothing is provisioned that the
manifest did not declare and the review did not show.

### 4. Distinct from ADR-0013's public `http_ingress`

`http_ingress` (ADR-0013 §7) stays the **public, unauthenticated** webhook variant
for machine callers (payments, callbacks). `user_ingress` is the **authenticated,
Cognito-gated** variant for a logged-in human. Two declarations, two security
postures, deliberately not conflated: a public endpoint and a founder-only endpoint
must not be a single field whose safety depends on a flag.

## Options Considered

### Option A — Host user-facing plugins as authenticated siblings (chosen)

Reuse ADR-0007's path-routed CDN + shared Cognito; the plugin's Lambda is the
authenticated backend, provisioned by install.

**Pros:** reuses a proven, shipped mechanism (PR #120); one domain, one session, no
new Cognito resources; no plugin code in Core; data stays in Core; the frontend and
ingress are declared and reviewed like everything else.

**Cons:** a per-plugin Lambda + S3 origin + two CloudFront behaviours to provision;
CloudFront behaviour count grows with installed user-facing plugins.

### Option B — Serve the plugin UI from within the core portal

Core hosts plugin UI as declared components (ADR-0013 §6 UI capabilities).

**Pros:** no new origin per plugin.

**Cons:** ADR-0013 §6 UI is *admin*, declarative, and deliberately not arbitrary
app code; a founder-facing agentic chat is a real application, not a rendered
capability. Forcing it into core-hosted UI either cripples the module or lets
third-party UI code into the core portal — the coupling ADR-0007 and ADR-0017 both
reject.

### Option C — A full, independently-hosted sibling per plugin (own domain/Cognito)

**Pros:** maximal isolation.

**Cons:** a second sign-in, a second domain/cert, no shared session — the exact
pain ADR-0007 removed. A marketplace module the founder must separately log into is
not one-click.

## Rationale

The deciding factor is **reuse of a proven boundary over inventing a new one**.
ADR-0007 already solved path-routed hosting and shared-session SSO for
separately-deployed frontends+backends; a user-facing plugin has the same shape.
The only genuinely new element is *authentication at the plugin's own ingress* —
and that is a small, well-understood piece (verify the shared JWT with the shared
verifier, check a declared group), the same move Core makes at `/agent-chat`. Every
alternative either puts third-party code where it must not go (Option B) or throws
away the shared session that makes a marketplace module feel first-party (Option C).

## Consequences

### Positive

- The Ideation Engine (and every future user-facing module) gets a real,
  one-click, shared-session home without any plugin code in Core.
- Reuses shipped infrastructure; the new surface is one Lambda + one S3 origin +
  two CloudFront behaviours per module, all declared and reviewed.
- The authenticated ingress is a named, first-class security surface, distinct
  from the public webhook variant.

### Negative / Trade-offs

- Per-plugin Lambda + origin + behaviours; CloudFront behaviour count grows with
  installed user-facing plugins (bounded by the small number a solo founder
  installs).
- A Function URL that is only safe because the handler enforces auth — the review
  must treat "no public unauthenticated path" as a checked property, not a comment.
- Install now provisions compute and a public-DNS surface (behind auth), a larger
  step than provisioning a table; the review diff must surface it prominently.

### Neutral

- Siblings and user-facing plugins converge on one hosting mechanism; a plugin is
  a sibling with a manifest and an install flow.
- The plugin's frontend build (static export with a `<plugin>` base path) is the
  sibling frontend shape (ADR-0007 §2), reused.

## Compliance

- A `user_ingress` handler **must** verify the shared-Cognito JWT and enforce
  `required_group` before any work; a request without a valid founder token in the
  required group is rejected. Covered by a plugin-side test and asserted in the
  install review (the Function URL has no unauthenticated path).
- A `user_ingress`/`user_frontend` plugin holds **no** data client and no DB access
  (ADR-0002 / `TID251`); it reaches Core only via the `CoreGateway` seams.
- Install provisions **only** what the manifest declares; the review PR shows the
  Lambda, Function URL, S3 origin, and CloudFront behaviours before anything is
  applied (ADR-0003/0013).
- `user_ingress` is a separate manifest field from `http_ingress`; a plugin may not
  serve an authenticated user surface and a public webhook through one declaration.

## Build phasing

1. **Manifest schema** — `user_ingress` + `user_frontend` models + validation
   (Core), unit-tested. *Buildable and testable now.*
2. **Plugin Lambda contract** — the FastAPI+Mangum handler shape + the JWT/group
   gate helper (in the plugin SDK / skeleton), unit-tested against a fake verifier.
3. **Terraform** — the plugin module provisions the Lambda + Function URL + S3
   origin; extend `sibling_origins` (or a sibling-shaped `plugin_origins`) for the
   two behaviours. `terraform validate` in CI; a real apply on a dev stack.
4. **`biffo plugin install`** — read the declarations, open the review PR wiring
   ingress + frontend + group.
5. **Ship Ideation** — the `ideation.lambda` handler (real `Transport` +
   founder-gated app over `IdeationService`) and the `/ideation` static frontend.

## Related Decisions

- **ADR-0017** — decided the plugin hosts its own Lambda + frontend and rents
  Core's seams; this specifies how that Lambda and frontend are hosted.
- **ADR-0007** — sibling path-routed hosting + shared-Cognito SSO; the mechanism
  reused here.
- **ADR-0013** — declare/review/enforce, and the *public* `http_ingress` this
  authenticated variant sits beside.
- **ADR-0003** — the plugin install/review flow that provisions these surfaces.
- **ADR-0002 / #492** — data stays in Core; the shared JWT verifier the plugin
  ingress uses.
