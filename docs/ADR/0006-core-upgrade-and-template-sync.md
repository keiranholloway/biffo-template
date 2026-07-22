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

`biffo-template` carries an explicit **core version** (semver, independent of any
package version), and its `core-v*` git tags are where that version lives: the
highest `core-v<version>` tag is the template's current version, and the tag
resolves to the template-owned tree as it stood at that version. Nothing in the
tree names the version — it is **derived** at release time, never hand-written
(see _Versioning discipline_ below).

`biffo.core.json` at an instance's root records the version that instance
_received_: written by `biffo init` at scaffold time and bumped by every
`biffo core upgrade`, so the _next_ upgrade knows its _from_ version. An instance
scaffolded before that record existed has none, and resolution falls back to the
`core.version` file such instances inherited via template generation. This makes
ADR-0003's already-referenced `required_core_version` meaningful and gives the
upgrade a well-defined _from_ and _to_.

#### Versioning discipline (enforced)

The mechanism only works if the version actually moves. It initially did not —
the `core.version` file then in use sat at `0.1.0` across many template-owned
releases, which made `biffo core status` a permanent "up to date" and
`biffo core upgrade` a no-op for every instance. Two guardrails keep version and
history in lockstep:

- **Release job (`Core Version Tag`).** On **every** push to `main` the job
  derives the next version — the highest existing `core-v*` tag, bumped by the
  conventional type of the commit being released (`feat` or a declared break
  earns a minor, everything else a patch; pre-1.0, so a break is still a minor)
  — and tags HEAD with it. A push whose template-owned tree is unchanged since
  the last tag releases nothing, so an ordinary user-owned commit costs no
  version. These tags are the recoverable template trees `biffo core upgrade`
  uses as its merge **base** (the template as it was at an instance's current
  version) and **target** — without them, the base tree is unrecoverable and the
  three-way merge produces spurious conflicts. Implemented by
  `cli/src/lib/release-version.ts` and `cli/src/scripts/sync-core-tag.ts`.
- **CI guard (`Core Version Guard`).** Which bump that derivation picks rests on
  a single input: the subject of the commit that lands on `main`, which under
  squash-merge is the **pull request title**. commitlint never sees that title, and one it
  cannot parse fails nothing — it falls through to a patch, so a feature merged
  as "Update the API" would ship as a patch and the minor line instances watch
  would never move. A required check therefore fails any pull request that
  changes a template-owned path (per `core-manifest.json`) whose title is not a
  Conventional Commits subject. Implemented by
  `cli/src/lib/release-subject-guard.ts` (reusing the same `isTemplateOwned`
  logic as the sync) and run via
  `pnpm --filter @biffo/cli check:release-subject`.

##### Why the version stopped being hand-written (issue #423)

`core.version` was a tracked file, and the guard above used to fail any pull
request that changed a template-owned path without bumping it. One global counter
plus branch protection's up-to-date requirement made a conflict between
concurrent PRs certain: the second to merge always rebased, re-bumped,
force-pushed and waited for another full CI cycle, resolving the same trivial
conflict the same way every time.

It also let a commit name a version that had already been released. The guard
compared a PR against its base at open time, so two PRs opened against the same
base could both bump to the same number, and the second one's template changes
then landed on `main` under a tag that already existed (issue #294;
a2acf15/be4c573 at 0.32.4). #294's answer was to move the tag onto the later
commit, and #342 showed why that is wrong: a `core-v*` tag is a release —
`core-tag.yml` hands every tag it pushes to `publish-cli.yml` — and an npm
version is immutable, so the artifact cannot move with the tag. npm held one tree
as 0.41.9 while `core-v0.41.9` had been moved onto another. A revert could
restore an already-released number by the same route (#422), and the guard, which
only asked whether the file appeared in the diff and never whether it had grown,
passed it.

A derived version cannot repeat a released one, so two commits shipping a single
version is unrepresentable rather than policed, and the machinery that existed to
detect it — drift detection, the refusal to repoint an existing tag, the audit of
every historical tag — is gone with the file.

One hand-editing fault survives derivation, because `git tag` is not covered by
branch protection: the highest `core-v*` tag can be created or moved by hand onto
a commit outside `main`'s history, and deriving from it would mint a successor to
a tree `main` never carried. The release job fails on that rather than guessing,
and says to establish what npm actually shipped as that version
(`npm view @biffo/cli@<version> gitHead`) before anything is moved.

### 2. Core-owned path manifest

The template ships a **`core-manifest.json`** declaring which paths are
**template-owned** (`services/api/**`, `modules/cloud/**`, base
`.github/workflows/**`, the portal shell, etc.) versus **user-owned** (product
code, plugin installs under `services/<plugin>/`, `infra/environments/*`
overrides, secrets/config). Only template-owned paths are ever touched by a
sync. This boundary is the crux of the whole mechanism — it is what lets an
upgrade avoid clobbering the user's own work.

**`docs/ADR/` is deliberately user-owned.** The template's ADRs are seeded once
at `biffo init` as a starting point, but an instance's decision record is its
own: instances legitimately diverge from the Biffo standard over time, and
force-syncing ADRs on every upgrade collides an instance's own ADR numbers with
the template's and rewrites its narrative. New template ADRs are surfaced in
release notes rather than pushed into instances. What matters is that decisions
stay documented and unambiguous per repo — not that the numbering is uniform
across every instance.

**The template's own version is likewise not synced** (amended 2026-07, issues
#199 and #423). It is the version the template _emits_, while the version an
instance _received_ is `biffo.core.json`, which takes precedence on every read.
When the version was a `core.version` file, an instance inherited a copy of it
via template generation, so syncing it could not improve any lookup — it could
only overwrite whatever the instance kept in that file, and one instance had
repurposed it as its own app release lineage, which an upgrade regressed. It was
omitted from `core-manifest.json` (user-owned by the fail-closed default) for
that reason; since #423 there is no such file to sync at all. For the same
reason the `Core Version Tag` workflow — which ships to instances under
`.github/` — skips itself when `biffo.core.json` is present, rather than pushing
template version tags into an instance's tag namespace. The versioning
discipline above is unaffected: its guard runs only in the template, for the
same reason.

**Core migrations are carried additively, not merged** (amended 2026-07, issue
#198). `services/api/migrations/versions/` stays user-owned — an applied
migration is immutable history and a three-way merge would rewrite an instance's
revision graph. But leaving it at that shipped a real bug: a core feature that
adds tables reached an instance as models and routers with **no migration**, dead
on arrival and 500ing on deploy (the orchestration tables were never carried, and
their revision id `0003` collided with a different `0003` already in the
instance, whose head was `0006`). So the upgrade runs a second, strictly
**additive** pass over that directory alongside the merge: migrations already
present are skipped, new ones are appended with their `down_revision` rewritten
to the instance's current head, and a colliding revision id is re-issued as a
deterministic `core_<hash>`. The post-carry chain is validated (every parent
resolves, one base, exactly one head) before a PR exists; any anomaly aborts the
upgrade and writes nothing. Crucially this happens **at CLI time**, producing a
reviewable file in the PR — never at deploy time, which is the failure mode
ADR-0003's Implementation Note records.

### 3. Three-way merge → branch → PR

`biffo core upgrade [--to <version>] [--repo <path>]`:

1. Resolve the instance's current core version (`biffo.core.json`) and the
   target (`--to`, default: the template's highest `core-v*` tag).
2. For each template-owned path, perform a **three-way merge**: base = the
   template at the instance's _current_ version, ours = the instance's working
   file, theirs = the template at the _target_ version. This preserves
   instance-local edits to core files where they don't conflict. The base and
   target trees are **auto-resolved** from the `core-v<version>` git tags (via
   `git archive` into temp dirs) — no manual checkouts required. `--from-template`
   / `--to-template` remain as overrides for pre-tag instances or local testing.
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
- Version bookkeeping (the `core-v*` tags / `biffo.core.json`) is new surface to
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
- New version-tracking surface (the `core-v*` tags, `biffo.core.json`) to keep
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
