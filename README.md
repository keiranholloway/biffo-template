# Biffo

Opinionated repo template and scaffolding CLI for solopreneurs. One command provisions a production-grade AWS portal — auth, API, database, events, CDN — so you build your product, not the plumbing.

## Quick start

```bash
npx @biffo/cli init
```

The CLI will prompt for your project name, DNS mode, AWS account, and GitHub org, then:

1. Creates a GitHub repo from this template
2. Configures branch protection and GitHub Environments
3. Provisions an OIDC trust between GitHub Actions and your AWS account
4. Bootstraps the Terraform state backend
5. Triggers the first CI run

DNS modes:

- `managed-route53`: Biffo creates a Route 53 hosted zone, validates an ACM certificate, and creates CloudFront DNS records.
- `external`: Biffo requests the ACM certificate but does not change DNS. Add the validation CNAMEs from the workflow summary, rerun deploy, then point your DNS provider at the CloudFront target.
- `none`: Biffo skips custom DNS and uses the default CloudFront domain.

## What you get

| Layer    | Technology                                        |
| -------- | ------------------------------------------------- |
| Frontend | Next.js 15 (React 19, TypeScript, Tailwind)       |
| API      | FastAPI on AWS Lambda (Python 3.13)               |
| Database | PostgreSQL 16 on RDS via RDS Proxy                |
| Auth     | AWS Cognito (hosted UI + JWTs)                    |
| Events   | AWS EventBridge (custom bus)                      |
| Storage  | S3 + CloudFront CDN                               |
| IaC      | Terraform (modular, pluggable)                    |
| CI/CD    | GitHub Actions (OIDC — no long-lived credentials) |

## Architecture principles

- **API-only data access** — microservices never query the database directly
- **EventBridge for state changes** — no polling, no tight coupling
- **Single-tenant with multi-tenant seam** — deploys as one isolated environment; designed to add multi-tenancy later without a schema migration
- **Security by default** — secret scanning, SAST, dependency audits on every PR

## Development setup

```bash
./scripts/bootstrap.sh
```

See [CLAUDE.md](CLAUDE.md) for full project context and commands.

## Guides

- [Importing a DDL data model](docs/guides/data-import.md) — `biffo data import`/`apply`/`list`
- [Exposing CRUD endpoints](docs/guides/generic-crud-endpoints.md) — turn on list/read/create/update/delete for a table via permissions

## Architecture decisions

All significant decisions are documented in [docs/ADR/](docs/ADR/).

## License

MIT
