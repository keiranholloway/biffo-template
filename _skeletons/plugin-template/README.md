# Biffo Plugin Repository Template

> **This is a skeleton, not a live repository.** It lives at
> `_skeletons/plugin-template/` inside the `biffo-template` monorepo — the
> same pattern `_skeletons/registry/` already uses for the plugin registry
> (see that directory's `README.md`). Nothing in here runs as part of
> biffo-template's own CI/CD, and this directory is **not** a member of the
> monorepo's pnpm or uv workspace (check `pnpm-workspace.yaml` and the root
> `pyproject.toml`'s `[tool.uv.workspace]` — neither lists `_skeletons/`).
> It exists to be **copied into a brand-new GitHub repository** when someone
> creates a Biffo plugin, per [ADR-0003](../../docs/ADR/0003-plugin-system-and-marketplace.md)
> section 2 ("Plugin Repository Structure"). No such repository
> (`keiranholloway/biffo-plugin-template` or otherwise) has actually been
> created — that was an explicit decision for this issue (#26): build the
> skeleton here, don't stand up a real external repo, so it can be reviewed
> and iterated on like any other code change in this monorepo.
>
> To use it: copy this entire directory's contents (minus this note) into a
> new repository, rename `example_plugin` throughout to your plugin's name,
> replace `biffo.plugin.json` with your own manifest, and follow the setup
> steps below.

## What's here

```
plugin-template/
├── .github/workflows/
│   ├── ci.yml              # lint, typecheck, test, manifest validation, security scans — runs on PR
│   └── release.yml         # semantic-release + PyPI publish — runs on `v*` tag push
├── biffo.plugin.json        # example manifest: one table, four generic-CRUD routes
├── registry-schema.json     # vendored copy of the registry's manifest JSON Schema (see below)
├── pyproject.toml           # depends on biffo-plugin-sdk
├── src/example_plugin/
│   ├── __init__.py
│   ├── manifest.py          # path to biffo.plugin.json
│   ├── plugin.py            # ExamplePlugin(BiffoPluginBase) — the reference implementation
│   └── main.py               # Lambda entrypoint dispatching EventBridge events
└── tests/
    ├── conftest.py
    ├── fakes.py              # in-memory fake of the Core API's generic CRUD routes
    └── test_example_plugin.py
```

This mirrors the real **RBAC reference plugin** (`services/rbac/` in this
monorepo, PR #76) — the same base class, the same `src/<name>/{plugin.py,
main.py}` layout, the same manifest shape, and the same fake-Core-API test
pattern. RBAC has more moving parts (four tables, an in-process permission
checker); this template's `example_plugin` is deliberately the smallest
version of the same shape: one table (`example_widgets`), four routes,
one `on_install` seed, one `@subscribe` handler.

## Standalone repo, not a monorepo package

Unlike `services/rbac/` (which is a "virtual" uv workspace member of
biffo-template with no `[build-system]`, per its own `tests/conftest.py`
comment), this template's `pyproject.toml` **does** declare
`[build-system]` (hatchling) because it's meant to live in its own
repository with its own independent `uv sync` / `uv.lock`, not inside
biffo-template's workspace. Once copied out, `uv sync && uv run pytest`
works standalone with no dependency on the rest of biffo-template.

## The `biffo-plugin-sdk` dependency: PyPI pin, with today's reality documented

`pyproject.toml` declares:

```toml
dependencies = [
  "biffo-plugin-sdk>=1.0,<2.0",
  ...
]
```

This is a **PyPI-style version pin**, chosen deliberately to match
`release.yml`'s aspirational PyPI-publish design (see that file's header
comment and decision 2 in the issue #26 implementation): the template is
built as if the whole plugin ecosystem — this repo's own package _and_ the
SDK it depends on — will eventually be published to PyPI. Today,
`biffo-plugin-sdk` is **not** on PyPI; it ships only as
`packages/python-sdk/` inside the biffo-template monorepo (confirmed via
issues #14/#66). `uv sync` in a freshly-copied plugin repo will therefore
fail to resolve this dependency until the SDK is actually published.

Two ways to make local development work before that happens:

1. **Path dependency** (if developing inside a biffo-template checkout,
   e.g. for a plugin you plan to upstream into `services/`): add
   ```toml
   [tool.uv.sources]
   biffo-plugin-sdk = { path = "../../packages/python-sdk", editable = true }
   ```
2. **Git dependency** (developing this plugin as a genuinely separate repo
   against an unpublished SDK):
   ```toml
   [tool.uv.sources]
   biffo-plugin-sdk = { git = "https://github.com/keiranholloway/biffo-template", subdirectory = "packages/python-sdk" }
   ```

Either override goes in `[tool.uv.sources]` only — the PyPI-style
`dependencies` entry above stays as-is, so removing the override is the
only change needed once the SDK actually ships to PyPI.

## Manifest validation: why CI doesn't hard-gate on `registry-schema.json`

`ci.yml`'s `validate-manifest` job runs two checks:

1. **Authoritative, blocking**: `biffo_plugin_sdk.plugin.load_manifest()` —
   the real Pydantic model the SDK, the Core API's
   `discover_plugin_manifests()`, and `biffo plugin install` all actually
   validate a manifest against.
2. **Advisory, non-blocking** (`continue-on-error: true`): the vendored
   `registry-schema.json` (a copy of `_skeletons/registry/registry-schema.json`
   as of when this template was written), via
   `python -m jsonschema -i biffo.plugin.json registry-schema.json`.

These two checks currently **disagree**, and check 2 is expected to fail.
`registry-schema.json`'s `api_routes` shape predates issue #19's
declarative table/operation CRUD-synthesis redesign: it still requires a
free-form `handler` function-name field (this template's manifest has no
such field — routes are declared as `table`/`operation` pairs instead, per
the real `RouteDef`/`RouteDefinition` models), and its `path` regex
(`^/[a-z0-9/_-]+$`) rejects the literal `{`/`}` characters that every
single-row route (`read`/`update`/`delete`) is required to have in its path
(e.g. `/widgets/{id}`). This was verified directly, not assumed: running
`jsonschema` against this template's own example manifest produces six
errors, all in `api_routes`. `cli/src/lib/plugin-manifest.ts` in
biffo-template already documents this exact same finding and deliberately
validates against the real Pydantic/Zod models instead of
`registry-schema.json` for the same reason.

This template follows that precedent: the manifest you ship must pass
check 1 (it's what actually gets enforced at plugin-install and db-init
time); check 2 is kept for visibility, so a future correction of
`registry-schema.json` upstream is easy to notice (it'll start passing) but
never blocks your CI in the meantime. If `registry-schema.json` is
corrected, remove this note and consider making check 2 blocking too.

## Contribution guidelines

- **Conventional Commits.** `feat: ...`, `fix: ...`, `chore: ...`,
  `docs: ...`, `test: ...`, `refactor: ...`, `perf: ...` — the same types
  biffo-template's own root `CLAUDE.md` documents. `release.yml`'s
  changelog generation depends on this.
- **One plugin, one repo.** Don't vendor unrelated code here — this repo
  should contain exactly the plugin's manifest, source, and tests. Terraform
  for the plugin's own infra (if any) goes in a `terraform/` directory at
  the repo root (see ADR-0003 section 2), not built by this template since
  the example plugin needs none.
- **Every table gets `tenant_id`.** You never declare it yourself — it's
  auto-injected (ADR-0001). Declaring `id`, `tenant_id`, `created_at`, or
  `updated_at` in a table's `columns` fails manifest validation.
- **No database client.** Plugins talk to the Core API over HTTP via
  `BiffoAPIClient` only (ADR-0002) — never `psycopg2`/`asyncpg`/SQLAlchemy
  against the database directly.
- **Run the full check suite before opening a PR:**
  ```bash
  uv sync --all-groups
  uv run ruff check .
  uv run ruff format --check .
  uv run pyright
  uv run pytest --cov
  ```

## Branch protection setup

Once you've created the real repository from this skeleton, protect `main`
with the **same settings biffo-template's own root repo uses**, codified as
Terraform in `modules/source-control/github/main.tf`'s
`github_branch_protection.main` resource in this monorepo — copy that
module (or these settings) rather than inventing new ones:

| Setting                              | Value                                                                                                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required status checks               | `strict = true`; contexts: `CI / Lint`, `CI / Type Check`, `CI / Test`, `CI / Validate biffo.plugin.json`, `CI / Secret Scan` (the job names from this repo's own `ci.yml`) |
| Required approving reviews           | 1                                                                                                                                                                           |
| Dismiss stale reviews on new commits | Yes                                                                                                                                                                         |
| Require review from Code Owners      | Yes (add a `.github/CODEOWNERS` file)                                                                                                                                       |
| Enforce for admins                   | Yes                                                                                                                                                                         |
| Require linear history               | Yes                                                                                                                                                                         |
| Allow force pushes                   | No                                                                                                                                                                          |
| Allow branch deletion                | No                                                                                                                                                                          |

If you manage the new repo with Terraform too (recommended — see this
monorepo's own "IaC as first-class citizen" convention), use
`modules/source-control/github/` directly rather than hand-writing the
equivalent `github_branch_protection` resource. If you're setting this up
by hand via the GitHub UI instead: **Settings → Branches → Add branch
protection rule**, pattern `main`, and set each field above to match.

## PyPI publishing

`release.yml` triggers on `v*` tag pushes, re-runs the full CI gate against
the tagged commit, verifies the tag matches `pyproject.toml`'s
`project.version`, builds the sdist/wheel, and publishes to PyPI via
`pypa/gh-action-pypi-publish`. **This publish step will not succeed until a
real PyPI project exists for this plugin and either a trusted publisher (OIDC)
or a `PYPI_API_TOKEN` secret is configured** — see `release.yml`'s header
comment for the full rationale (this is intentional, per issue #26's
decision to build the release workflow as if publishing were real even
though no plugin in the ecosystem is on PyPI yet).
