# Biffo — AI Assistant Context

## Rules of engagement

The tool-agnostic rules of engagement for **all** automated agents (worktrees,
branching, PRs, merging, security, template→instance distribution) live in
[`AGENTS.md`](AGENTS.md) and are imported below. They are binding for any code
change in this repo; `AGENTS.md` is the single source of truth.

@AGENTS.md

## What this project is

Biffo is an opinionated repo template and scaffolding CLI for solopreneurs. Running `biffo init` creates a new GitHub repository pre-configured with AWS infrastructure, CI/CD, governance guardrails, and security defaults. The intent is to solve "system architecture" as a solved problem so founders build products instead of plumbing.

## Architecture decisions in force

Before touching data models, APIs, or service boundaries, read the ADRs in `docs/ADR/`:

- **ADR-0001**: Single-tenant architecture with a multi-tenant seam. Every database table must have a `tenant_id` column. The API always scopes reads/writes to `tenant_id`. In the current single-tenant deployment it is always `"default"`.
- **ADR-0002**: All data access goes through the Core API (`services/api/`). No other service may import `psycopg2`, `asyncpg`, `SQLAlchemy`, or any database client. Microservices call the API via HTTP and react to EventBridge events.

## Repo structure

```
biffo/
├── cli/                    # biffo — Node.js/TypeScript scaffolding CLI (published to npm)
├── apps/portal/            # @biffo/portal — Next.js 15 base portal (React 19)
├── services/api/           # biffo-api — FastAPI + Mangum core API (Python 3.13)
├── services/_template/     # Template for new microservices — copy and rename
├── packages/
│   ├── typescript-config/  # Shared tsconfig extends
│   ├── eslint-config/      # Shared ESLint flat config
│   └── ui/                 # @biffo/ui — shared React component stubs
├── modules/
│   ├── cloud/aws/          # Terraform modules: networking, compute, storage, database, auth, events, cdn
│   └── source-control/github/  # Terraform module: GitHub repo + branch protection
├── infra/environments/     # Root Terraform configs: dev, staging, prod
├── docs/ADR/               # Architecture Decision Records
└── scripts/                # bootstrap.sh, setup-oidc.sh
```

GitHub Actions → AWS OIDC trust is **not** Terraform-managed. `biffo init` bootstraps it
imperatively via the AWS SDK (`AwsAdapter.setupOidcTrust` in `cli/src/adapters/cloud/aws/index.ts`)
before Terraform ever runs, because that OIDC role is the credential Terraform's own CI runs
need in order to authenticate to AWS in the first place — Terraform cannot create the role that
grants it permission to run. `scripts/setup-oidc.sh` is the equivalent manual/out-of-band fallback.

## Commands

```bash
# First-time setup
./scripts/bootstrap.sh

# Install dependencies (JS + Python)
pnpm install && uv sync

# Run all linting
pnpm run lint
uv run ruff check .

# Type checking
pnpm run typecheck
uv run pyright

# Tests
pnpm run test
uv run pytest

# Format
pnpm run format

# Start portal dev server
pnpm --filter @biffo/portal dev

# CLI — released usage (published to npm as `biffo`; version == core.version)
npx @biffo/cli --help

# CLI — local development (contributors working ON the CLI, from this checkout)
pnpm --filter @biffo/cli build
./cli/dist/index.js --help

# Terraform (dev)
cd infra/environments/dev
terraform init -backend-config=backend.hcl
terraform plan
```

## CLI distribution

The CLI ships to npm as **`@biffo/cli`** under the `biffo` org (`cli/`). The
binary it installs is still `biffo`, so `npx @biffo/cli init` gives you `biffo`.

It is scoped deliberately: npm rejects the unscoped name `biffo` as _"too similar
to existing package diff"_ under its typosquatting protection. A registry 404
means only that nobody has published a name — not that npm will accept it. Scoped
names bypass that check, and the `@biffo` scope also gives the plugin SDK and any
future packages somewhere to live.

Two paths, and it matters which one you are on:

- **Released** — `npx @biffo/cli <cmd>`. An immutable, resolved version; nothing is
  built locally on the path that creates real GitHub repos and AWS resources.
- **Local development** — `pnpm --filter @biffo/cli build && ./cli/dist/index.js`.
  Still supported and still guarded: `cli/src/lib/build-freshness.ts` refuses to
  scaffold from a `dist` older than `src` (issue #190).

**The CLI's version _is_ `core.version`.** One number, no mapping table:
`biffo@0.32.9` is the CLI shipping core 0.32.9. `.github/workflows/publish-cli.yml`
fires on the `core-v*` tags that `core-tag.yml` maintains, checks the tag and
`core.version` agree, stamps the package version, and publishes with provenance.

Several CLI modules find a companion asset by walking _up_ from the running
module — `core.version` for `getLatestCoreVersion()`, `_skeletons/` for `biffo
init` / `sibling create` / `plugin create`. Nothing exists above
`node_modules/@biffo/cli/dist/`, so the published tarball must carry its own copy
of each, beside `dist/`. They are written by `cli/scripts/sync-packaged-assets.mjs`
from `prepack` (undone by `postpack`), listed in package.json `files`, and guarded
by `cli/src/lib/root-asset-packaging.test.ts`. The copies are git-ignored; the
repo-root originals stay the only committed ones.

**Adding a new root-level asset the CLI resolves this way?** Register it in
`cli/scripts/packaged-root-assets.mjs` — that inventory drives both the prepack
copy and the guard. Skipping it is invisible in CI (the upward walk still reaches
the repo root in a checkout) and breaks only on a real npm install: that is
exactly how #259 and #315 shipped.

## Key invariants to preserve

1. **`tenant_id` on every table** — `TenantScopedModel` in `services/api/src/api/models/base.py` is the base class. Use it.
2. **`require_tenant_context()` on every route** — FastAPI dependency in `services/api/src/api/dependencies.py`.
3. **`BiffoEvent` base model for all events** — `services/api/src/api/events/base.py`. Never publish raw dicts to EventBridge.
4. **No DB clients outside `services/api/`** — enforced in CI by a Ruff `flake8-tidy-imports` banned-api rule (`TID251`) configured in `ruff.toml`, which bans importing `psycopg2`/`psycopg`/`asyncpg`/`sqlalchemy` anywhere except `services/api/` (exempted via `per-file-ignores`). Adding `asyncpg` to `services/_plugins/`, a `packages/` SDK, or any other service fails the build. (Note: `ruff.toml` is the _active_ Ruff config — it shadows the `[tool.ruff]` section in `pyproject.toml`, whose richer strict select is currently dormant; see the header comment in `ruff.toml`.)
5. **No force pushes to main** — branch protection is enforced. Use PRs.

## Technology

- Frontend: React 19, Next.js 15 (App Router, static export), TypeScript 5, Tailwind CSS 3, Node 22
- Backend: Python 3.13, FastAPI, Mangum (Lambda adapter), Pydantic v2, SQLAlchemy 2, Alembic, AWS Lambda Powertools
- Infrastructure: Terraform 1.9, AWS (Lambda, RDS PostgreSQL 16, Cognito, EventBridge, S3, CloudFront, RDS Proxy)
- Tooling: pnpm 9, Turborepo 2, uv, Husky 9, ESLint 9 (flat config), Ruff, Prettier 3, commitlint

## Commit convention

Conventional Commits enforced by commitlint:

```
feat(portal): add dashboard layout
fix(api): correct tenant_id scoping on users endpoint
infra(networking): add second NAT gateway for staging
security(auth): enforce MFA in prod Cognito config
```

Types: `feat`, `fix`, `chore`, `docs`, `test`, `infra`, `security`, `refactor`, `perf`, `ci`

## Pluggability

The `modules/` directory is the extension point. Each cloud provider and source control system is a separate Terraform module implementing the same interface. To add GCP support, create `modules/cloud/gcp/` with matching variable/output signatures to `modules/cloud/aws/`.

The CLI adapter system mirrors this: `cli/src/adapters/cloud/` and `cli/src/adapters/source-control/` contain provider-specific implementations behind a common interface.
