# `cdn`

The single CloudFront distribution fronting the portal, every registered
sibling (ADR-0007), and the shared plugin host (ADR-0021). One
`aws_cloudfront_origin_access_control` signs origin requests to every
same-account S3 origin (portal + siblings); non-S3 origins (the plugin host,
an optional failover) are plain custom origins.

```hcl
module "cdn" {
  source = "../../../modules/cloud/aws/cdn"

  project_name = var.project_name
  environment  = local.environment
  # ...see variables.tf for the full input list
}
```

## Recovering from a stuck OAC/origin-request-policy delete (#543)

**When this applies:** you removed an `aws_cloudfront_origin_access_control` or
an `aws_cloudfront_origin_request_policy` that the distribution referenced
through a `dynamic` origin/behaviour block (for example, decommissioning the
old ADR-0018 OAC-signed Lambda Function URL ingress in favour of a plain API
Gateway origin — see #541), and `terraform apply` is now deadlocked,
deterministically, with:

```
Error: deleting CloudFront Origin Access Control (…): 409 OriginAccessControlInUse: The CloudFront origin access control is still being used.
Error: deleting CloudFront Origin Request Policy (…): 409 OriginRequestPolicyInUse: … currently associated with a cache behavior.
```

**Why it happens:** when the config change removes both the resource AND its
last `dynamic`-block reference in the same apply, the reference disappears
from the plan before Terraform can use it to order the two operations. There
is no graph edge forcing "distribution finishes detaching" before "delete the
now-orphaned OAC/ORP", so the delete can fire first and CloudFront still
considers the policy attached. Re-running `apply` fails identically — it is
not a transient error. The code fix for new occurrences of this class of bug
lives in `main.tf` (see the comment above `aws_cloudfront_distribution.portal`
and the `create_before_destroy` lifecycle on `aws_cloudfront_origin_access_control.portal`);
this section is for an instance that is **already** stuck, which the code fix
cannot unstick retroactively.

**Recovery:**

1. **Remove the orphaned resource(s) from Terraform state only** — this does
   not touch AWS, it just stops Terraform from trying (and failing) to delete
   something it still thinks is attached:

   ```bash
   terraform state list | grep -E 'origin_access_control|origin_request_policy'
   terraform state rm 'aws_cloudfront_origin_access_control.plugin_api["ideation"]'
   terraform state rm 'aws_cloudfront_origin_request_policy.plugin_api'
   ```

2. **Let the pipeline apply the detach.** With the resources out of state,
   the plan is now just the distribution update — CloudFront finishes
   detaching the OAC/ORP from every origin and cache behaviour that used to
   reference it. Merge/apply as normal and confirm the distribution reaches
   `Deployed`.

3. **Delete the now-orphaned OAC/ORP via the AWS CLI**, once (2) has
   confirmed the distribution no longer references them:

   ```bash
   aws cloudfront delete-origin-access-control \
     --id <OAC_ID> --if-match "$(aws cloudfront get-origin-access-control --id <OAC_ID> --query ETag --output text)"

   aws cloudfront delete-origin-request-policy \
     --id <ORP_ID> --if-match "$(aws cloudfront get-origin-request-policy --id <ORP_ID> --query ETag --output text)"
   ```

Only bites an instance that already had the OAC/ORP applied — a fresh
instance never creates the vulnerable pattern, so this is a one-time
migration hazard, not a recurring one.
