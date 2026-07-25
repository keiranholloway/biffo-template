# ADR-0008: Endpoint Control Plane (enable-via-PR)

**Status:** Accepted  
**Date:** 2026-07-03  
**Accepted:** 2026-07-03  
**Deciders:** Keiran Holloway (Technical Architect)

---

## Context

ADR-0004 made generic-CRUD permissions **config-as-code**: enabling an endpoint means editing a `permissions` block (plugin) or `__crud_permissions__` (core model), committing, and deploying. It deliberately chose "a permission change requires a deploy, not a live config toggle" — the permission registry is a build-time artifact loaded at cold start.

The read-only **Endpoints view** (Option A of this line of work) lists what's live. The next ask is to **enable or change an endpoint's permission from the portal** — without abandoning config-as-code. That means a control plane that, on an admin's action, makes the same file edit a human would and **opens a pull request**; merging it deploys the change through the instance's normal pipeline (ADR-0004 and ADR-0006 both unchanged).

This is not just a UI feature — it introduces something the platform doesn't have today: **a server-side component that holds repo-write credentials and mutates the instance's repository**. The Core API currently has no GitHub/git client at all. This ADR decides where that component lives, how it edits and opens the PR, and its security model.

## Decision

Split the control plane into **two components** so the repo-write credential is isolated from the data API:

1. **Core API admin endpoint** — `POST /api/v1/admin/endpoints/permission`. Authenticates the caller (Cognito JWT), authorizes them (`admin` group), validates the requested `(source, plugin|table, operation, allowed, required_role)` change against the `TablePermissions` model, and then **invokes the PR-signer** with that validated payload plus the requester's identity. It returns the resulting PR URL to the portal. **The Core API never holds a repo-write credential.**
2. **PR-signer Lambda** — a dedicated, minimal function with **no public/API-Gateway endpoint** (invocable only via the AWS SDK). It is the only component that can read the **GitHub App** private key (from Secrets Manager, granted to its role alone). On invocation it re-validates the payload, then via the **GitHub Contents API**: reads the owning file at the base branch's head, applies the single permission change, commits it to a new branch, and **opens a PR** on the instance repo (never a direct push). It returns the PR URL and emits an audit event.

**Internal trust is IAM, not a shared secret.** The Core API's execution role is granted `lambda:InvokeFunction` on the signer and nothing else; the signer's resource policy accepts only that caller. The GitHub App secret is readable **only** by the signer's role — so a compromise of the data API cannot reach the repo credential.

It never merges or deploys — a human reviews and merges, then the existing pipeline applies it.

**Security is the primary constraint** (see the dedicated section below): the action is gated on an **admin** Cognito group verified from the JWT, authenticates to GitHub with a **GitHub App** minting **short-lived, fine-grained, single-repo installation tokens** (never a long-lived PAT), never returns or logs any secret, and only ever opens a PR — it cannot merge or push to a protected branch. **Every change is fully auditable** (below).

**Plugin tables first.** A plugin's `permissions` block lives in JSON (`services/<plugin>/biffo.plugin.json`) and is safe to patch programmatically. A core table's `__crud_permissions__` lives in **Python source**, which is not safe to edit mechanically — so core-table toggling is **out of scope for the first version** and tracked as a follow-up (see Consequences). (This is also a security consideration: never mechanically rewrite executable source.)

## Options Considered

### Where the control plane runs

#### Option A — Entirely in the Core API

A single admin route on the FastAPI service that also holds the GitHub App key and opens the PR.

**Pros:** one service, reuses existing auth, no new deploy target.

**Cons:** gives the **data API** a repo-write credential — a compromise of the Core API (which already holds all tenant data) would also yield repo write. For a feature where security is the deciding constraint, that shared blast radius is the wrong default.

#### Option B — Core API + isolated PR-signer Lambda _(chosen)_

The Core API does authz + validation and invokes a dedicated PR-signer Lambda (over IAM) that alone holds the GitHub App credential and performs the edit + PR.

**Pros:** the repo-write credential is reachable only by a minimal, no-public-endpoint function; a compromise of the data API does not yield repo write (defense in depth). Clear separation of "who's allowed" (Core API) from "who can touch the repo" (signer).

**Cons:** one more small service to build, deploy, and secure. Accepted deliberately because security is the primary constraint here.

#### Option C — Portal → backend proxy that runs the CLI

The ADR-0003 "install via a backend proxy" sketch: a server runs `biffo` + git.

**Cons:** needs a host that clones the repo and runs the CLI/git — the most infrastructure and the slowest path, to do what a Contents-API call does statelessly.

### How the file is edited

- **GitHub Contents API _(chosen)_** — read blob → patch → commit to a branch → open PR. Stateless; ideal for a Lambda (no clone, no writable FS, no git binary).
- **Local clone + git** (like `biffo core upgrade`) — heavier in a Lambda; unnecessary for a one-file change.

## Rationale

Because security is the deciding constraint, the credential that can write to the repo is isolated in a dedicated PR-signer (Option B) rather than co-located with the data API (Option A) — a compromise of the Core API must not also grant repo write. The Core API keeps what it's already good at (verifying the caller is an authenticated admin) and delegates the privileged act to a minimal function with no public surface, trusted over IAM rather than a shared secret. The Contents API makes the signer stateless and cheap (no clone, no writable FS, no git binary). Restricting v1 to plugin (JSON) permissions avoids mechanically rewriting Python source — both an error-prone and a security-sensitive operation — while still covering the common case (plugins are where most CRUD tables live).

## Consequences

### Positive

- Admins can propose enabling/changing an endpoint from the portal, as a reviewable PR — closing the "no UI to turn endpoints on" gap without breaking config-as-code.
- Reuses ADR-0004 (the permission model) and ADR-0006 (PR-based, instance-CI-deploys) unchanged; nothing becomes a live runtime toggle.

### Negative / Trade-offs

- A new per-instance setup step: registering/installing a **GitHub App** and storing its key for the signer — plus a **new PR-signer Lambda** (and its IAM/Terraform) to build, deploy, and maintain. Accepted as the cost of isolating the credential.
- **Core-table (`__crud_permissions__`) toggling is not supported in v1** — editing Python source safely is out of scope; those still change by hand. Follow-up options: move core `__crud_permissions__` into a JSON sidecar the model reads, or an AST-based editor. To be decided separately.
- Still not instant — it's a PR + merge + deploy, by design. (A live runtime toggle would be a different ADR that supersedes ADR-0004's build-time-artifact decision.)

### Neutral

- The edit/PR machinery overlaps `biffo core upgrade` (ADR-0006) conceptually but is a much smaller, single-file operation via the API rather than the CLI.

## Security model

Security is the deciding constraint for this feature, so the controls are specified here rather than left to implementation:

- **Authentication & authorization.** Every call requires a valid Cognito JWT (verified signature/audience, as every route already does) **and** membership of an `admin` group, checked server-side on each request — same role mechanism ADR-0004 uses. No unauthenticated or non-admin path exists.
- **Least-privilege credential.** A **GitHub App** installed on only the instance repo, with the minimum fine-grained permissions (`contents: write`, `pull_requests: write`) — **not** a personal access token and **not** an org-wide token. The App's private key lives in a secrets manager (AWS Secrets Manager); the server mints a **short-lived installation token** per operation and discards it. Tokens/keys are never returned to the client, never logged, and never written to the repo.
- **No privileged write path.** The action can only open a PR. It cannot merge, cannot push to a protected branch, and cannot disable branch protection — branch protection + human review remain the gate on what deploys (CLAUDE.md invariant #5). A compromised caller can at most open a PR an admin would still have to merge.
- **Constrained mutation.** The only thing the action may change is the `permissions` block of a table that already exists in a discovered manifest. The requested change is validated against the same Pydantic `TablePermissions` model before anything is written — it cannot write arbitrary files, arbitrary paths, or arbitrary content, and it cannot touch executable source (hence plugin-JSON only in v1).
- **Credential isolation (chosen, day one).** The GitHub App private key is readable only by the PR-signer's role — not the Core API's. The signer has no public/API-Gateway endpoint and is invocable only by the Core API's role over IAM (`lambda:InvokeFunction`). So even a full compromise of the data API yields no repo-write credential and no direct path to open a PR except through the signer's validated, PR-only interface.
- **Payload re-validation at the boundary.** The signer does not trust its caller blindly — it re-validates the change against `TablePermissions` and confirms the target table/plugin exists before writing, so a bug or compromise upstream still can't make it write arbitrary content.

## Auditability

Every change is traceable end to end:

- **Immutable git record.** The change is a commit on a branch and a PR — permanent history of exactly what changed, when, and (once merged) by whom.
- **Attributed to a human.** The PR title/body and commit record the **requesting admin's identity** (email/username from the verified JWT) — "Requested by `<email>` via the portal endpoints view" — so the git trail names a person, not a bot.
- **Server-side audit log.** Each call emits a structured audit event (requester identity, source/plugin/table, operation, old→new `allowed`/`required_role`, timestamp, and the resulting PR URL) to the deployment's log/audit sink — a record independent of the repo, including of _attempts_.
- **Two-person integrity.** Because it's PR→review→merge, the requester and the merger can be different people; the deploy that actually changes behavior is a separate, reviewed, logged step.

## Implementation

The control plane design was implemented in two components with supporting PRs:

### Core admin endpoint (PR #130)

`POST /api/v1/admin/endpoints/permission` validates the caller's admin status and
permission change request, then invokes the PR-signer Lambda. Returns the PR URL
to the portal.

### PR-signer Lambda (PRs #133, #136)

A dedicated AWS Lambda invocable only by the Core API (IAM-scoped `lambda:InvokeFunction`),
holding the GitHub App private key. Reads the target file from the base branch,
applies the single permission change, commits to a new branch, and opens a PR.

### Refinements and live operation (PRs #137, #138, #140, #143, with follow-ups #163, #182, #184)

Production deployment surfaced edge cases in error handling, branch naming, and
auth token lifecycle that were refined through subsequent PRs. The design and security
model remained stable; the implementation iterations addressed operational details
(e.g. token TTL management, audit event structure, PR comment content).

### Live documentation

The design is fully documented as complete end-to-end in
`docs/guides/endpoint-control-plane-setup.md`.

## Compliance

- Config-as-code is preserved — the source of truth stays the file in the repo (ADR-0004); this action only automates the edit a human would otherwise make by hand, and changes take effect only via the normal reviewed deploy (ADR-0006 pattern).
- The security and auditability controls above are the acceptance criteria for the implementation PR; a build that skips the admin check, uses a broad/long-lived token, or omits the audit event does not satisfy this ADR.

## Related Decisions

- [ADR-0004](0004-generic-crud-layer-and-table-permissions.md) — the permission model this mutates; its "permission change requires a deploy" decision is preserved (this opens a PR, it does not toggle at runtime).
- [ADR-0006](0006-core-upgrade-and-template-sync.md) — the same "propose a change as a reviewed PR the instance's own CI deploys" pattern, here for a single permission rather than a whole core sync.
- [ADR-0002](0002-api-only-data-integration-pattern.md) — this adds a non-data capability (repo write) to the Core API; the isolation trade-off is discussed under Options B.
- **Distribution.** The signer's own code (`services/pr-signer/`) and its Terraform (`infra/environments/dev/pr-signer.core.tf`) are template-owned and distribute via `biffo core upgrade` (`core-manifest.json`, issue #568) — the same ADR-0006 mechanism, not something this ADR previously named. `enable_pr_signer` and its companion GitHub App/repo variables stay user-owned, per-instance policy.
