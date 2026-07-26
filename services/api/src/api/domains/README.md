# Product domains (`domains/<name>/`)

This directory is your instance's home for its **own product-domain code** inside
the core API — models, routers, events, schemas, and their tests. It is
**user-owned** (`core-manifest.json`), so you edit it freely: the core-ownership
guard won't block your commits and `biffo core upgrade` won't treat it as
template drift, even though it lives inside the otherwise template-owned
`services/api/`.

**Why it lives here** (see [ADR-0022](../../../../../docs/ADR/0022-product-domain-modules-are-user-owned-guests.md)):
ADR-0002 makes the core API the single data plane — the platform owns the data
and applications are guests. A sibling (ADR-0007) holds no database; a plugin
(ADR-0003) owns no data. So your product's canonical relational domain belongs in
the core DB/API by design — and this carve-out is its ownership home.

## Adding a domain

Create a package `domains/<name>/` whose `__init__.py` exposes a `routers`
sequence and imports its models:

```python
# domains/<name>/__init__.py
from .routers.things import router as things_router
from . import models  # noqa: F401 — import so tables register with Base.metadata

routers = [things_router]
```

The template-owned `api.routing.domain_router` discovers every non-private
package here at startup and mounts its `routers` — keeping their **native paths**
(no `/domains/<name>` prefix), so a domain relocated here serves exactly the
routes it did as a native router. Nothing else changes.

- Tenant-scope every route (`require_tenant_context`) and inherit
  `TenantScopedModel` for every table — the same core invariants apply here.
- DDL-imported schemas live under the (also user-owned) `db/imports/<name>/`.
- A domain that fails to import raises at startup — a broken product domain
  should surface at deploy, not silently serve nothing.
