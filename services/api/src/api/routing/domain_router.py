"""Registration of instance product-domain routers hosted in the core API
(ADR-0022).

An instance's own product-domain code — its models, routers, events, schemas —
legitimately lives *inside* the core API: ADR-0002 makes the platform the sole
data plane, so the shared canonical domain belongs in the core DB/API by design
(a sibling holds no DB, ADR-0007; a plugin owns no data, ADR-0003). But
everything under ``services/api/`` is template-owned, so an instance had no home
for its *own* domain code without the core-ownership guard blocking the commit
and ``biffo core upgrade`` treating it as template drift.

ADR-0022 gives it one: ``services/api/src/api/domains/<name>/`` is a **user-owned**
carve-out inside the template-owned core API (longest-prefix-wins in
``core-manifest.json``, exactly as ``migrations/versions/`` already is). This
module is the template-owned *registration* seam for it — the discovery logic
stays template-maintained and distributes, while the domains it discovers are
the instance's own.

Unlike a plugin route (a declarative ``(method, path, table, operation)`` Core
synthesizes a generic handler for — see ``plugin_router``), a product domain is
first-party, trusted code: it ships real, hand-written ``APIRouter``s with real
handlers, the same as the core's own native routers. So this seam simply
*includes* what each domain exports rather than synthesizing anything.

**Convention.** A domain is a package ``api.domains.<name>`` whose ``__init__``
exposes ``routers``: a sequence of ``APIRouter`` to mount (keep it empty or omit
it to expose none). The domain's ``__init__`` should also import its models so
their tables register with ``Base.metadata`` when the domain is loaded. A domain
that fails to import raises — a broken product domain should surface at deploy,
not silently serve nothing (this matches how a broken native-router import in
``main.py`` already behaves). Only the *absence* of the ``domains/`` tree (the
base template, no product domain yet) is handled silently: the base deployment
mounts nothing.
"""

from __future__ import annotations

import importlib
from collections.abc import Sequence
from pathlib import Path

from aws_lambda_powertools import Logger
from fastapi import APIRouter

logger = Logger()

_OWN_SUFFIX = ".routing.domain_router"


def _root_package_from_module_name(name: str) -> str:
    """The app's top-level package, given this module's own ``__name__``.

    Normally ``api`` — this module is ``api.routing.domain_router``, so the
    domains package is ``api.domains``. Strips this module's own known
    ``.routing.domain_router`` suffix rather than taking just ``name``'s first
    dotted segment, so it still resolves correctly when the app is imported
    under a deeper root — some of this project's own tests import it as
    ``src.api.main`` (chdir'd into ``services/api/`` so ``src`` becomes the
    importable top-level), where the first-segment approach used to compute
    the domains package as ``src.domains`` instead of the real
    ``src.api.domains``, raising ModuleNotFoundError the moment a real
    instance domain existed to discover (harmless before that, since a
    domain-free tree never reached the import).
    """
    return name.removesuffix(_OWN_SUFFIX)


_ROOT_PACKAGE = _root_package_from_module_name(__name__)
_DOMAINS_PACKAGE = f"{_ROOT_PACKAGE}.domains"
_DOMAINS_DIR = Path(__file__).resolve().parent.parent / "domains"


def _discover_domain_names() -> list[str]:
    """Names of the domain packages under ``domains/`` — every immediate
    subdirectory that is an importable package (has ``__init__.py``) and is not
    private (``_``-prefixed, matching the ``_template``/``_plugins`` convention).
    Empty when the ``domains/`` tree is absent (the base template)."""
    if not _DOMAINS_DIR.is_dir():
        return []
    return sorted(
        entry.name
        for entry in _DOMAINS_DIR.iterdir()
        if entry.is_dir() and not entry.name.startswith("_") and (entry / "__init__.py").is_file()
    )


def build_domain_router() -> APIRouter:
    """One ``APIRouter`` aggregating every product domain's exported routers.

    ``main.py`` includes it with ``prefix="/api/v1"``; a domain's routers keep
    their own paths (no ``/domains/<name>`` namespacing), so a domain relocated
    into this tree serves the *same* paths it did as a native router — the API
    contract to siblings is unchanged (ADR-0022). Empty in the base deployment.

    Domain packages import here, at this call, before ``main.py`` has finished
    executing (#1779) — including any that do ``from ...main import tracer``.
    That resolves correctly via ``main.__getattr__`` (#1808) rather than
    raising, so no special handling is needed here for it.
    """
    router = APIRouter()
    for name in _discover_domain_names():
        module = importlib.import_module(f"{_DOMAINS_PACKAGE}.{name}")
        domain_routers: Sequence[APIRouter] = getattr(module, "routers", ())
        for sub in domain_routers:
            router.include_router(sub)
        logger.info(
            "Registered product domain",
            domain=name,
            routers=len(tuple(domain_routers)),
        )
    return router
