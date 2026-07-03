# ADR-0008: Endpoint Control Plane (enable-via-PR)

**Status:** Proposed  
**Date:** 2026-07-03  
**Deciders:** Keiran Holloway (Technical Architect)

---

## Context

ADR-0004 made generic-CRUD permissions **config-as-code**: enabling an endpoint means editing a `permissions` block (plugin) or `__crud_permissions__` (core model), committing, and deploying. It deliberately chose "a permission change requires a deploy, not a live config toggle" — the permission registry is a build-time artifact loaded at cold start.

The read-only **Endpoints view** (Option A of this line of work) lists what's live. The next ask is to **enable or change an endpoint's permission from the portal** — without abandoning config-as-code. That means a control plane that, on an admin's action, makes the same file edit a human would and **opens a pull request**; merging it deploys the change through the instance's normal pipeline (ADR-0004 and ADR-0006 both unchanged).

This is not just a UI feature — it introduces something the platform doesn't have today: **a server-side component that holds repo-write credentials and mutates the instance's repository**. The Core API currently has no GitHub/git client at all. This ADR decides where that component lives, how it edits and opens the PR, and its security model.

## Decision

Add an **admin-only control-plane action** — `POST /api/v1/admin/endpoints/permission` on the Core API — that, given `(source, plugin|table, operation, allowed, required_role)`:

1. reads the owning file at the base branch's head via the **GitHub Contents API**,
2. applies the single permission change,
3. commits it to a new branch and **opens a PR** on the instance repo (never a direct push),
4. returns the PR URL for the portal to link to.

It never merges or deploys — a human reviews and merges, then the existing pipeline applies it.

**Security is the primary constraint** (see the dedicated section below): the action is gated on an **admin** Cognito group verified from the JWT, authenticates to GitHub with a **GitHub App** minting **short-lived, fine-grained, single-repo installation tokens** (never a long-lived PAT), never returns or logs any secret, and only ever opens a PR — it cannot merge or push to a protected branch. **Every change is fully auditable** (below).

**Plugin tables first.** A plugin's `permissions` block lives in JSON (`services/<plugin>/biffo.plugin.json`) and is safe to patch programmatically. A core table's `__crud_permissions__` lives in **Python source**, which is not safe to edit mechanically — so core-table toggling is **out of scope for the first version** and tracked as a follow-up (see Consequences). (This is also a security consideration: never mechanically rewrite executable source.)

## Options Considered

### Where the control plane runs

#### Option A — In the Core API _(chosen)_

A new admin route on the existing FastAPI service.

**Pros:** reuses the existing auth (Cognito JWT + role check), one service, no new deploy target. The portal already talks to it.

**Cons:** gives the data API a GitHub repo-write credential — a genuine expansion of its blast radius. Needs a GitHub client in Python.

#### Option B — A separate control-plane service/Lambda

Isolate the repo-write credential in its own service.

**Pros:** the data API never holds repo-write creds.

**Cons:** another service to build, deploy, secure, and route to — heavy for a solopreneur platform whose whole premise is fewer moving parts. The isolation is real but modest, since the token is PR-scoped and admin-gated either way.

#### Option C — Portal → backend proxy that runs the CLI

The ADR-0003 "install via a backend proxy" sketch: a server runs `biffo` + git.

**Cons:** needs a host that clones the repo and runs the CLI/git — the most infrastructure and the slowest path, to do what a Contents-API call does statelessly.

### How the file is edited

- **GitHub Contents API _(chosen)_** — read blob → patch → commit to a branch → open PR. Stateless; ideal for a Lambda (no clone, no writable FS, no git binary).
- **Local clone + git** (like `biffo core upgrade`) — heavier in a Lambda; unnecessary for a one-file change.

## Rationale

Option A keeps the platform to one service and reuses its auth, which matters more here than the modest credential isolation Option B buys — especially since the token is PR-only and the action is admin-gated, so the worst case is "an admin opens a PR they could have opened by hand." The Contents API makes the edit stateless and cheap. Restricting v1 to plugin (JSON) permissions avoids the genuinely hard and error-prone problem of rewriting Python source, while still covering the common case (plugins are where most CRUD tables live).

## Consequences

### Positive

- Admins can propose enabling/changing an endpoint from the portal, as a reviewable PR — closing the "no UI to turn endpoints on" gap without breaking config-as-code.
- Reuses ADR-0004 (the permission model) and ADR-0006 (PR-based, instance-CI-deploys) unchanged; nothing becomes a live runtime toggle.

### Negative / Trade-offs

- The Core API now needs a **GitHub App / PR-scoped token** configured per instance — a new onboarding/secret-management step, and a new credential on the data service.
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
- **Defense in depth (optional, flagged for decision).** The GitHub App credential can be isolated in a dedicated minimal "PR-signer" function the Core API calls, so a compromise of the data API doesn't directly yield the repo credential. This adds a service; given the credential is already PR-scoped, single-repo, and short-lived, and deploy is gated by human review, the marginal benefit is modest — **recommended as a follow-up hardening, not a v1 blocker.** (Confirm if you'd rather isolate it from day one.)

## Auditability

Every change is traceable end to end:

- **Immutable git record.** The change is a commit on a branch and a PR — permanent history of exactly what changed, when, and (once merged) by whom.
- **Attributed to a human.** The PR title/body and commit record the **requesting admin's identity** (email/username from the verified JWT) — "Requested by `<email>` via the portal endpoints view" — so the git trail names a person, not a bot.
- **Server-side audit log.** Each call emits a structured audit event (requester identity, source/plugin/table, operation, old→new `allowed`/`required_role`, timestamp, and the resulting PR URL) to the deployment's log/audit sink — a record independent of the repo, including of _attempts_.
- **Two-person integrity.** Because it's PR→review→merge, the requester and the merger can be different people; the deploy that actually changes behavior is a separate, reviewed, logged step.

## Compliance

- Config-as-code is preserved — the source of truth stays the file in the repo (ADR-0004); this action only automates the edit a human would otherwise make by hand, and changes take effect only via the normal reviewed deploy (ADR-0006 pattern).
- The security and auditability controls above are the acceptance criteria for the implementation PR; a build that skips the admin check, uses a broad/long-lived token, or omits the audit event does not satisfy this ADR.

## Related Decisions

- [ADR-0004](0004-generic-crud-layer-and-table-permissions.md) — the permission model this mutates; its "permission change requires a deploy" decision is preserved (this opens a PR, it does not toggle at runtime).
- [ADR-0006](0006-core-upgrade-and-template-sync.md) — the same "propose a change as a reviewed PR the instance's own CI deploys" pattern, here for a single permission rather than a whole core sync.
- [ADR-0002](0002-api-only-data-integration-pattern.md) — this adds a non-data capability (repo write) to the Core API; the isolation trade-off is discussed under Options B.
