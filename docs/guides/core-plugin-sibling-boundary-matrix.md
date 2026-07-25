# Core / Plugin / Sibling Boundary Matrix

This is a ground-truth account of how the three ways to extend a Biffo project
actually behave in code today — **core** (`services/api/`), **plugins**
(`services/_plugins/` and `services/<name>/`), and **sibling apps** (separate
repos scaffolded from `_skeletons/sibling-template/`). It's derived entirely
from reading the implementation and tests, not from the ADRs that motivated
them — use it to sanity-check whether the ADRs (0002, 0003, 0007, 0021) still
describe what the code does, and to decide which extension mechanism a new
piece of functionality actually belongs in.

Every file:line reference below was read directly out of `biffo-template` on
`main` (commit `38a2adb`). If code has moved since, re-verify before trusting
a specific line number — the shape of the boundary is the durable part.

## 1. The three mechanisms at a glance

| | **Core** | **Plugin** | **Sibling app** |
|---|---|---|---|
| **What it is** | `services/api/` — the one service allowed to touch Postgres | Declarative manifest (`biffo.plugin.json`) + code, either bundled in-repo (`services/_plugins/`) or installed (`services/<name>/`) | A wholly separate GitHub repo, own AWS footprint, scaffolded from `_skeletons/sibling-template/` |
| **Repo** | Lives in the core project | Lives in the core project's own repo (both first- and third-party) | Its own repo, created via `octokit.repos.createUsingTemplate` — fresh single-commit history, no ongoing git relationship to anything |
| **Database access** | Full — only place `asyncpg`/`sqlalchemy`/`psycopg` may be imported (Ruff `TID251`, `pyproject.toml:69-77`, exempted for `services/api/**` at `pyproject.toml:67`) | None directly. Declares `tables[]` in its manifest; Core synthesizes the SQLAlchemy model (`plugin_table.py`) and generates the Alembic migration. All reads/writes go through Core's generic-CRUD router (`plugin_router.py:64-135`), tenant-scoped, permission-gated per ADR-0004 | None. No DB dependency in the skeleton's `pyproject.toml` at all (verified: zero `asyncpg`/`sqlalchemy`/`psycopg` hits) |
| **How it reaches Core data** | *Is* Core | HTTP, via `packages/python-sdk`'s `BiffoAPIClient`/`SignedCoreClient`, SigV4-signed, to `/api/v1/plugins/<name>/*` (its own tables) or `/api/v1/internal/*` (Core-owned data) | HTTP, via the skeleton's own `core_client.py`, forwarding the **caller's own bearer token** — no privileged service credential |
| **Runtime/compute** | Own Lambda (`services/api`) | Either its own Lambda (event/data plugins, `main.py` handler pattern) **or** mounted into the single shared plugin-host Lambda (`services/_plugin-host/`) if it declares `user_ingress` | Its own Lambda + API Gateway + S3 bucket, provisioned by its own copy of `modules/cloud/aws/{storage,compute,api-gateway}` |
| **Routing/URL** | Core's own API Gateway | Event plugins: none (EventBridge-triggered). User-facing plugins: `ANY /api/v1/plugins/{proxy+}` → shared host → `Mount("/<name>", ...)` | Path-based on the **core's own** CloudFront distribution (`sibling_origins`, `modules/cloud/aws/cdn/variables.tf:71-115`) — no distribution of its own |
| **Auth model** | Verifies its own Cognito JWT | Shared host: extracts founder JWT, checks the plugin's declared `required_group` against Cognito (`mount.py`'s `group_gate`). Event plugins: SigV4 service-to-service only, no end-user auth | Same Cognito User Pool/App Client as core (`config.py:10-15`), SSO via shared-origin `localStorage`; re-verifies the JWT server-side independently (defense in depth) |
| **Deploy pipeline** | Core's own `biffo deploy` | Rides the core project's deploy (`deploy-app.yml` packages/deploys plugin Lambdas and the shared host as steps of the *same* workflow run) | Fully independent CI/CD (`.github/workflows/deploy.yml` in the skeleton), own Terraform state, own OIDC role — gated by `SIBLING_DEPLOY_ENABLED` |
| **Template ownership** | `services/api/` template-owned (except `migrations/versions/`) | Mechanism (`services/_plugins/`, `services/_plugin-host/`, scaffold, allowlist) template-owned; a specific third-party plugin's code (`services/<name>/`) is user-owned the moment it's installed | The scaffold (`_skeletons/sibling-template/`) is template-owned **as a source**; once copied into a new repo it is entirely outside `core-manifest.json`'s reach — there is no per-sibling manifest and `biffo core upgrade` has no code path that targets a sibling repo at all |
| **How it stays in sync with core** | N/A — it *is* core, upgraded like the rest of the template | `biffo core upgrade` (mechanism only); a third-party plugin's own code needs its *own* `biffo plugin upgrade` against the registry — no version-compatibility check exists yet (`required_core_version` is unverified, `plugin-upgrade.ts:60-77`) | One-time skeleton copy at creation, then only a narrow GitHub-Environment-variable push after every core deploy (`wireSiblingsAfterCoreDeploy`). No `core upgrade`-equivalent resync mechanism for the sibling's own code exists in code today |
| **Coupling back into the core repo** | N/A | None at install time — plugin install/uninstall/upgrade only ever touch the core repo's own `services/<name>/`, `modules/plugins/<name>/`, and an appended migration | `biffo sibling create` opens a **real PR against the core repo** (`siblings.auto.tfvars.json`) to register CDN routing — a one-time, reviewable coupling point, not a live write |
| **Cross-boundary calls** | N/A | No code path lets a plugin call another plugin or a sibling directly — everything transits Core | No code path lets a sibling call another sibling or a plugin directly — only one non-core endpoint setting exists (`NEXT_PUBLIC_API_URL`, its own backend) |

## 2. Use cases — which mechanism fits

**Use core when:** the functionality is fundamental to every tenant and every
product surface — auth, tenant scoping, the generic CRUD/permission engine,
anything that must be a single source of truth for schema. If it needs a new
table that the rest of the product depends on structurally (not just a
feature-specific one), it's core.

**Use a plugin when:** the functionality is optional, tenant-installable, and
expressible as *declared* tables/routes/events/tools rather than arbitrary
imperative backend logic Core must trust. Two sub-shapes exist today, and the
manifest — not the install location — decides which you get:

- **Event/data plugin** (no `user_ingress`): background processing, EventBridge
  reactions, agentic tools/chat agents. Gets its own Lambda and (if it needs
  it) an `execute-api:Invoke` grant to `/api/v1/internal/*`. This is the
  pattern the two first-party plugins (`orchestrator`, `agent-runtime`) use
  today.
- **User-facing plugin** (`user_ingress` declared): has its own UI/API surface
  end users hit. Ships **zero** per-plugin infrastructure — it's mounted into
  the shared plugin-host Lambda. As of this audit, no shipped-in-template
  plugin actually uses this path yet; it exists in the runtime
  (`services/_plugin-host/`) but is otherwise unpopulated in this repo.

**Use a sibling when:** the functionality is substantial enough to want its
own deploy cadence, its own repo/CI, its own compute — a distinct product
surface, not a feature. The cost is real: a separate repo to maintain, a
separate Terraform state, and (see §3) **no automatic mechanism to keep its
copied skeleton current** the way `biffo core upgrade` keeps the core project
current.

## 3. Complexity and pitfalls, ranked by mechanism

### Core

- Straightforward mentally (it's just the FastAPI app), but every change is
  instantly load-bearing for every tenant, every plugin, and every sibling —
  the highest blast radius of the three.
- The `TID251` Ruff ban is the only thing structurally preventing a
  regression back to "some other service imports a DB client directly" — it's
  a lint gate, not a runtime check, so it only catches new code at commit
  time, not a stray import already merged before the ban existed.

### Plugins

- **Two runtime shapes exist under one manifest concept**, and it's easy to
  reason about only one of them. An event/data plugin's blast radius is its
  own isolated Lambda; a user-facing plugin's blast radius is the *entire
  shared host process* — a crash or resource leak in one mounted plugin's
  ASGI app can degrade every other user-facing plugin sharing that Lambda.
  This is the direct trade the ADR-0021 consolidation made (fewer
  Lambda/API-Gateway/CloudFront stacks to drift, in exchange for shared
  fate at the process level).
- **No version-compatibility check exists.** `plugin-upgrade.ts` can't verify
  a plugin's `required_core_version` against the instance's actual core
  version before installing — there's no version endpoint on Core to ask.
  A plugin author declaring a minimum core version has no enforcement behind
  that declaration today.
- **Migrations are permanent, even after uninstall.** `plugin-uninstall.ts`
  removes source and Terraform but deliberately never drops tables or the
  generated migration file (`--keep-data` is a documented no-op) — an
  uninstalled plugin's schema footprint is forever, by design, not oversight.
- **The registry is thin.** "Marketplace" is a static `plugins.json` in a
  separate GitHub repo, currently empty, fetched client-side by both the CLI
  and the portal. There is no publish/review/hosting backend — getting a
  plugin listed is presumably a manual PR to that separate repo, entirely
  outside this template's own CI/governance.
- **A plugin cannot ship arbitrary route-handler code Core executes** — only
  `table`+`operation` declarations Core turns into generic CRUD. This caps
  what a plugin can do to end users' data by construction, but also means
  anything needing custom server-side logic beyond CRUD has to live in the
  plugin's *own* process and reach Core over HTTP for data — there's no
  "extend Core's request handling" hook.

### Sibling apps

- **The single biggest asymmetry with core and plugins: no upgrade
  mechanism for the sibling's own copied code.** `core-manifest.json` and
  `biffo core upgrade` have zero reach into a sibling repo — there's no
  per-sibling manifest, no version marker tracking which template version the
  skeleton came from, and no code path that even attempts to resync one. A
  bug fixed in `_skeletons/sibling-template/` (say, in `core_client.py`'s auth
  handling) reaches every *future* sibling created from the updated skeleton,
  but never an *existing* one — it would need a hand-authored, per-sibling
  manual PR, exactly the "absence of a mechanism" pattern that ADR-0006
  called out and fixed for first-party plugins. This is presently unfixed for
  siblings.
- **Real coupling hides behind a "separate repo" story.** A sibling is
  independently deployed, but `sibling create` still opens a PR against the
  *core* repo's Terraform inputs (`siblings.auto.tfvars.json`), and every
  core deploy pushes fresh identity values into the sibling's GitHub
  Environment. A sibling that predates a Cognito pool rotation, a CDN
  variable rename, or a change to `wireSiblingsAfterCoreDeploy`'s pushed
  variable set can silently stop receiving what it expects — there's a
  pre-flight check for CDN routing support (`assertCoreSupportsSiblingRouting`)
  but nothing symmetrical checking the sibling's own skeleton vintage against
  what the core now pushes.
- **Zero cross-sibling / sibling-to-plugin path is an absence, not a gate.**
  There's no code that would stop someone from adding a second base URL
  setting and calling another sibling directly — it simply doesn't exist yet.
  Worth treating as "not currently possible" rather than "actively
  prevented," when reasoning about what a determined implementer could bolt
  on.
- **Deploy is genuinely decoupled**, which is the intended win — a sibling's
  own outage or bad deploy doesn't touch core, and vice versa (modulo the
  identity-variable coupling above).

## 4. Summary judgment

The three mechanisms sit on a real complexity/isolation gradient:

- **Core** — maximum coupling, maximum blast radius, but a single coherent
  system with the strongest guarantees (DB-access ban is lint-enforced,
  tenant scoping is structural).
- **Plugins** — declarative, capability-bounded (CRUD-only data access,
  manifest-declared everything), but the "shared host" runtime shape trades
  per-plugin isolation for infra economy, and the upgrade/version-check story
  is still thin.
- **Siblings** — maximum isolation at creation time, but that isolation comes
  at the cost of an upgrade mechanism that doesn't exist yet — today, a
  sibling's own code is frozen at whatever the skeleton looked like the day
  it was created, with no supported path back to current.

The clearest gap this audit surfaces for follow-up: **siblings have no
`biffo core upgrade` equivalent.** Plugins solved this for first-party code
via the `services/_plugins/` carve-out (ADR-0006/#243) and for third-party
code via the registry + `plugin upgrade`; siblings have neither.

## 5. Plugin ownership has two axes — don't conflate them

Working through this matrix surfaced a distinction worth naming explicitly,
because it's easy to see "first-party vs third-party" and "declarative vs
custom-code" as the same split. They aren't.

- **Axis A — source custody** (`services/_plugins/` vs `services/<name>/`):
  who keeps a plugin's *copy* current over time — the template (`core
  upgrade`) or the instance (`plugin upgrade`). This only exists to let
  Biffo itself ship a small number of platform-capability plugins
  (`orchestrator`, `agent-runtime`) in lockstep with core. It was never meant
  to scale — every third-party plugin, regardless of count, funnels through
  the identical `services/<name>/` channel.
- **Axis B — execution trust** (declared-and-Core-executed vs
  plugin's-own-process): what a plugin is allowed to *do*. A plugin never
  runs code inside Core — it declares a `tables[]`/`api_routes[]` surface
  that Core synthesizes and executes generically (`plugin_table.py`,
  `plugin_router.py`), and anything beyond plain CRUD runs in the plugin's
  own sandboxed process, calling back over a signed HTTP identity. This is
  the actual security perimeter (ADR-0002's DB-access ban, extended to
  untrusted third-party code) and applies identically to first- and
  third-party plugins alike — `orchestrator` doesn't get to run inside
  `services/api/` either.

**These should not be collapsed into one axis.** Axis A already simplifies on
its own once third-party volume grows — first-party stays a small,
template-controlled set, and every marketplace plugin uses the one
third-party branch already. Axis B is the security boundary that makes it
safe to run *any* third-party code at all; weakening it (e.g. letting a
plugin's code execute inside Core, or hand it a DB client) would be a
regression in exactly the direction more third-party authors makes riskier,
not safer.

### Where real complexity would show up at marketplace scale (not yet, deferred)

Current state: **one author, 5-10 plugins.** None of the below is worth
building today — the two-axis model already holds at this volume without
friction. Listed here so the gap is visible before it's load-bearing, not as
a call to act now:

1. **No `required_core_version` enforcement.** Declared in the manifest but
   never checked (`plugin-upgrade.ts:60-77`) — fine when one author tracks
   their own core version; becomes a real breakage vector once plugins are
   authored against core versions their installer hasn't upgraded to yet.
2. **The registry is a static, unreviewed JSON file** (`plugins.json` in a
   separate repo, currently empty) — no publish intake, no automated or
   manual review before install. Adequate for self-publishing 5-10 plugins;
   not a marketplace yet for outside authors.
3. **Every install vendors a full copy into the instance's own repo**, with
   no bulk-upgrade command — per-plugin `plugin upgrade` is fine at
   single-digit counts, tedious at dozens.
4. **The shared plugin-host is one Lambda for every mounted user-facing
   plugin.** Blast-radius/cold-start/resource-isolation is a non-issue at a
   handful of mounted apps; worth stress-testing before it's load-bearing at
   real concurrency.
5. **Uninstall never drops schema** (tables/migrations persist forever by
   design, `plugin-uninstall.ts`) — negligible drift at low plugin churn,
   accumulates indefinitely under a try-and-discard marketplace pattern.

Revisit this section when either axis actually strains — i.e. when a second
external author wants to publish, or plugin count moves toward the dozens.

## 6. Risks in the pattern today

Unlike §5's list, these hold regardless of author count or plugin volume —
they're properties of the current implementation, not growth pains. Ranked by
severity; exposure (latent vs. realized) noted per item.

1. **High, currently latent — the shared plugin-host has no real isolation
   between co-mounted plugins' identities.** `acting_as_plugin`
   (`signed_client.py:44`) is a plain module-level `ContextVar` in
   `biffo_plugin_sdk`. The host's `group_gate` sets it correctly per request
   based on which URL segment was hit (`mount.py:107-112`), and outbound
   calls stamp it into the signed `X-Biffo-Plugin` header before SigV4
   (`signed_client.py:85-90`) — but every mounted plugin's own code runs in
   the *same interpreter, same process*, and can import that identical SDK
   module. Nothing stops a plugin from calling
   `acting_as_plugin.set("other-plugin-name")` itself before making its own
   request; Core would then grant it `system:other-plugin-name`'s internal-API
   permissions — exactly the identity ADR-0021 §1a exists to assert
   correctly. A plugin running in its own separate Lambda cannot do this (its
   IAM role identifies it, and Core's `_asserted_plugin_identity` only trusts
   the header when the caller is `system:host`) — this is specific to
   plugins sharing the host process. Today it's latent: no `user_ingress`
   plugin exists in the template yet, so nothing is actually co-mounted. It's
   the property to design around (per-plugin resource/permission limits, code
   review, a binding stronger than a ContextVar) before the first
   user-facing plugin — first- or third-party — lands in that shared
   process. The trust boundary here is application-code convention, not
   something the OS or network enforces, unlike the per-Lambda model it
   replaced.
2. **Medium — `plugin install` commits a real schema migration in one
   uninterrupted step.** `plugin-install.ts` goes manifest → synthesized
   SQLAlchemy model → generated Alembic migration → `git commit`, with no
   review checkpoint inside the tool itself. A crafted or buggy manifest
   reaches your production schema shape in one CLI invocation; the only
   backstop is reviewing the commit before it merges, not anything
   CLI-enforced.
3. **Medium — CRUD permissions are self-declared, not independently
   reviewed.** Core enforces default-deny (ADR-0004) on whatever a table's
   `permissions` block says, but that block's contents are entirely the
   plugin author's own manifest — nothing validates a declared access scope
   against policy before code that relies on it runs.
4. **Low today, compounds with churn — uninstall never drops schema.** Same
   fact as §5 item 5, restated as a present risk: any plugin tried and
   removed leaves its tables/migrations permanently and silently, by design
   (`--keep-data` is a documented no-op).
5. **Informational — the ownership guard's real enforcement point is CI, not
   the local hook.** The local pre-commit hook is bypassable with
   `--no-verify`; CI (gated by branch protection) is the actual backstop.
   Deliberate defense-in-depth, not a flaw, but worth knowing the local hook
   alone isn't sufficient if branch protection is ever misconfigured.
