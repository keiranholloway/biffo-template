# Feature: declared-route forwarding fails closed when the table authorises nobody

Implements the owner's **option B** decision on `keiranholloway/biffo-plugin-marketing#40`
(2026-08-24), tracked as `keiranholloway/biffo-template#1736`.

## Summary

The shared plugin host forwards a plugin's manifest-declared `api_routes` to Core
(`services/_plugin-host/src/plugin_host/forward.py`, #652) and relies **solely** on the
table's ADR-0004 `required_role` for authorisation. The forwarder sits *outside* the
plugin's group gate deliberately, so that an `admin` caller is not rejected by a plugin
whose `user_ingress.required_group` is `founder`.

When a table's rule for the requested operation expresses **no authorisation at all**,
nothing is checked anywhere: the host does not gate, and Core's
`require_principal_crud_permission` passes an empty `required_role` and an empty
`permission_code` for any authenticated caller of the tenant. Reproduced live against
the deployed tabsii dev API Gateway origin: an `hq-admin` persona JWT carrying **no
`cognito:groups` claim at all** returned **HTTP 200 with real records** from five
marketing data routes, while the same mount correctly returned
`403 {"detail": "This surface requires the 'founder' group."}` on a sub-route it
evaluates itself. The group gate works; declared routes never reach it.

The fix makes the forwarder fail closed **only where nothing was checked**:

> When a declared route's table rule for the requested operation expresses no
> authorisation of its own, the forwarder falls back to the plugin's
> `user_ingress.required_group` and refuses the request if the caller has not passed
> it. When the rule expresses any authorisation, behaviour is unchanged and Core
> remains the sole authority.

No new Core vocabulary, no plugin has to declare anything, every plugin with an open
table is fixed at once, and it reverts in one action.

## Success criteria

Observable, in this order:

1. **The hole is closed at the host.** A declared route whose table rule authorises
   nobody, called with a token that has not passed the plugin's
   `user_ingress.required_group`, gets a **403 JSON body from the host** and
   `send_to_core` is **never called** — asserted on the fake Core's call log, not just
   on the status.
2. **The case the docstring protects still works.** A declared route whose table rule
   has a non-empty `required_role` is forwarded exactly as today: an `admin` caller
   still reaches `marketing_click` and `marketing_spend` through the generic CRUD path,
   with the plugin's `founder` gate not consulted.
3. **A plugin with no group to fall back to is unchanged.** No `user_ingress`, or a
   `user_ingress` with no `required_group`, forwards as today — no invented group.
4. **Fail-first proven.** Criterion 1's test is shown red against the parent commit and
   green with the change, in the PR body. A suite that was never red proves nothing.
5. **Replayed against deployed dev.** The original reproduction re-run on the
   `tabsii-platform-dev-api` origin returns **403 instead of 200** for the `hq-admin`
   persona on all **five** open routes (`/campaigns`, `/artefacts`, `/assets`, `/links`,
   **`/channels`**), while an `admin` caller still gets 200 on `/clicks` and `/spends`.

Criteria 1-4 are milestone 1; criterion 5 is milestone 2.

## Scope / explicitly deferred

**In scope**

- The host-side fallback rule above, plus the wiring that gives the forwarder the facts
  it needs (each declared route's resolved table rule, and the plugin's user group).
- A loud log line for the one case the rule cannot fix — a route that authorises nobody
  on a plugin with no group to fall back to. It stays open (criterion 3) so the change
  cannot be an outage; it must not stay *silent*.
- Distribution to the instance and the replayed reproduction that closes #1736.

**Explicitly deferred — do not build**

- **Option A** — group granularity in Core's `required_role` vocabulary (e.g. "any
  authenticated caller, but only from group X"). The owner named this a one-way door and
  deliberately deferred it. Nothing in this plan may add vocabulary to
  `services/api/src/api/models/plugin_table.py` or the SDK's `PermissionRule`.
- **Option C** — editing `biffo-plugin-marketing`'s manifest to hardcode `founder`.
  Rejected by the owner; `biffo-plugin-marketing#40`'s closing comment says that repo's
  manifest is deliberately left as it is, and that a later cosmetic tightening must not
  be mistaken for the fix.
- Per-row / per-`kind` filtering on `marketing_artefact` (gap 2 of `#40`). Still open,
  still unowned, out of scope here.
- Cross-tenant reads. `tabsii-com/tabsii-platform#1138` likely closed that dimension;
  it was never proven either way and is not claimed here.

## Current state

Read from `origin/dev` at `ec8c50b2` (2026-08-29). Nothing below is assumed from the
issue text.

**`forward.py`** — `DeclaredRouteForwarder` holds only `(method, compiled path)` pairs.
`matches()` returns a bool. `forwarding_gate(plugin_app, forwarder, token_of=...)`
refuses a request with no token (401) and otherwise forwards. **There is no authorisation
decision in this module at all**, and no access to the plugin's group.

**`discover.py`** — `DeclaredRoute` is `frozen dataclass(method, path)`. The manifest's
`api_routes` entries are `biffo_plugin_sdk.plugin.RouteDef`, which **already carry
`table` and `operation`**, and `PluginManifest` already validates that every route's
`table` is declared in the same manifest's `tables`. So the table rule for a route is
resolvable at discovery time from data the host already parses — no new manifest field
and no new parser. `DiscoveredPlugin` already carries `required_group`.

**`mount.py`** — `build_host` wraps the group-gated user app in `forwarding_gate` when
`p.api_routes` is non-empty and `send_to_core` is not None. It has both the plugin's
`required_group` and the injected `authorize` in scope at that point; neither is
currently passed to the forwarder.

**`authz.py`** — `cognito_authorizer` adapts the SDK's `authorize(token,
required_group=...)` to `Authorizer = Callable[[str, str], Any]`, raising
`GateError(403|401)`. This is the existing group check to reuse; the milestone must not
re-implement a group check.

**Core (`services/api/src/api/dependencies.py`)** — `require_principal_crud_permission`
ANDs the two ADR-0004 axes: `permission_code` (#1606, added and closed) then
`required_role`. An empty `required_role` authorises any authenticated caller; an empty
`permission_code` is not checked. **This is why the fallback condition must be "the rule
expresses no authorisation" — `not required_role and not permission_code` — not
"`required_role` is empty" alone.** A table gated only by a `permission_code` has
expressed authorisation, and applying the group fallback to it would re-introduce
exactly the admin-rejection regression the docstring protects. See "Decisions" below.

**Marketing manifest (`biffo-plugin-marketing`, `origin/dev`)**, the live shape this is
judged against:

| table | list/read | create/update/delete |
|---|---|---|
| `marketing_campaign`, `marketing_artefact`, `marketing_asset`, `marketing_link`, `marketing_channel` | `allowed`, `required_role: []`, no `permission_code` | `['admin']` |
| `marketing_click`, `marketing_spend` | `['admin']` | `['admin']` |

`user_ingress.required_group: "founder"`, `admin_ingress.required_group: "admin"`.
Five open tables, not the four named in `#40`'s title — `marketing_channel` carries the
identical open `list`/`read` and must appear in every test list and in the replay.
No table has an open write, so the exposure is read-only.

**In flight:** none. No open PR touches `services/_plugin-host/`, no remote branch
matches `*1736*` or `*forward*`, and `scripts/claim.sh 1736 --check` reports only this
planning session's own Foreman lease.

**Already built, do not rebuild:** `permission_code` as a manifest axis (#1606, closed),
the group gate itself (`mount.group_gate` + `authz.cognito_authorizer`), the
`X-Biffo-User-Token` forwarding path (#652/#621), and the JSON-not-HTML failure shape.

## Cross-repo boundary

Computed by longest matching prefix in `core-manifest.json` at `origin/dev`, not
inferred from where the issue was filed:

| path | longest prefix match | owner |
|---|---|---|
| `services/_plugin-host/` | `services/_plugin-host/` (`templateOwned`) | **biffo-template** |
| `packages/python-sdk/` | `packages/` (`templateOwned`) | biffo-template (not touched) |
| `services/marketing/biffo.plugin.json` (instance) | no `templateOwned` prefix | instance / plugin repo (not touched) |

So **all code changes land in `keiranholloway/biffo-template`**. The identical path is
vendored into `tabsii-com/tabsii-platform`; per this estate's always-build-upstream rule
the instance copy is **distributed** by `biffo core upgrade`, never patched in place — a
change written into the instance is silently reverted by the next upgrade.

The replayed reproduction is instance work: it needs the distributed code deployed to
`tabsii-platform-dev-api` and an SSM-minted persona token. That is milestone 2, filed in
`tabsii-com/tabsii-platform`.

## Decisions taken while planning

**1. The fallback condition is "the rule authorises nobody", not "`required_role` is
empty".** The issue's wording predates nothing — it is simply narrower than the model.
`PermissionRule` has two axes and Core ANDs them. Gating a `permission_code`-only table
on the plugin's user group would reject a caller who holds the code but is not in the
group: the same class of regression as rejecting `admin` on `marketing_click`. The
implemented predicate is therefore:

```
fallback applies  <=>  rule.allowed and not rule.required_role and not rule.permission_code
```

On today's manifests this is **behaviourally identical** to the issue's wording — no
live plugin sets `permission_code` (the published SDK gate is why; see `#40`) — so this
is a correctness refinement with no observable difference on the reproduction, not a
change of decision. If the owner prefers the literal wording, say so on the milestone
issue and the predicate drops one conjunct.

**2. A route whose rule is `allowed: false` is left alone.** Core answers 404 for it
(deliberate indistinguishability). The host must not turn that into a 403 and leak the
route's existence.

**3. No group to fall back to means forward, and log.** Criterion 3 is the owner's
("do not invent one"). The honest consequence is that such a route stays open, so the
milestone logs it at ERROR at discovery, once per route, naming plugin/table/operation.
Silence here is how this defect survived in the first place.

## Milestones

Two. They are sequential, not parallel: milestone 2 cannot start until milestone 1's
code is on `dev`, and carries `depends-on`.

### M1 — the host refuses a declared route that nothing authorises

*Repo:* `keiranholloway/biffo-template`. *Size:* one builder, one dispatch, ~80k tokens.
No schema, no RLS.

*Read set (exclusive while in flight):* `services/_plugin-host/` — `src/plugin_host/`
(`forward.py`, `discover.py`, `mount.py`, `authz.py` read-only) and `tests/`. Also
**reads** `packages/python-sdk/src/biffo_plugin_sdk/plugin.py` (`RouteDef`,
`TablePermissions`, `PermissionRule`) without changing it.

*The work, as a thin path through the layers:*

1. `discover.py` — resolve each `RouteDef` against the manifest's `tables` and put the
   answer on `DeclaredRoute`: enough to decide the predicate in decision 1 (e.g.
   `required_role: tuple[str, ...]`, `permission_code: str`, `allowed: bool`, or a
   single derived `authorises_nobody: bool` — the builder's call, but the raw facts age
   better than a derived flag). Defaults must keep every existing
   `DeclaredRoute(method=..., path=...)` construction valid.
2. `forward.py` — `DeclaredRouteForwarder` returns the matched route rather than a bool;
   `forwarding_gate` gains the plugin's `required_group` and an authorizer, and when the
   matched route authorises nobody, calls the authorizer and answers `GateError`'s
   status and detail as JSON **without calling `send_to_core`**. Update the module and
   `forwarding_gate` docstrings: they currently state the old rule as deliberate, and a
   docstring that outlives its behaviour is how the next reader gets this wrong.
3. `mount.py` — pass `p.required_group` and `authorize` through to `forwarding_gate`.
4. `discover.py` — ERROR log for decision 3's unfixable case.

*Done is observable when, in `services/_plugin-host/tests/`:*

- a declared route with `required_role: []`, `permission_code: ""`, called by a token the
  injected authorizer rejects → **403**, body is JSON carrying the gate's detail, and the
  fake Core's `calls` list is **empty**;
- the same route, caller the authorizer accepts → forwarded, `calls` has one entry;
- a declared route with `required_role: ['admin']` → forwarded **without the authorizer
  being consulted at all** (assert on a spy, not on the status alone) — the
  `marketing_click`/`marketing_spend` regression guard, named as such in the test;
- a plugin with `required_group=None` and an open route → forwarded, as today;
- an `allowed: false` route → unchanged (still forwarded; Core answers 404);
- every existing test in `test_forward.py`, `test_mount.py`, `test_discover_authz.py`
  passes unchanged, or its change is justified in the PR body;
- the PR body shows the first test **red on the parent commit** and green with the fix.

*Independently mergeable:* yes — it is one behaviour change plus its tests, in one repo,
behind no flag. It is not partial value: on merge, every plugin on the host with an open
declared route is fixed at the template.

*Why this is not two milestones:* a `DeclaredRoute` carrying permissions with no reader
changes nothing, and an enforcing forwarder without those facts cannot compile. They
must land together, which by rule 3 makes them one milestone. They also share
`src/plugin_host/`, so they could never be built in parallel anyway.

### M2 — distribute, deploy, and replay the reproduction

*Repo:* `tabsii-com/tabsii-platform`. *Depends on:* M1 merged. *Size:* one dispatch;
mostly a `biffo core upgrade` PR and a scripted replay.

*Read set:* `tabsii-platform`'s vendored `services/_plugin-host/` and `services/marketing/`
— a different repo from M1, and gated behind M1 anyway, so no collision.

*The work:*

1. `biffo core upgrade` in `tabsii-platform` to carry M1's `services/_plugin-host/`
   change in; resolve conflicts by reading them, never by taking a side blind.
2. Merge and let the instance deploy reach `tabsii-platform-dev-api`.
3. Mint a real `hq-admin` persona JWT (SSM `/tabsii/dev/simulation/personas/hq-admin`,
   the pool client `#40` records) and replay the original reproduction against the API
   Gateway origin — **not** `dev.biffo.io` and not a CloudFront path.

*Done is observable when, pasted into the milestone issue as raw output:*

- `GET /api/v1/plugins/marketing/{campaigns,artefacts,assets,links,channels}` with the
  `hq-admin` token → **403** on all **five** (`channels` included — it was missing from
  `#40`'s original list of four);
- the same five with a `founder`-group token → still **200**, so the fix denied the
  right caller rather than everyone;
- `GET /api/v1/plugins/marketing/{clicks,spends}` with an `admin` token → still **200**;
- the deployed artefact is confirmed to contain M1's commit, not merely the CI green —
  a green pipeline is not a deployed Lambda.

*Honest constraint:* an unauthenticated 401 proves nothing here. Every assertion above
needs a real minted token.

*If the replay cannot be run* (no instance access, ratchet tripped, deploy blocked), the
milestone is **not** closed on "M1 merged". It stays open, says so plainly, and
`#1736`'s own closing comment on `biffo-plugin-marketing#40` — *"a merged PR is not
evidence"* — is why.

## Testing plan

- **Unit, M1** — `services/_plugin-host/tests/`, the assertions listed under M1. Run
  locally with `uv run pytest services/_plugin-host`; CI runs the whole workspace suite
  (`uv run pytest --cov`) plus `ruff` and `pyright`, and the plugin-host package is a
  workspace member, so no new CI wiring is needed.
- **Fail-first** — required by the issue's acceptance list. Commit the test first, show
  it red against the parent commit, then the fix.
- **Regression** — the existing `test_forward.py` (358 lines) already encodes the
  "forwarder sits outside the group gate on purpose" contract. Those tests must keep
  passing; any that must change indicate the fallback is too broad and is the signal to
  stop and re-read decision 1.
- **Live, M2** — the replay above. This is the only test that speaks to the reported
  defect; everything before it is a proxy.

## Rollout

1. M1 merges to `biffo-template` `dev`. Effective immediately for every instance that
   subsequently takes a core upgrade; no flag, no migration, no data change.
2. M2 distributes to `tabsii-platform` and deploys; the replay closes `#1736`.
3. **Revert path:** one commit. The change is confined to the host's forwarding path and
   restores exactly today's behaviour if reverted.
4. **Blast radius to watch on deploy:** any plugin with a declared route on a table that
   authorises nobody, whose legitimate callers are *not* in the plugin's
   `user_ingress.required_group`. Today's live set is marketing's five tables, whose
   legitimate caller is the `founder`-gated user app — so none expected. A 403 spike on
   `/api/v1/plugins/*` after deploy is the signal that assumption was wrong on some other
   installed plugin; the revert in 3 is the response.
5. `biffo-plugin-marketing`'s manifest is deliberately **not** changed. Once M1 lands its
   empty `required_role` becomes inert rather than dangerous.
