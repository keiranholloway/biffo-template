# `compute`

A single Lambda function: least-privilege execution role, DLQ, CloudWatch log
group encrypted at rest, code-signing config, and — since #1747 — a published
version's stable `live` alias that CI/CD moves forward on every deploy
(`scripts/publish-lambda-version.sh`). Neither of the two warm-capacity
mechanisms below can attach to `$LATEST`, which is why that alias is a hard
prerequisite for this one.

```hcl
module "compute" {
  source = "../../../modules/cloud/aws/compute"

  project_name = var.project_name
  environment  = local.environment
  # ...see variables.tf for the full input list
}
```

## Warm capacity (`enable_warm_capacity`) — biffo-template#1748

Cold start on this function is dominated by Python import time, not by
per-request compute — see the figures below. `enable_warm_capacity` attaches
[AWS Lambda SnapStart](https://docs.aws.amazon.com/lambda/latest/dg/snapstart.html)
to the published version behind the `live` alias, restoring from a frozen,
already-initialised execution environment on every invocation instead of
re-running Python's import machinery cold. It defaults to **off** — no
existing instance's cost or behaviour changes on upgrade — and is a Terraform
input only; turning it on for a real instance is a separate, instance-side
cost decision (see "Rollout" below).

### Why SnapStart, not provisioned concurrency

The two candidates this module could have wired up are mutually exclusive.
The decision and the figures behind it are **owner-made, not this module's
own** — recorded in full in
[biffo-template#1748's pinned decision comment](https://github.com/keiranholloway/biffo-template/issues/1748#issuecomment-5570535732),
citing `tabsii-platform`'s M1 measurement
(`docs/implementation/0026-authenticated-page-first-render/measurement.md`,
milestone tabsii-com/tabsii-platform#1237). Summarised here, not
re-derived:

- Core's cold start is **83% Python import time** (3956 ms measured
  `importtime` vs. 4768 ms cold `@initDuration` p50) — an init-phase cost, not
  per-request work, so memory/CPU sizing can't buy it back (a 512 MB–3008 MB
  sweep measured **0 ms** improvement in M1).
- The page's fan-out burst peaks at **7 concurrent invocations**, against a
  **10**-wide young-account concurrency cap shared across everything in the
  account. Provisioned concurrency would need N≥7 reserved just to cover one
  function's burst — consuming nearly the entire shared cap — and an 8th
  concurrent request still pays full cold start regardless of N.
- `database.py` uses `NullPool` (no connection held across invocations) and
  JWKS is baked into an env var rather than fetched at runtime, so there is no
  live per-container state at init that SnapStart's freeze/restore needs
  special handling for, beyond the standard credential-refresh hook.
- **Cost, for Python (not Java's free-cache case the table in #1748 first
  assumed):** SnapStart is ≈**$2.20/month** at current traffic for one live
  published version (caching + restore charges). Provisioned concurrency at
  N=7 reserved continuously is ≈**$38/month** — ~17× more, and still
  capacity-capped at 7.

### The real cost risk is version accumulation, not per-invocation cost

Every deploy publishes a new Lambda version
(`scripts/publish-lambda-version.sh`) and none is ever deleted. With SnapStart
on, **every published version bills its own caching charge indefinitely** —
Python SnapStart has no AWS-side auto-cleanup for inactive versions (unlike
Java's 14-day cleanup). Left unmanaged, accumulated versions at this estate's
deploy frequency would blow out to roughly **$390/month** in orphaned caching
charges — a ~180× overrun versus the ~$2.20/month a single live version
costs. **This must not ship live without a version cull** — tracked as a hard
prerequisite in biffo-template#1957, which must close before SnapStart is
turned on for any real instance.

### Rollout

`enable_warm_capacity` ships **off**. Turning it on anywhere is a separate,
instance-side decision — this variable only makes the mechanism available,
it does not enable it for any existing or new instance by itself. The
not-yet-filed downstream milestone (tabsii-platform M5) turns it on for
tabsii dev, and is body-stated to depend on both this issue and #1957's
version-cull prerequisite.
