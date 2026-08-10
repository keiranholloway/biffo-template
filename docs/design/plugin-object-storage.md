# M0a — plugin object storage: design layout

**Issue:** #1437 · **Status:** built. This is the design as landed; the open questions at the
foot record what was decided by default and remains reversible.

---

## The problem

Plugins have nowhere to put a file. Template Core has **no S3 at all** — no client, no bucket, no
`s3:` grant. Meanwhile `tabsii-platform` has presigning written **seven times** in instance-owned
domain code. Building this upstream creates the home those copies should have had.

## The shape

**A plugin never touches S3.** It calls Core; Core holds the bucket, the credentials and the policy.
That is ADR-0021 read literally — *"a plugin contributes an API router and UI routes"*, and *"no
per-plugin gateway, Function URL, OAC, or CloudFront behaviour."*

```
plugin  ──POST /internal/plugins/me/storage/presign──▶ Core ──▶ presigned POST + conditions
browser ──PUT bytes─────────────────────────────────────────────────────────────▶ S3
plugin  ──POST /internal/plugins/me/storage/confirm──▶ Core ──head_object──▶ S3
plugin  ──GET  /internal/plugins/me/storage/{id}/url─▶ Core ──▶ presigned GET (short)
```

Bytes never pass through a Lambda. Core only signs and verifies.

---

## The finding that should shape this most

`tabsii-platform/infra/environments/dev/fdd_evidence.tf` carries this, written from experience:

> *A presigned URL carries the SIGNER's permissions … every test stubs the client, so CI was green
> through 0005 M2, M3 and M4 while no agreement PDF could be uploaded or served on dev at all. Found
> by the first click-through.*

**Presigning is a local signing operation — it never contacts S3.** So a missing IAM prefix produces
a perfectly-formed URL that fails only when the browser uses it. Every unit test stubs the client and
stays green. Three milestones shipped broken.

There is already a guard for this in the estate — `test_evidence_bucket_prefixes.py` reads the
Terraform and asserts every prefix the code presigns into is actually granted. **That guard is the
single highest-value thing in this milestone**, and it is a copy, not an invention.

---

## Decisions

### 1. One bucket, prefix isolation, no per-plugin Terraform *(changed from my first sketch)*

```
plugins/<plugin>/<tenant_id>/<uuid4>/<sanitised-filename>
```

I first proposed a module with `for_each` over `enabled_plugins`. **That is more machinery than the
problem needs.** If isolation is by prefix and Core derives the prefix from the *verified* principal,
there is nothing per-plugin to provision — so **installing a plugin needs no Terraform change at
all**, which is a stronger form of "provisions no infrastructure" than the `for_each` version.

- `<plugin>` from `ServicePrincipal.logical_names`, never the body — the rule
  `internal_plugin_config.py` states, whose docstring names the threat.
- `<tenant_id>` per ADR-0001, and it makes per-tenant deletion expressible later.
- `<uuid4>` so the key is never derived from user input. This matches all five estate implementations
  that presign — none of them build a key from a filename.

### 2. Upload: presigned POST with conditions

`content-length-range` and an exact `Content-Type`, both as **S3 conditions** — enforced by S3, not
by us. This is the shape all five presigning implementations already use.

### 3. Confirm verifies with `head_object`. Explicitly not the `ops_evidence` shape.

The probe found genuine drift here, and it is worth naming because it is the trap to avoid:

| | reads S3 on confirm? | trusts client size? |
|---|---|---|
| `lms_media` | `head_object` | no |
| `fdd_admin`, `agreement_admin` | `get_object` (they need SHA256 anyway) | no |
| **`ops_evidence`** | **no** | **yes** — takes `size_bytes` from the request body |
| **`marketplace_media`** | **no confirm at all** | n/a |

`ops_evidence` trusts a client-supplied size against a ceiling it never verifies. A crashed upload
leaves a row claiming a size S3 does not have, and nothing ever notices. **We take the `lms_media`
shape**: `mime_type` and `size_bytes` derived from the object itself.

### 4. Serving: presigned GET by default. CloudFront is a real second option.

Both patterns exist in the estate and the split is deliberate:

- **Presigned GET, 300s** (`fdd_evidence`) — private documents. Bucket fully blocked, one Core call
  per view, link dies quickly if leaked.
- **CloudFront + OAC, immutable uuid keys, 1-day TTL** (`brand_media`) — marketplace images. A
  standing public URL, safe *only* because keys are immutable and the bucket is private behind OAC.

**Start with presigned GET.** It needs no distribution, keeps the bucket private, and is the
conservative default. Note the tradeoff plainly: a signed URL is bearer-ish — anyone holding it can
fetch until expiry.

Campaign creative that many units download repeatedly is exactly the `brand_media` case, so this will
probably want the CloudFront variant later. Worth designing the API so that is a serving-mode change,
not a redesign — hence `GET .../url` rather than baking the URL into the record.

### 5. Declared in the manifest, enforced server-side

```json
"core_capabilities": { "object-storage": "^1" },
"object_storage": { "max_bytes": 26214400, "content_types": ["image/png", "image/jpeg", "video/mp4"] }
```

`core_capabilities` is **enforced by nothing** today — no validator reads it — so the plugin polices
it with its own manifest test against the **raw JSON**, since neither the SDK nor the CLI zod schema
validates unknown keys.

---

## What gets built

| | Where |
|---|---|
| Bucket, public-access-block, encryption, CORS, lifecycle | `modules/cloud/aws/storage/` |
| `s3:` grant scoped to `plugins/*`, bucket name as env var | `infra/environments/*/` |
| First S3 client in template Core | `services/api/src/api/storage.py` |
| `presign` / `confirm` / `url` | `services/api/src/api/routers/internal_plugin_storage.py` |
| Record of what was stored | Core table + Alembic `0017` |
| Manifest schema for limits | `plugin_user_surface.py` + CLI zod + parity test |
| **IAM-prefix guard** | copied from `test_evidence_bucket_prefixes.py` |

---

## Corrections to my earlier notes

**There IS a NAT.** I said Core ran NAT-less. Wrong — `enable_nat_instance = true` in tabsii dev, and
a live fck-nat instance `tabsii-platform-dev-nat-instance` (ADR-0019, ~$3–5/mo). As you said, the S3
**Gateway** endpoint makes it moot for this design either way — and a gateway endpoint is the better
path regardless, being free and not traversing the NAT.

**Two comments in `tabsii-platform/infra/environments/dev/main.tf` are now stale** and describe the
old posture: *"the cognito-idp interface VPC endpoint the networking module creates in this NAT-less
environment"* (:233) and *"Lambda has no outbound internet so it can't call Secrets Manager"* (:251).
Live, the only VPC endpoint left is the S3 Gateway — the interface endpoints were dropped when the
NAT instance landed, which is exactly what the variable's own description says it enables. Small, but
it is the kind of stale comment that sends the next person down a wrong path, as it did me.

---

## Open questions — your call

**1. Objects on plugin uninstall — leave or delete?** **Decided: leave.**
Non-destructive and reversible; adding deletion later is easy, un-deleting is not. Nothing currently
reports the residue, which is the weaker half of that choice and worth revisiting.

**2. Fold the seven `tabsii-platform` copies onto this now, or later?** **Decided: later, tracked.** Doing it in one pass touches FDD evidence, agreements and invoices —
failure modes that are legal rather than cosmetic. Two of the seven also carry per-object Object Lock
with 7-year retention, which this capability does not model at all and should not until something
needs it.

**3. Default max upload size?** **Decided: 25 MB default, 512 MB platform ceiling.** A plugin
declaring more than the ceiling is clamped rather than refused — an install-time failure for a value
the operator cannot change at that moment helps nobody. Video will want the ceiling raised, or the
per-plugin manifest declaration wired (see the TODO in the presign route).

**4. Serving mode.** **Decided: presigned GET only.** The API returns a URL from `GET .../{id}/url`
rather than storing one on the record, so adding a CloudFront mode later is a change to how that
route answers, not a migration.

## Worth filing separately regardless of this design

`ops_evidence.py` trusts a client-supplied `size_bytes` it never verifies, where its four siblings
read the object. That is a live inconsistency in `tabsii-platform`, independent of anything here.
