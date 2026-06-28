## What

<!-- 1–3 sentences: what does this PR do? -->

## Why

<!-- Link to issue, ADR, or explain the motivation. -->

## How

<!-- Brief description of the approach. Skip if the diff is self-explanatory. -->

## Test plan

- [ ] Unit tests added / updated
- [ ] Manual smoke test performed (describe what you tested)
- [ ] No regressions in existing tests (`pnpm test` / `uv run pytest`)

## Infrastructure impact

- [ ] No infrastructure changes
- [ ] Terraform plan reviewed (attach plan output or link to CI run)
- [ ] New AWS resources created — IAM permissions are least-privilege
- [ ] Destructive Terraform change — migration plan documented

## Security checklist

- [ ] No secrets, credentials, or PII in the diff
- [ ] Input validation added for any new API endpoints
- [ ] No direct database access introduced in non-core services (ADR-0002)
- [ ] `tenant_id` present on any new database tables (ADR-0001)

## ADR impact

<!-- Does this change an architectural decision? If so, a new ADR is required before merge. -->
- [ ] No architectural decisions affected
- [ ] New ADR raised: docs/ADR/XXXX-...
