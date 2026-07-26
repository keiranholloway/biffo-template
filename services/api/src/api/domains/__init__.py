"""Instance product-domain code — a user-owned guest hosted in the core API
(ADR-0022).

This package (``services/api/src/api/domains/``) is **user-owned** in
``core-manifest.json`` even though it sits inside the template-owned
``services/api/`` (longest-prefix-wins, exactly as ``migrations/versions/`` is).
It is where an instance keeps its OWN product domain — models, routers, events,
schemas, tests — because ADR-0002 makes the core the sole data plane, so the
shared canonical domain belongs here by design (a sibling holds no DB; a plugin
owns no data).

Add a domain as a package ``domains/<name>/`` whose ``__init__`` exposes
``routers`` (a sequence of ``APIRouter``) and imports its models so their tables
register with ``Base.metadata``. The template-owned ``api.routing.domain_router``
discovers and mounts it; the routers keep their native paths, so the API
contract is unchanged. See ``README.md`` here and ADR-0022. Empty by default —
the base template ships no product domain.
"""
