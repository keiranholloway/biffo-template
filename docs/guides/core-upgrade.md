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

Two files track versions:

- **`core.version`** (template repo) — the template's current core version.
- **`biffo.core.json`** (your instance) — the core version your instance was scaffolded from / last upgraded to.

An upgrade bumps `biffo.core.json` in the same PR. Instances scaffolded before versioning existed won't have `biffo.core.json` yet — the first `upgrade` creates it (see the note at the end).

## What gets touched (and what never does)

Ownership is declared in the template's `core-manifest.json`. Only **template-owned** paths are ever changed:

- **Template-owned:** `services/api/`, `services/_template/`, `modules/`, `packages/`, `cli/`, `.github/`, `scripts/`, `docs/ADR/`, and root tooling configs.
- **Left alone (user-owned):** your plugins under `services/<name>/`, `infra/environments/`, `apps/`, `db/`, `services/api/migrations/versions/` (your Alembic chain), and your config files.

On any ambiguity, user-owned wins — the upgrade is fail-closed and never touches a path it isn't sure the template owns.

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

Two things the walker deliberately ignores so an upgrade stays sane: `.terraform/` provider caches, and `services/api/migrations/versions/` (your migrations are per-instance and must not be synced).
