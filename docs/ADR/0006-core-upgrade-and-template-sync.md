# ADR-0006: Core Upgrade and Template Sync

**Status:** Accepted  
**Date:** 2026-07-02  
**Accepted:** 2026-07-03  
**Deciders:** Keiran Holloway (Technical Architect)

> Implemented and merged across PRs #110 (versioning + `biffo core status`),
> #111 (`core-manifest.json` boundary + `biffo core diff`), #112 (three-way
> merge engine + `biffo core upgrade` dry run), and #113 (`--apply`: branch →
> PR), with boundary refinements in #115 (`.terraform`) and #117
> (`migrations/versions`). See [the core-upgrade guide](../guides/core-upgrade.md)
> for how to use it.

---

## Context

`biffo init` scaffolds a downstream repository **once** — it copies the
template's core (the FastAPI Core API in `services/api/`, the base portal, the
`modules/cloud` Terraform, the CI workflows) into a new repo and wires up AWS.
From that moment the downstream repo is a fork in all but name: there is **no
mechanism to propagate later improvements to the template core into an
already-scaffolded, already-deployed instance**.

This became concrete while building ADR-0004 (the generic CRUD layer). The
capability lands in `biffo-template`, but a live instance such as
`dev.tabsii.com` cannot receive it. Today the only ways to update a deployed
instance's core are:

1. **Hand-port** — a human copies the relevant template commits into the
   instance's repo on a branch and opens a PR. Correct but manual, error-prone,
   and unrepeatable at scale (every instance, every change).
2. **Teardown + re-`init`** — destroy the instance and re-scaffold from the
   current template. Trivial but **destructive**: it loses data and any
   instance-local changes, and is categorically unacceptable for a live
   instance. (`dev.tabsii.com` must never be torn down.)

Neither is a real upgrade path. We need a **non-destructive, repeatable,
reviewable** way to move a versioned set of template-owned changes into a
downstream repo — one that respects the same guardrails everything else does:
branch protection (no direct pushes to `main`), the vendored-source ethos of
ADR-0003 (the user's repo remains the inspectable, editable source of truth),
and ADR-0001/0002 (no bypass of the Core API or tenant scoping; no touching of
data or live infrastructure state as a side effect of an upgrade).

This ADR does **not** cover plugin distribution — ADR-0003 already owns that
(plugins are installed per-instance via `biffo plugin install`). This is about
the **core/template itself** upgrading in place.

---

## Decision

Introduce a **`biffo core upgrade`** CLI command that syncs versioned,
template-owned files from `biffo-template` into a scaffolded downstream repo as
a **branch + pull request**, which the instance's own existing CI
(`deploy-app.yml` / `deploy-infra.yml`) deploys on merge. Four pieces:

### 1. Core versioning

`biffo-template` carries an explicit **core version** (a `core.version` file at
the repo root, semver, independent of any package version). This is the **single
committed source of truth** for a core version: the template ships it, and every
scaffolded instance inherits a copy via template generation — so an instance's
current version is simply the `core.version` it carries.

`biffo.core.json` is **not** a committed seed (that would duplicate the number in
both the template and every instance). It is written by `biffo core upgrade` to
record the version an instance was last upgraded to, so the _next_ upgrade knows
the _from_ version independently of the synced (template-owned) `core.version`
file. Resolution of an instance's current version therefore prefers
`biffo.core.json` if an upgrade has recorded one, and otherwise falls back to the
inherited `core.version`. This makes ADR-0003's already-referenced
`required_core_version` meaningful and gives the upgrade a well-defined _from_
and _to_.

#### Versioning discipline (enforced)

The mechanism only works if `core.version` actually moves. It initially did not
— it sat at `0.1.0` across many template-owned releases, which made
`biffo core status` a permanent "up to date" and `biffo core upgrade` a no-op
for every instance. Two guardrails keep version and history in lockstep:

- **CI guard (`Core Version Guard`).** A required check fails any pull request
  that changes a template-owned path (per `core-manifest.json`) without bumping
  `core.version`. Patch for fixes, minor for features, major for breaking core
  changes. Implemented by `cli/src/lib/core-version-guard.ts` (reusing the same
  `isTemplateOwned` logic as the sync) and run via
  `pnpm --filter @biffo/cli check:core-bump`.
- **Auto-tagging (`Core Version Tag`).** On merge to `main`, a git tag
  `core-v<version>` is created for the new `core.version`. These tags are the
  recoverable template trees `biffo core upgrade` uses as its merge **base** (the
  template as it was at an instance's current version) and **target** — without
  them, the base tree is unrecoverable and the three-way merge produces spurious
  conflicts.

### 2. Core-owned path manifest

The template ships a **`core-manifest.json`** declaring which paths are
**template-owned** (`services/api/**`, `modules/cloud/**`, base
`.github/workflows/**`, the portal shell, etc.) versus **user-owned** (product
code, plugin installs under `services/<plugin>/`, `infra/environments/*`
overrides, secrets/config). Only template-owned paths are ever touched by a
sync. This boundary is the crux of the whole mechanism — it is what lets an
upgrade avoid clobbering the user's own work.

### 3. Three-way merge → branch → PR

`biffo core upgrade [--to <version>] [--repo <path>]`:

1. Resolve the instance's current core version (`biffo.core.json`) and the
   target (`--to`, default: the template's latest `core.version`).
2. For each template-owned path, perform a **three-way merge**: base = the
   template at the instance's _current_ version, ours = the instance's working
   file, theirs = the template at the _target_ version. This preserves
   instance-local edits to core files where they don't conflict.
3. Apply the result on a **new branch** and **open a PR** on the instance's
   repo (never a direct push — branch protection, CLAUDE.md invariant #5).
   Bump `biffo.core.json` to the target version in the same PR.
4. **Conflicts are surfaced in the PR** (standard conflict markers + a summary
   comment) for a human to resolve — the tool never silently resolves a
   conflict in core code.

### 4. Non-destructive by construction

The command only ever writes files to a git branch and opens a PR. It does not
run Terraform, touch a database, invoke a Lambda, or delete anything in AWS. The
instance's **existing** pipeline (`deploy-app.yml` re-ships the Lambda/portal;
`biffo:db-init` runs migrations) applies the change _after the PR is merged by a
human_. A live instance is never torn down; an upgrade is an ordinary rolling
deploy.

---

## Options Considered

### Option A — `biffo core upgrade` PR-based file sync _(chosen)_

CLI computes a three-way merge of template-owned files and opens a PR on the
instance repo; the instance's own CI deploys on merge.

**Pros:**

- Non-destructive and reviewable — a human approves every core change before it
  deploys; branch protection is respected.
- Keeps the ADR-0003 vendored-source ethos: the instance repo stays the
  complete, inspectable, editable source of truth.
- Reuses each instance's existing CI/CD — no new deploy machinery.
- Works for any number of instances from one command.

**Cons:**

- Requires an accurate core-owned path manifest, which must be maintained as the
  template evolves.
- Merge conflicts in core files still need human resolution.
- Version bookkeeping (`core.version` / `biffo.core.json`) is new surface to
  keep correct.

### Option B — Git subtree / submodule of the template core

Vendor the template core as a git subtree (or submodule) so `git subtree pull`
brings updates.

**Pros:**

- Native git history and merge; no bespoke merge tooling.

**Cons:**

- Submodules break the "one repo, one deploy" simplicity ADR-0003 chose
  deliberately; subtrees are notoriously fragile and confusing for solo
  developers (the target user).
- The core/user file boundary doesn't fall on clean directory lines (workflows,
  root configs, and `services/api` interleave with user content), so a
  subtree split is awkward.

### Option C — Distribute the core as a versioned dependency (package / Lambda layer)

Ship the Core API as a published package (PyPI / npm / a Lambda layer) that the
instance depends on by version, instead of vendoring its source.

**Pros:**

- Cleanest possible upgrade — bump a version, no file merge at all.

**Cons:**

- Directly contradicts ADR-0003's rejected "download pre-built artifacts"
  option and its open-source, inspect-and-edit ethos.
- A large restructuring of how the whole platform is built and deployed, far
  beyond the scope of "let existing instances receive core updates."
- Users lose the ability to read and locally patch core code.

### Option D — Teardown + re-`init`

Destroy the instance and re-scaffold from the current template.

**Pros:**

- Trivial to implement (already exists as `init`).

**Cons:**

- Destructive — loses data and instance-local changes.
- Categorically unacceptable for a live instance (`dev.tabsii.com`). Rejected on
  those grounds alone.

---

## Rationale

Option A is the only one that is simultaneously non-destructive, reviewable, and
faithful to ADR-0003's decision that the user's repo is the vendored, editable
source of truth. The genuinely hard part — telling core-owned files from
user-owned ones — is not avoided by B or C (they relocate it, they don't remove
it), so we confront it directly with an explicit manifest. Doing the sync as a
PR rather than a push means the existing branch-protection and CI guarantees do
all the safety work; the command adds no new privileged path into a deployed
environment.

Crucially, Option A never requires touching a running instance's infrastructure
or data — it only proposes a code change for a human to merge — which is what
makes it safe to run against a live instance like `dev.tabsii.com`.

---

## Consequences

### Positive

- Deployed instances can receive core improvements (starting with ADR-0004's
  generic CRUD layer) without a hand-port and without a teardown.
- Every core change to an instance is a reviewable PR gated by that instance's
  own CI.
- One command scales across many instances.

### Negative / Trade-offs

- The `core-manifest.json` path boundary must be maintained deliberately as the
  template grows; a missed path silently won't sync (fails safe) or a
  mis-classified user path could be proposed for overwrite (caught in PR review,
  but noise).
- Conflicts in core files require human resolution — the tool does not
  auto-resolve core code.
- New version-tracking surface (`core.version`, `biffo.core.json`) to keep
  accurate.

### Neutral

- Mirrors ADR-0003's plugin upgrade model (deliberate, minor-version-pinned,
  application-owned) at the core layer, so the two feel consistent.
- Patch-vs-minor semantics for core upgrades can follow the same convention as
  plugins; deferred to implementation.

---

## Compliance

- **PRs, never pushes:** the command opens a pull request on the instance repo
  and never pushes to a protected branch (CLAUDE.md invariant #5).
- **Manifest-gated:** only paths declared template-owned in `core-manifest.json`
  are ever written; user-owned paths are out of reach of a sync by construction.
- **Version-tracked:** an instance's core version lives in a committed
  `biffo.core.json`; an upgrade PR bumps it, so the from/to is auditable in git
  history.
- **No side effects on live infrastructure:** the command performs only local
  git operations and a PR creation — no Terraform apply, no DB write, no Lambda
  invoke. Deployment happens only when a human merges the PR and the instance's
  existing pipeline runs.

---

## Implementation Plan (phased)

Each phase is independently shippable and reviewable; later phases are gated on
review of the earlier ones.

- **Phase 1 — versioning primitive.** Add `core.version` to the template and
  `biffo.core.json` to `init`'s scaffold output; add a read-only
  `biffo core status` that reports the instance's current core version vs the
  template's latest. No sync yet. (Low risk, fully testable, no outward-facing
  actions.)
- **Phase 2 — diff.** Add `core-manifest.json` and `biffo core diff`, which
  reports which template-owned files would change on an upgrade, without writing
  anything.
- **Phase 3 — upgrade.** Add `biffo core upgrade`: the three-way merge, branch
  creation, and PR. This is the first phase that opens a PR on another repo and
  should ship only after Phases 1–2 are reviewed.

Until Phase 3 ships, a deployed instance receives core changes by a **manual,
reviewed port** (a branch + PR on the instance's own repo whose existing CI
deploys it) — never a teardown. This is the interim path for `dev.tabsii.com`.

---

## Related Decisions

- [ADR-0003](0003-plugin-system-and-marketplace.md) — plugin distribution is
  per-instance and app-owned; this ADR is the equivalent, deliberate,
  reviewable upgrade path for the **core** rather than for plugins, and reuses
  ADR-0003's `required_core_version` version primitive.
- [ADR-0004](0004-generic-crud-layer-and-table-permissions.md) — the first core
  capability that needs this mechanism to reach already-deployed instances; its
  interim delivery to `dev.tabsii.com` is a manual PR port pending Phase 3.
- [ADR-0001](0001-single-tenant-architecture-with-multi-tenant-seam.md) /
  [ADR-0002](0002-api-only-data-integration-pattern.md) — a core upgrade never
  bypasses the Core API or tenant scoping and never mutates data or live infra
  state as a side effect; it only proposes a code change for review.
