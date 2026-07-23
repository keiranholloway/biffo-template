# Guide: Upgrading an Instance's Core (`biffo core`)

`biffo core` pulls improvements from the Biffo template into a repo you already scaffolded — the FastAPI Core API, the shared Terraform modules, the CI workflows, the CLI — **without a teardown and without hand-copying files**. It three-way-merges the template-owned files, preserving your local edits where they don't collide, and proposes the result as a **pull request** that your instance's own CI deploys on merge.

For the design rationale (why a PR-based sync rather than a package or a submodule), see [ADR-0006](../ADR/0006-core-upgrade-and-template-sync.md).

## The three commands

| Command                        | What it does                                                              |
| ------------------------------ | ------------------------------------------------------------------------- |
| `biffo core status`            | Reports your instance's core version vs the latest, read-only             |
| `biffo core diff`              | Lists the template-owned files an upgrade would change, read-only         |
| `biffo core upgrade [--apply]` | Three-way-merges those files; with `--apply`, opens a PR on your instance |

`status` and `diff` never write anything. `upgrade` without `--apply` is a dry run (it prints the plan); only `--apply` creates a branch and a PR — and even then it never pushes to a protected branch or touches infrastructure.

## Core versioning

Two things track versions, and they mean different things:

| Where             | Meaning                                                                 | Who owns it                                                         |
| ----------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `core-v*` tags    | the version the **template emits** — the highest tag is its current one | the template; **never pushed into an instance's tag namespace**     |
| `biffo.core.json` | the version your instance **received** (scaffolded from / upgraded to)  | your instance; also the marker that says "this repo is an instance" |

No file names the template's version: it is derived on merge from the highest `core-v*` tag and the type of the change being released. Your instance's version is whatever `biffo.core.json` records, which is what `status`, `diff` and `upgrade` read. An instance scaffolded before that record existed may still carry an inherited `core.version` file, which is used only as a fallback — **`biffo core upgrade` deliberately leaves that file alone** (it is not listed as template-owned in `core-manifest.json`), so if your project has repurposed it for its own release lineage, an upgrade will not touch or regress it.

For the same reason, the `Core Version Tag` workflow (which tags `core-v<version>` on the template) skips itself in an instance, detected by the presence of `biffo.core.json` — it will not push template version tags into your tag namespace.

An upgrade bumps `biffo.core.json` in the same PR. Instances scaffolded before versioning existed won't have `biffo.core.json` yet — the first `upgrade` creates it (see the note at the end).

## What gets touched (and what never does)

Ownership is declared in the template's `core-manifest.json`. Only **template-owned** paths are ever changed:

- **Template-owned:** `services/api/`, `services/_template/`, `modules/`, `packages/`, `cli/`, `.github/`, `scripts/`, and root tooling configs.
- **Left alone (user-owned):** your plugins under `services/<name>/` (first-party plugins under `services/_plugins/` _are_ carried — see ADR-0003), `infra/environments/`, `apps/`, `db/`, `docs/ADR/` (your own decision record), `services/api/migrations/versions/` (your Alembic chain), and your config files.

On any ambiguity, user-owned wins — the upgrade is fail-closed and never touches a path it isn't sure the template owns.

### The boundary is guarded at commit time, not just at upgrade time

Declaring the boundary does not stop you crossing it. The drift that makes upgrades painful arrives as ordinary commits editing a template-owned path in your instance — each harmless on the day, each a merge conflict months later. One instance took 98 such commits over six months; the upgrade that finally closed the gap was 316 changes with 41 conflict hunks, one of which would have run `CREATE TABLE` against a live database.

So the same ownership rule runs as a guard:

- **`.husky/commit-msg`** — refuses the commit, naming the paths.
- **CI, on every PR** — the same check, which `--no-verify` cannot skip.

It is inert in `biffo-template` itself, where changing these paths is the entire point.

Five ways past, in order of preference:

1. **Put the change in a user-owned path.** Usually the right answer.
2. **Make it upstream** in `biffo-template` and take it with `biffo core upgrade`. The answer whenever the change is genuinely core.
3. **A `Core-Convergence:` trailer**, when the change REMOVES divergence — reverting a template-owned file to the template's own content, or deleting one the template no longer ships:

   ```
   Core-Convergence: <what this reverts toward the template>
   ```

   The guard cannot see file content (it runs in a commit hook with no template checkout), so it cannot tell a revert-toward-template from any other edit. This trailer says so explicitly, and is kept **distinct from `Core-Divergence:`** so a convergence never reads as drift to chase later — it is drift being removed, not added.

4. **A `Core-Divergence:` trailer** in the commit message, when the instance genuinely must differ:

   ```
   Core-Divergence: <why this instance must differ from the template>
   ```

   The commit is allowed and the exception lands in history rather than being argued about later. Raise an upstream issue alongside it.

5. **A warn-only prefix in `biffo.divergence.json`**, for a boundary you knowingly sit astride while an upstream fix is pending:

   ```json
   {
     "warnOnly": [
       {
         "prefix": "apps/portal/",
         "reason": "product UI predates the boundary widening in core 0.41.18",
         "upstream": "keiranholloway/biffo-template#360"
       }
     ]
   }
   ```

   Such paths warn instead of blocking. `upstream` is required: an entry with no issue to close it is permanent drift wearing a temporary label. Keep the list short — every entry is a standing admission that something will conflict at your next upgrade.

A core-upgrade branch (`biffo/core-upgrade-*`) is exempt entirely, since that is precisely when these paths are meant to move.

### Core migrations are appended, never merged

`services/api/migrations/versions/` is user-owned, so the three-way merge never rewrites a migration you have already applied. But a core feature that adds tables needs its migration to reach you, or it arrives as models and routers with no schema and 500s on deploy. So the upgrade runs a separate, strictly **additive** carry for that directory:

- A migration you already have is **skipped** — applied history is immutable. See _How a carried migration is recognised_ below; it is not just the filename.
- A new core migration is **appended**: its `down_revision` is rewritten to your chain's current head, so it extends your chain rather than forking a second one.
- If the template's revision id is already used in your repo (the classic `0003` collision), the carried migration gets a deterministic `core_<hash>` id instead. Your migration keeps its id.
- The resulting chain is validated — every parent resolves, one base, exactly one head — **before** the PR is opened. If your chain is already broken or branched, the upgrade aborts with the reason and writes nothing.

All of this happens once, at CLI time, and lands as a reviewable file in the PR. Nothing is generated or re-chained at deploy time (see ADR-0003's Implementation Note for the incident that rule exists to prevent). Re-running an upgrade is idempotent.

Review the carried DDL like any other migration before merging: merging runs it against your database on the next deploy.

#### How a carried migration is recognised

Getting this wrong is expensive in one specific direction. If the upgrade fails to recognise a migration you already have, it carries it again — and `op.create_table(...)` runs against a database that already has those tables. Since `db-init` runs `alembic upgrade head` on every deploy, that surfaces as a **failed deploy**, not a caught mistake.

Recognition used to be by filename alone, which is defeated by the very thing an upgrade pushes you into doing: when a carried migration's revision id collides with one of yours it gets re-issued, and the natural tidy-up is to rename the file to match its new id. Same migration, already applied, no longer recognised.

So each carried migration is stamped with its origin:

```python
# biffo:carried-from: 0003_create_orchestration_tables.py
revision: str = "core_f85dc07e"
```

That line is the identity. **Keep it** — rename and renumber the file freely, but do not delete the marker, and do not copy it onto a migration it did not come from.

Migrations carried before this existed have no marker, so they are recognised by their DDL instead (compared with the chaining metadata stripped out, since that is what a carry legitimately rewrites). That covers the renamed-but-unmodified case, which is the common one.

If a file looks like a carried migration — same description — but its contents differ and it has no marker, the upgrade **stops** rather than guessing. Skipping would leave you with core models and no schema; carrying would run DDL against a live database. Neither is inferable, so it tells you both filenames and asks you to either add the marker (if it is that migration) or rename it (if it is not).

Anything the upgrade recognises by something other than its filename is printed as `already carried`, so you can see when your instance is in this shape.

## Destroying stateful infrastructure

`terraform apply` runs with `-auto-approve`, so nothing pauses for a human. A guard in the **Plan** job (before Apply, so refusing costs nothing) fails the deploy if the plan would destroy a database, a Cognito user pool, an S3 bucket or another resource whose data no re-apply can recreate.

**A replacement counts.** Terraform encodes it as delete-then-create, and it destroys the original just as surely. That is the case that actually happens: on `aws_db_instance`, `identifier`, `db_name` and `username` all force replacement and all derive from `project_name`, so renaming the project plans a database destroy from an edit that looks like a rename.

If the destruction is intended, say so in the commit message:

```
Infra-Destroy: replacing the user pool for the 0.50.0 identity change; users re-invited
```

Take a backup first if the data matters. The destroyed resources are listed in the job summary either way, so an authorised destroy is still visible afterwards rather than buried in a log.

The guard is deliberately narrow — it ignores Lambdas, roles, security groups and everything else Terraform rebuilds from this repo. A guard that fired on every deploy would have its trailer added by reflex, and would then be protecting nothing.

## Breaking changes by version

### 0.54.0 — first-party plugin Terraform is referenced in place

`orchestrator` and `agent-runtime` are **first-party** plugins: their Terraform lives in the template-owned `services/_plugins/<name>/terraform/` and rides `biffo core upgrade` like any other core file.

Until now it was also _copied_ to `modules/plugins/<name>/` at install time, and that copy is what Terraform read. The copy was never re-synced, so **an upgrade updated the source and left the deployed module frozen at install time** — silently. Measured in a live instance right after a clean upgrade: `agent-runtime` 53 lines adrift, `orchestrator` 15.

New instances need nothing: `biffo plugin install` now sources first-party plugins from their real path.

**An existing instance must change one line per environment**, because module sources live in user-owned `infra/`, which an upgrade cannot touch:

```hcl
module "plugin_agent_runtime" {
-  source   = "../../../modules/plugins/agent-runtime"
+  source   = "../../../services/_plugins/agent-runtime/terraform"
```

Then delete the dead copy:

```bash
git rm -r modules/plugins/agent-runtime modules/plugins/orchestrator
```

`biffo core upgrade` warns when it finds a first-party plugin that still has a copy, so you do not have to remember.

Order does not matter and nothing breaks mid-migration: each directory's internal module reference matches its own location, so the old copy keeps working until you stop pointing at it.

Third-party plugins are unaffected — for them the copy _is_ the delivery mechanism, since their source comes from a registry repo rather than this tree.

Most of an upgrade is additive. A few changes **destroy data or require manual
work**, and Terraform will apply them without ceremony — a Cognito pool
replacement reads as an ordinary `-/+ resource` line in a plan nobody scrolls
through.

**`biffo core upgrade` reads this list for you.** It prints every entry the
upgrade crosses before the plan, puts them at the top of the PR body, and
refuses `--apply` until you pass `--acknowledge-breaking`. You no longer have to
remember the list exists — but you do have to read what it says, because the
manual steps below are not something the CLI can do for you.

Entries are matched as `from < version <= to`: an instance already **on** a
breaking version is not warned again, one moving **to** it is.

### 0.50.0 — the email address becomes the sign-in identity

`modules/cloud/aws/auth` moves from `alias_attributes = ["email"]` to
`username_attributes = ["email"]`.

**This REPLACES the Cognito user pool and deletes every user in it.** Cognito
cannot migrate users between pools with their passwords intact, and the two
settings are mutually exclusive and immutable, so there is no in-place path.

What you must do:

1. **Re-invite every user** after the upgrade deploys. They keep their email
   address; they get a new temporary password.
2. **Expect orphaned rows** in anything keyed on `cognito_sub` (ADR-0012). Each
   re-invited user gets a new `sub`. Reconcile or clear those tables.
3. **Tell your users first.** Their existing password stops working the moment
   the deploy lands.
4. **Redeploy every dependent sibling.** A sibling's API validates core-issued
   tokens against the core pool's _issuer_, baked into its API Gateway JWT
   authorizer and its Lambda at deploy time (ADR-0007). A replaced pool has a new
   issuer, so each sibling 401s otherwise-valid tokens until it redeploys. This
   staleness is deliberate, not a gap to close with runtime discovery: a trusted
   issuer is a security declaration and belongs in static, version-controlled
   config, not in a document an authorizer fetches at request time. Its frontend
   already self-heals (it resolves the core's _non-secret_ client config at
   runtime, #403); its backend does not, because redeploying infrastructure is
   the correct response to a changed dependency. So after the core deploy lands,
   trigger each registered sibling's Deploy workflow. Then run `biffo sibling
   check-identity` from the core: it compares every sibling's baked pool id (and
   the published identity document) against the live pool and fails loudly on any
   still pointing at the old one (#400), so you can confirm they have all caught
   up rather than discovering a stale sibling as a 401 days later.

This is the general shape of **any** pool replacement, not just this upgrade —
Cognito forces a replace on any change to an immutable attribute
(`username_attributes`, `alias_attributes`, `schema`). It is a rare, deliberate,
destructive event (you are re-inviting every user regardless), so the runbook
above — redeploy dependents, then verify with the detection net — is the
intended path, not automation papering over a routine occurrence.

Why it is worth the cost: the pool previously had a username _and_ an email
that had to agree, and that split leaked through the whole product — the sign-in
field asked for "Username or email", the invite email had to explain "this is
your username, not your email address", and the admin create-user API defaulted
the username to the email, which an email-alias pool rejects outright. It also
made one person able to become two accounts: a federated sign-in (Google)
carrying an already-registered address creates a second profile with its own
`sub` and moves the email alias to it, silently leaving the original user unable
to sign in with their own address. With the address as the username it is unique
pool-wide, so that collision surfaces instead of corrupting an identity.

## 1. Check where you stand

```bash
biffo core status
```

```
  current (this instance):  0.1.0
  latest  (this CLI):       0.2.0
ℹ Upgrade available: 0.1.0 → 0.2.0.
```

## 2. Preview the change

`diff`/`upgrade` compare against a **template checkout**. Point `--to-template` at a `biffo-template` checkout at the version you want (default: the version the CLI ships with):

```bash
git clone https://github.com/keiranholloway/biffo-template /tmp/biffo-template   # the target version
biffo core diff --to-template /tmp/biffo-template
```

```
  modified (1)
    services/api/src/api/main.py
  added (3)
    services/api/src/api/permissions.py
    ...
  4 template-owned file(s) would change (1 modified, 3 added, 0 removed); 118 unchanged.
```

## 3. Open the upgrade PR

`upgrade` three-way-merges base → yours → target so your local core edits survive. It **auto-resolves** both trees from the `core-v<version>` git tags — the base from your instance's current version, the target from the CLI's latest (or `--to <version>`) — so you don't supply any template checkouts:

```bash
biffo core upgrade --apply --base dev
```

Override the auto-resolution only when you need to (e.g. a pre-tag instance, or testing against a local template): `--template-repo <path>` picks which clone's tags to use, and `--from-template` / `--to-template` bypass the tags with explicit checkouts.

What `--apply` does, in order: creates a branch `biffo/core-upgrade-<from>-to-<to>`, writes the merged files (and bumps `biffo.core.json`), commits, pushes, and opens a PR against `--base` (default: your current branch). It never pushes to a protected branch directly.

Useful flags:

- `--apply` — actually do it (without this, it's a dry-run preview).
- `--to <version>` — target a specific core version (default: the CLI's latest). Resolved from its `core-v<version>` tag.
- `--template-repo <path>` — the biffo-template clone whose tags supply the trees (default: the template the CLI ships with).
- `--allow-conflicts` — open the PR even if some files conflict (see below). Without it, a conflicting plan aborts and just prints the report.
- `--base <branch>` — the branch the PR targets (e.g. `dev`, which triggers your deploy).
- `--remote <name>` — the git remote to push to / open the PR on (default `origin`).
- `--cwd <path>` — the instance repo (default: current directory). Your working tree must be clean.

## Conflicts

If a core file changed on **both** sides (upstream and your instance), the three-way merge can't auto-resolve it. With `--allow-conflicts` the file is committed **with standard `<<<<<<< / >>>>>>>` markers** and listed prominently in the PR body — you resolve them in the PR like any other merge conflict, then your CI runs. The tool never silently picks a side for core code.

## Merging

The PR is an ordinary change on your instance repo. Review it, resolve any conflicts, let your CI go green, and merge. Merging to your deploy branch (e.g. `dev`) runs your existing pipeline — the Lambda/portal reship and `biffo:db-init` runs. Nothing deploys until you merge; there is no teardown.

## Note: the first upgrade of a pre-versioning instance

If your instance predates `biffo.core.json`, there's no recorded version to use as the merge base. Pick the `biffo-template` commit that best matches your instance's core (e.g. just before the feature you're pulling in) and pass it as `--from-template`; the upgrade bumps you to a real version so every subsequent upgrade has a precise base. Review that first PR's diff carefully — the base is a best guess until versioning is established.

Two things the merge walker deliberately ignores so an upgrade stays sane: `.terraform/` provider caches, and `services/api/migrations/versions/` (your migrations are per-instance and must never be merged — new core migrations reach you through the additive carry described above instead).
