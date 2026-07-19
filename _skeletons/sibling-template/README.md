# Sibling App Template

> **This is a skeleton, not a live repository.** It lives at
> `_skeletons/sibling-template/` inside `biffo-template` and is not itself
> deployed or a member of biffo-template's pnpm/uv workspace — check
> `pnpm-workspace.yaml` (only lists `apps/*`, `packages/*`, `cli`) and the
> root `pyproject.toml`'s `[tool.uv.workspace]` (only lists `services/*`,
> `services/_plugins/*`,
> `packages/python-sdk`); neither lists `_skeletons/`. It exists to be
> copied into a **brand-new, independent GitHub repository** by
> `biffo sibling create <name>` (ADR-0007), which pushes this content in as
> that new repo's first commit and rewrites `biffo.sibling.json` with real
> values. No such external repo exists yet from this skeleton alone — that's
> the point of it being a skeleton, not an oversight.
>
> To use it manually (outside `biffo sibling create`): copy this directory
> out, rename the placeholder values in `biffo.sibling.json` and the two
> `.env.example` files, then follow "Getting started" below.

## What is a "sibling app"?

A sibling is an independently-deployed microservice that still feels like
part of one product: same login (it shares the **core project's** Cognito
User Pool and App Client — not its own), same domain
(`baseurl.com/<sibling-name>/*`, routed via the core project's own
CloudFront distribution), but its own repo, its own CI/CD, its own AWS
resources. Per ADR-0002 and ADR-0007, a sibling **never accesses a database
directly** — the only way it reads or writes core-owned data is by calling
the core project's own API (`services/api/core_client.py`). This template
enforces that from the start: there is no `asyncpg`/`sqlalchemy`/`alembic`
anywhere in `services/api/`, on purpose.

## What's here

```
apps/frontend/            # Next.js 15 static export — the ONLY page is "<name> - Hello <username>",
                           #   proving the shared-session SSO works. Copy the portal's own
                           #   src/lib/auth.ts pattern here almost verbatim (see that file's comments).
services/api/              # FastAPI + Mangum backend. Verifies the core project's Cognito JWT itself
                           #   (defense in depth — API Gateway's own JWT authorizer is the first layer).
                           #   core_client.py is the ONLY sanctioned way to reach core-owned data.
infra/                     # Single Terraform root (no per-environment subfolders, unlike the core
                           #   project — this repo is simple enough that one root + a Terraform
                           #   workspace/backend key per environment is enough). No Cognito pool,
                           #   no CloudFront distribution: those are the core project's, passed in
                           #   as plain input variables (core_cognito_user_pool_id, etc.)
modules/cloud/aws/         # Vendored (copied, not remote-sourced) compute/storage/api-gateway
                           #   modules — this repo must stay self-contained; a git-sourced shared
                           #   module would reintroduce the cross-repo-lifecycle coupling ADR-0003
                           #   already rejected for plugins. Same call, made consistently here.
.github/workflows/ci.yml   # Same 11 status checks as the core project (see DEFAULT_STATUS_CHECKS
                           #   in the core project's cli/src/adapters/source-control/github/index.ts)
.github/workflows/deploy.yml  # infra apply -> frontend build+sync -> Lambda package+deploy, combined
                           #   into one workflow with a dynamic branch->environment mapping.
biffo.sibling.json          # This sibling's name, its paired core project's name, its path prefix.
                           #   Written by `biffo sibling create`; do not hand-edit path_prefix
                           #   without also updating the core project's siblings.auto.tfvars.json.
```

## Standalone repo, not a monorepo package

Both `apps/frontend/package.json` and `services/api/pyproject.toml` are
fully standalone — no `workspace:*` dependencies, no Turborepo, no shared
`@biffo/eslint-config`/`@biffo/typescript-config` packages (those only exist
inside the `biffo-template` monorepo). `services/api/pyproject.toml` has its
own `[build-system]` (hatchling) so `uv sync` works from a bare clone. This
means `apps/frontend/eslint.config.mjs` and `tsconfig.json` duplicate rules
the core project's shared packages would otherwise centralise — an
intentional, small amount of duplication in exchange for this repo never
needing anything from `biffo-template` at runtime or build time.

`apps/frontend/pnpm-workspace.yaml` exists for the same reason, and is worth
understanding before you delete it as redundant. `pnpm install` walks _up_ the
directory tree looking for a workspace root. In a scaffolded sibling repo there
is nothing above `apps/frontend` to find, so the file is inert. But while this
skeleton still lives inside `biffo-template` — under `_skeletons/`, excluded
from that repo's own workspace globs — `pnpm install` run from here would
otherwise walk all the way up and install **biffo-template's root workspace**
instead: it prints success against `../../../..`, leaves no `node_modules` here
at all, and the next command fails for a reason that looks entirely unrelated.
Declaring this directory a workspace root of its own terminates that walk.
(A `preinstall` guard cannot help: pnpm never treats an excluded package as
part of the install, so its lifecycle scripts never run.)

## The build must not need Cognito credentials

`pnpm run build` has to succeed with **no** `NEXT_PUBLIC_CORE_COGNITO_*` set,
and `.github/workflows/ci.yml` runs it that way on every PR to keep it that
way. `next build` prerenders `/` in Node, which imports `src/lib/auth.ts`; that
module therefore constructs its Cognito user pool lazily, on first session
read, never at module scope (the `CognitoUserPool` constructor throws outright
when either id is missing). If you add module-scope code that requires real
core config, the build breaks for everyone who has not exported the pool ids —
starting with CI. Read config inside the function that needs it.

## The two-phase CDN registration

Registering this sibling on the core project's CloudFront distribution is
necessarily a two-step handshake, not something this repo's own
`terraform apply` can complete alone:

1. `biffo sibling create` provisions this sibling's own S3 bucket/Lambda/API
   Gateway first (`var.parent_cloudfront_distribution_arn` left empty — see
   `infra/variables.tf` — so the bucket policy step is skipped; there's no
   distribution ARN to trust yet).
2. It then opens a PR against the **core project's** repo, appending this
   sibling's `{ name, bucket_regional_domain }` to
   `infra/siblings.auto.tfvars.json`. Once a human merges that PR and the
   core project redeploys, `baseurl.com/<name>/*` starts routing to this
   sibling's bucket, and the real distribution ARN exists.
3. Set `parent_cloudfront_distribution_arn` (as `PARENT_CLOUDFRONT_DISTRIBUTION_ARN`,
   a GitHub Environment variable) and re-run `.github/workflows/deploy.yml`
   (`workflow_dispatch`) to add the bucket policy in a second apply.

This ordering is a real dependency, not a bug — don't skip step 3 or the
core project's CloudFront will get an origin it isn't allowed to read from.

## Contribution guidelines

- Conventional Commits (`feat`, `fix`, `chore`, `docs`, `test`, `infra`,
  `security`, `refactor`, `perf`, `ci`), same as the core project.
- Keep this repo doing one thing: this sibling's own feature. If you find
  yourself wanting to read/write another sibling's data, go through the
  core project's API and an EventBridge subscription, not a direct call.
- Invariants inherited from the core project (ADR-0001/ADR-0002): every
  piece of core-owned data this sibling touches is still scoped to
  `tenant_id` server-side (the core API enforces this, not this repo) — and
  no database client of any kind belongs in `services/api/`.
- Before opening a PR:
  ```bash
  cd apps/frontend && pnpm install && pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run build
  cd services/api && uv sync --all-groups && uv run ruff check . && uv run ruff format --check . && uv run pyright && uv run pytest
  terraform fmt -check -recursive infra/ modules/
  ```

## Branch protection setup

`biffo sibling create` configures this via the same
`GitHubAdapter.configureBranchProtection` the core project uses (passing
this repo's own `statusChecks` list — see that method's third parameter):

| Setting                | Value                                                     |
| ---------------------- | --------------------------------------------------------- |
| Required status checks | The 11 jobs in `.github/workflows/ci.yml`, `strict: true` |
| Required reviews       | 0 (solo-founder default; raise this yourself)             |
| Dismiss stale reviews  | true                                                      |
| Enforce for admins     | true                                                      |
| Linear history         | true                                                      |
| Allow force pushes     | false                                                     |
| Allow deletions        | false                                                     |

## Getting started (manual, outside `biffo sibling create`)

1. Rename `biffo.sibling.json`'s `name`/`core_project`/`path_prefix`.
2. Copy `apps/frontend/.env.example` to `.env.local` and fill in your core
   project's real Cognito/API values for local dev.
3. `cd infra && terraform init -backend-config=backend.hcl && terraform apply`
   (generate `backend.hcl` yourself for local use — CI generates it inline,
   see `deploy.yml`).
4. Wire the GitHub Environment variables/secrets `deploy.yml` reads
   (`CORE_COGNITO_USER_POOL_ID`, `CORE_COGNITO_CLIENT_ID`, `CORE_API_URL`,
   `CORE_PORTAL_URL`, `SIBLING_OIDC_ROLE_ARN`, `TF_STATE_BUCKET`, etc.).
5. Open the registration PR against your core project (`infra/siblings.auto.tfvars.json`)
   yourself, or let `biffo sibling create` do it for you.
