# Biffo — AI Assistant Context

## What this project is

Biffo is an opinionated repo template and scaffolding CLI for solopreneurs. Running `biffo init` creates a new GitHub repository pre-configured with AWS infrastructure, CI/CD, governance guardrails, and security defaults. The intent is to solve "system architecture" as a solved problem so founders build products instead of plumbing.

## Architecture decisions in force

Before touching data models, APIs, or service boundaries, read the ADRs in `docs/ADR/`:

- **ADR-0001**: Single-tenant architecture with a multi-tenant seam. Every database table must have a `tenant_id` column. The API always scopes reads/writes to `tenant_id`. In the current single-tenant deployment it is always `"default"`.
- **ADR-0002**: All data access goes through the Core API (`services/api/`). No other service may import `psycopg2`, `asyncpg`, `SQLAlchemy`, or any database client. Microservices call the API via HTTP and react to EventBridge events.

## Repo structure

```
biffo/
├── cli/                    # @biffo/cli — Node.js/TypeScript scaffolding CLI
├── apps/portal/            # @biffo/portal — Next.js 15 base portal (React 19)
├── services/api/           # biffo-api — FastAPI + Mangum core API (Python 3.13)
├── services/_template/     # Template for new microservices — copy and rename
├── packages/
│   ├── typescript-config/  # Shared tsconfig extends
│   ├── eslint-config/      # Shared ESLint flat config
│   └── ui/                 # @biffo/ui — shared React component stubs
├── modules/
│   ├── cloud/aws/          # Terraform modules: networking, compute, storage, database, auth, events, cdn, oidc
│   └── source-control/github/  # Terraform module: GitHub repo + branch protection
├── infra/environments/     # Root Terraform configs: dev, staging, prod
├── docs/ADR/               # Architecture Decision Records
└── scripts/                # bootstrap.sh, setup-oidc.sh
```

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

# CLI (after build)
pnpm --filter @biffo/cli build
./cli/dist/index.js --help

# Terraform (dev)
cd infra/environments/dev
terraform init -backend-config=backend.hcl
terraform plan
```

## Key invariants to preserve

1. **`tenant_id` on every table** — `TenantScopedModel` in `services/api/src/api/models/base.py` is the base class. Use it.
2. **`require_tenant_context()` on every route** — FastAPI dependency in `services/api/src/api/dependencies.py`.
3. **`BiffoEvent` base model for all events** — `services/api/src/api/events/base.py`. Never publish raw dicts to EventBridge.
4. **No DB clients outside `services/api/`** — this is enforced by a Ruff plugin in CI. Adding `asyncpg` to `services/_template/` or any other service will fail the build.
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
