# ADR-0019: dev/staging egress defaults to a fck-nat NAT instance

**Status:** Accepted
**Date:** 2026-07-24
**Deciders:** Keiran (owner)

---

## Context

The template shipped two egress postures for the Lambda-bearing private subnets:

- **Managed NAT gateway** (`enable_nat_gateway = true`, the module default) — the posture staging and prod used.
- **NAT-less with interface VPC endpoints** (`enable_nat_gateway = false`) — dev's posture, chosen to avoid the NAT gateway's ~$33/mo base cost.

Two problems surfaced in practice:

1. **Cost.** The NAT-less posture is only cheap with ≤1 interface endpoint. Both live instances (tabsii, biffo-platform) accrued **~$70/mo** in PrivateLink once they needed cognito-idp + secretsmanager + events endpoints, and each new AWS service the in-VPC Lambda talks to adds another ~$24/mo endpoint.
2. **Completeness.** Interface endpoints only cover the services explicitly enumerated. The NAT-less dev posture had **no route to the Lambda control-plane API**, so the in-VPC Core API could not synchronously invoke the agent-runtime — the ADR-0016 prompt-assistant returned a 503 until egress was fixed.

Issue #511 added a third posture — a single **fck-nat `t4g.nano` NAT instance** (`enable_nat_instance = true`, ~$3–5/mo, EC2 auto-recovery), mutually exclusive with the gateway. It provides full egress (fixing the invoke) at a fraction of either alternative's cost. Both instances were switched to it and verified. #520 asks whether it should become the **default** for non-prod.

## Decision

**dev and staging default to the fck-nat NAT instance** (`enable_nat_instance = true`, `enable_nat_gateway = false`) in the template's `infra/environments/{dev,staging}` root configs. **prod is unchanged** — it keeps its HA managed NAT gateway (`enable_nat_gateway` default true, `single_nat_gateway = false`, one per AZ).

This is a change to what a fresh `biffo init` scaffolds. `infra/environments/` is user-owned, so it does **not** distribute to existing instances via `biffo core upgrade`; tabsii and biffo-platform were already switched by hand (#511) and need nothing.

## Options Considered

### Option A — Default dev/staging to the NAT instance; prod unchanged (chosen)

**Pros:** Cheapest non-prod egress (~$3–5/mo vs ~$35–100/mo gateway or ~$70/mo endpoints); complete egress (no per-service endpoint gap, no repeat of the ADR-0016 503); prod's reliability posture untouched.

**Cons:** staging drops from an HA per-AZ gateway to a single auto-recovering instance — a dev-grade SPOF. Acceptable for pre-prod.

### Option B — Default all environments (incl. prod) to the NAT instance

**Cons:** A single-instance SPOF is inappropriate for prod even with auto-recovery; prod should keep HA. Rejected.

### Option C — Leave defaults as-is; opt in per instance

**Cons:** Every new instance re-discovers the cost/egress trap and hand-fixes it — the same friction #511/#516 exist to remove. Rejected.

## Rationale

Cost is the driving factor for non-prod, and the NAT instance also removes the "forgot an endpoint" class of egress bug. The only real cost is staging's HA downgrade, which is the right trade for a pre-prod environment. prod's HA requirement is preserved by leaving it explicitly on the managed gateway.

## Consequences

- Fresh `biffo init` instances get cheap, complete non-prod egress out of the box; the ADR-0016 assistant works in dev/staging without an infra fix.
- `.gitleaks.toml` is template-owned (#516) so the fck-nat vendor AMI-owner allowlist entry distributes — a new instance's Secret Scan won't fail on the module code.
- staging is a single NAT instance (SPOF, auto-recovering). If a future staging workload needs HA, set `enable_nat_gateway = true` / `enable_nat_instance = false` for that instance.
- prod networking is unchanged by this ADR.
