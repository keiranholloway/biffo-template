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

- Tenant-scope every route (`require_tenant_context`). Inherit
  `TenantScopedModel` for every table you define here — the same core
  invariants apply.
- **A DDL-imported table may need its own base, and that is supported (#890).**
  An ADR-0005 schema often cannot inherit `TenantScopedModel`: its columns are
  fixed by the source system (a native `UUID` primary key, a real tenant
  foreign key, soft-delete) and `TenantScopedModel`'s `String(36)` id and
  `"default"` tenant seam cannot express them. Declare a second abstract base
  under `Base` — `class ImportedTableModel(Base)` with `__abstract__ = True` —
  and generic CRUD will discover its subclasses, because the permissions walk
  starts at `Base`.

  It must inherit `Base`. A fresh `DeclarativeBase` carries its own registry
  and metadata, so it would be a separate schema surface and nothing in the
  Core API would see it.
- DDL-imported schemas live under the (also user-owned) `db/imports/<name>/`.
- A domain that fails to import raises at startup — a broken product domain
  should surface at deploy, not silently serve nothing.

## Declaring Python dependencies (#891)

Need a package the template does not ship — `geoalchemy2` and `shapely` for
PostGIS geometry columns, say? Do **not** edit `services/api/pyproject.toml`. It
is template-owned, so the commit-time guard blocks it, `biffo core upgrade`
fights you over it forever, and taking the package upstream would make every
other instance pay its import cost on every cold start (#890, #724).

Declare it in `domains/<name>/requirements.txt` instead:

```
# domains/<name>/requirements.txt — this file IS your domain's lockfile.
geoalchemy2==0.15.2
shapely==2.0.6
```

Generate it rather than hand-editing, so the transitive closure is pinned too:

```bash
uv pip compile services/api/src/api/domains/<name>/requirements.in \
  -o services/api/src/api/domains/<name>/requirements.txt
```

Then install it into your venv, exactly as CI and the deploy do:

```bash
uv sync --all-groups && sh scripts/sync-domain-deps.sh
```

`ci.yml` runs the same command (so your domain's dependencies are type-checked,
tested and advisory-scanned), and `deploy-app.yml` runs it with `--target
package/` (so they reach the Lambda). There is nothing else to wire.

**The rules, and why.** Your file is installed as a *second* layer on top of
core's own frozen resolution, under a constraint file exported from `uv.lock`.
So:

- **Every requirement must be pinned with `==`.** No ranges, no URLs, no VCS
  refs, no local paths, no `--index-url`/`--find-links`/`-e`/`-r` lines. A deploy
  must ship what a reviewer read.
- **You may not name a package that is already in `uv.lock`.** It is a core
  dependency; import it, it is already installed. Restating it — even at the same
  version — is rejected by name, and a *different* version is refused by the
  resolver on top of that. Two copies of one distribution cannot both be on the
  Lambda's path, so a domain that needs a newer core dependency has to move
  core's pin upstream, deliberately, rather than have one silently win here.
- **Two domains sharing a dependency must agree on its version.**

`scripts/domain_requirements.py --check` tells you about all of this by file and
line, and runs in CI whether you remember to or not.

## Registering with a core seam (including your identity provider)

`routers` is not the only thing a domain may export. Because discovery **imports**
your package, its `__init__.py` is a user-owned place to register with any core
registry — the same mechanism `api.events.registry` documents for event types:
registration happens at import time, so a downstream repo registers *without
editing a template-owned file*.

The seam this matters most for is **identity**. If your deployment's users do not
live in `public.users`, [ADR-0012](../../../../../docs/ADR/0012-identity-provider-seam.md)
lets you implement `IdentityProvider` instead of forking the auth path — and the
provider module belongs **here, in `domains/<name>/`**, not in the template-owned
`identity/` package:

```python
# domains/<name>/identity.py
class MyIdentityProvider:  # structural — do not subclass IdentityProvider
    ...


# domains/<name>/__init__.py
from api.identity import set_identity_provider

from .identity import MyIdentityProvider

set_identity_provider(MyIdentityProvider())
```

**Why this is sufficient, and why it is the only window.** `main.py` builds its
Lambda handler with `lifespan="off"`, so there is no startup event to hook —
import time is the only opportunity. `build_domain_router()` runs at module scope
above that handler, and importing your package is what runs the call, so the
provider is installed before the first request is served. `identity_session`
dispatches through `get_identity_provider()` per request rather than binding a
session at import time, so middleware imported earlier still picks your provider
up. This ordering is pinned by
`services/api/tests/test_identity_provider_registration.py` — do not rely on it
without that guard, because the last unpinned ordering in this file's mechanism
(#668) silently dropped 21 routes with a green suite.

Putting the provider in `identity/` instead is what this carve-out exists to
avoid: that path is template-owned, so the commit-time guard blocks edits and
every change needs a per-commit `Core-Divergence` trailer.

## Tracing your own domain code

`main.py` builds a module-level `tracer = aws_lambda_powertools.Tracer()`, but
constructs it **after** `build_domain_router()` runs — i.e. after your
domain's `__init__.py` has already been imported (issue #1779).
`Tracer()`'s own `__init__` eagerly imports `aws_xray_sdk`/`botocore`
regardless of whether tracing ends up enabled; constructing it before domain
registration used to silently pre-warm that cost onto whichever domain
happened to import next, masking it from any downstream fix trying to
measure its own import weight. Deferring it fixed that, but it also means
`from api.main import tracer` — the obvious move, symmetric with the
identity-provider example above — **always raises** `ImportError: cannot
import name 'tracer' from partially initialized module 'api.main'` at
deploy-time import: `main.tracer` genuinely does not exist yet at the moment
your package is imported.

**Do not import `main.tracer`. Construct your own instead:**

```python
# domains/<name>/__init__.py
from aws_lambda_powertools import Tracer

tracer = Tracer()


@tracer.capture_method
def some_handler_helper(...):
    ...
```

This is not a second, divergent tracer — `aws_lambda_powertools` caches the
underlying X-Ray provider as a class attribute shared by every `Tracer()`
instance in the process, so whichever one is constructed first (your
domain's, since it runs before `main.py`'s) does the real
`aws_xray_sdk`/`botocore` import and every later `Tracer()` — including
`main.py`'s own, further down the module — reuses that same provider for
free. The two objects are different instances but the same tracer: no
double-patching, no behavioural difference from importing a shared instance,
and the import cost is now correctly attributed to the domain that actually
wants tracing instead of silently absorbed by whichever router happened to
load first. `build_domain_router()` detects the disallowed `main.tracer`
import specifically and re-raises it with a message pointing back here,
rather than the raw partial-init text, so this is not a trap left for the
next author to discover by cold-start crash.
