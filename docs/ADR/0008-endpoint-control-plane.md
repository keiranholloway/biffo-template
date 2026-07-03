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

It never merges or deploys — a human reviews and merges, then the existing pipeline applies it. It is gated on an **admin** Cognito group and authenticates to GitHub with a **narrowly-scoped, PR-only token** (GitHub App installation token) configured per instance.

**Plugin tables first.** A plugin's `permissions` block lives in JSON (`services/<plugin>/biffo.plugin.json`) and is safe to patch programmatically. A core table's `__crud_permissions__` lives in **Python source**, which is not safe to edit mechanically — so core-table toggling is **out of scope for the first version** and tracked as a follow-up (see Consequences).

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

## Compliance

- **PRs, never pushes** — the action opens a PR on the instance repo; branch protection and review still gate what actually deploys (CLAUDE.md invariant #5).
- **Admin-gated** — requires an `admin` Cognito group, enforced the same way the generic CRUD layer checks roles (ADR-0004).
- **Least-privilege credential** — a PR-scoped GitHub App installation token, not a broad PAT; stored as a deployment secret, never returned to the client or logged.
- **Config-as-code preserved** — the source of truth stays the file in the repo; this action only automates the edit a human would make.

## Related Decisions

- [ADR-0004](0004-generic-crud-layer-and-table-permissions.md) — the permission model this mutates; its "permission change requires a deploy" decision is preserved (this opens a PR, it does not toggle at runtime).
- [ADR-0006](0006-core-upgrade-and-template-sync.md) — the same "propose a change as a reviewed PR the instance's own CI deploys" pattern, here for a single permission rather than a whole core sync.
- [ADR-0002](0002-api-only-data-integration-pattern.md) — this adds a non-data capability (repo write) to the Core API; the isolation trade-off is discussed under Options B.
