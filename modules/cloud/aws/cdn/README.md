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

## API 403/404 bodies (`error_status_demote_lambda_arn`) — biffo-template#1529

`custom_error_response` (in `main.tf`, below the behaviours) exists so a deep
link to a client-routed portal/sibling path — a real URL, no corresponding
static file — still renders the SPA shell on a 403/404 from S3, instead of a
raw origin error. CloudFront gives no way to scope `custom_error_response` to
one cache behaviour, so left alone it ALSO intercepts a genuine 403/404 JSON
response from any of the three API behaviours (`api/v1/plugins/*`,
`api/v1/health`, `c/*`) and replaces the body with that same shell — every
hand-authored API error message, including a 403's role/permission detail,
arrives at the client as HTML.

Fixed without touching `custom_error_response` at all, because it is doing
its job correctly for the portal/sibling case and removing or narrowing it
would either lose the SPA fallback or (measured against the placeholder+
query-string pattern `apps/portal` already uses for dynamic routes — see
e.g. `apps/portal/src/app/admin/plugins/[slug]/page.tsx`) still leave a real
gap for a genuinely-unmatched deep link. Instead, on the three API
behaviours only:

1. `error-status-demote.js` — a **Lambda@Edge origin-response** trigger
   (created in `infra/global`, which is always us-east-1 — see that file's
   comment) — demotes a real 403/404 to 200 and stashes the true status in an
   `x-biffo-true-status` response header, before `custom_error_response` ever
   evaluates the status. This is the documented mechanism for bypassing a
   distribution's error page for one behaviour: AWS's own example for this
   trigger type is literally "update the error status code to 200".
2. `error-status-restore.js` — a **CloudFront Function on viewer-response**
   — restores the true status from that header and removes it, just before
   the response reaches the client. This has to be a second, later stage: a
   CloudFront Function does not run at viewer-response at all when the
   response status is ≥400, which is exactly why the real 403/404 couldn't
   be fixed up directly and has to arrive here already demoted.

Neither function ever reads or sets `response.body` (Lambda@Edge
origin-response and CloudFront Functions viewer-response don't expose the
origin's body to begin with) — the real JSON survives untouched end to end.

`error_status_demote_lambda_arn` (the demote Lambda's qualified, versioned
ARN — named after the only half of the pair that is a Lambda@Edge with an
ARN worth passing; restore is a CloudFront Function created in-region with
no ARN of its own) gates **both** associations, deliberately coupled behind
this one variable (biffo-template#1576), and is empty by default, matching
every other API-behaviour variable in this module: an instance with none of
`plugin_host_api_domain`, `core_api_health_domain` or
`tracked_link_api_domain` set has no API behaviour for this to protect.
`infra/global` creates the function (see the comment there for why it can't
live in this module) and outputs the ARN for each environment to pass in,
the same wiring `acm_certificate_arn` already uses.

**Live verification is outstanding** — Terraform `plan`/`validate` cannot see
CloudFront's own error-page substitution, only a real request against a
deployed distribution can. What would prove it: an API 404 returning its JSON
`detail` with `content-type: application/json`; an API 403 doing the same,
including the role/permission detail; an unknown app path still rendering the
portal/sibling shell; and two different bogus `c/<token>` values still
returning identical 404s (the constant-404 property — see the tracked-links
section below — untouched here, since neither function reads the token,
only the response status and one header).

## Tracked links (`c/*`) — the API path contract, and why nothing enforces it automatically

Setting `tracked_link_api_domain` claims `baseurl.com/c/*` and routes it to the
Core API, but CloudFront forwards the viewer path unchanged — `c/*` is a
literal prefix match, not a rewrite rule. `aws_cloudfront_function.click_rewrite`
(`click-rewrite.js`) closes that gap by rewriting `/c/<token>` to exactly
`/api/v1/public/c/<token>` before the request leaves the edge.

**That literal path is a contract, not a convention.** Any instance that
enables this feature must implement `GET /api/v1/public/c/{token}` with
`authorization_type = "NONE"` — if the instance's own Terraform/API declares a
different path, or forgets the unauthenticated route, tracked links will 401
or 404 with no error anywhere in this module, because this module has no
visibility into an instance's routes at all (it lives in `infra/environments/`
and `services/api/src/api/domains/`, both user-owned, outside `modules/`).

This is precisely the gap biffo-plugin-marketing#52 was filed against: a
CDN behaviour and an API Gateway route agreeing with neither, previously
verified separately (Python router vs. Terraform authorization_type) and never
against each other, only surfacing as a live 401 through a real CloudFront
request. **No automated check closes this end-to-end** — see that issue and
biffo-template#1502 for why a template-side test cannot see an instance's
routes, and what an instance-side guard asserting this literal path would look
like. Verify a change here against a deployed instance, not a green
`terraform plan`.

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

## Non-production distributions are `noindex`

Every distribution where `environment != "prod"` attaches a response headers
policy adding:

```
X-Robots-Tag: noindex, nofollow
```

`count = 0` on production, so a prod distribution has **no such policy attached
at all** rather than one that happens to be empty — the difference is visible in
`terraform plan` and in the CloudFront console, which is where somebody will
actually look to confirm prod is unaffected.

### Why this is here and not in each app

A non-production distribution serves real, working, publicly reachable pages
whose content is routinely **not true**: placeholder marketing statistics,
seeded demo brands for businesses that do not exist, testimonials attributed to
invented people. Indexed and surfaced in search, that is false advertising about
a real company.

`robots.txt` is the weaker half of the control and belongs to whichever app
serves the domain root. It asks a crawler not to **fetch**; it does not stop a
URL discovered elsewhere — a link, a sitemap, someone's post — from being
**indexed**. `X-Robots-Tag` is the half that does, and only the distribution
sees every response from every sibling, so putting it here is one place to get
right instead of N places to forget.

The estate learned both halves the hard way. `dev.tabsii.com` ran with no
crawler control of any kind while serving exactly that content, and
`curl /robots.txt` answered **HTTP 200 with a body** — the front page's HTML,
because the rewrite function serves `index.html` for anything it cannot resolve.
Any check reading only the status code said it was fine. When a real
`robots.txt` was then added, it deployed as `content-type: text/x-component`,
because the deploy forces that type on every `*.txt` (Next's RSC flight payloads
use that extension) — again 200, again the right body, again not actually in
force.

**The recurring shape: a control that is present, responds successfully, and
does nothing.** Verify this one by reading the header, not the status:

```bash
curl -sI https://<non-prod-domain>/ | grep -i x-robots-tag
# x-robots-tag: noindex, nofollow
```

### Which behaviours carry it

Every behaviour that returns a body to an **anonymous crawler**: the root, every
sibling/portal prefix, tracked links (`c/*`) and `.well-known/*`.

Deliberately **not** the two API behaviours — `api/v1/plugins/*` sits behind a
Cognito authorizer so a crawler gets 401, and `api/v1/health` returns a JSON
health payload. Neither is indexable content, and leaving their configuration
untouched keeps this change scoped to the pages it is about.

`override = true`, so an origin that sets its own `X-Robots-Tag` cannot weaken
it: on a non-production distribution CloudFront's answer wins.
