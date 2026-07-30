"""A domain package is a user-owned home for a deployment's identity provider.

ADR-0012 gives a deployment somewhere to *implement* `IdentityProvider`, and
`set_identity_provider` to install it — but never said where the provider may
live or from what the call may be made. In practice "the API's startup path"
meant template-owned `main.py`, so tabsii-platform carries its provider at
`identity/tabsii.py` (an instance-only file inside a template-owned tree, needing
a per-commit Core-Divergence trailer to edit) and three lines wedged into
`main.py`. That ownership gap is #893.

The mechanism it needs already works: `build_domain_router()` imports every
package under the *user-owned* `domains/`, and `main.py` calls it at module scope
before `Mangum` wraps the app. So a domain's `__init__.py` can install a provider
and have it live before the first request. This file makes that a guarantee
instead of an accident, because nothing asserted it.

The precedent for why that matters is #668: the same `build_domain_router()` call
had to stay above `build_core_crud_router()` for model registration to work, the
ordering was incidental rather than tested, and when it moved, 21 routes silently
disappeared — with a green suite and a green CI. An untested ordering here fails
the same way, except the casualty is every authenticated request resolving
against the wrong identity store.

Registration is exercised through a *real* import of a *real* package, not a
monkeypatched `import_module`, because the whole claim is that Python's import of
a domain package runs the call. `api.domains.__path__` is extended to a tmp_path
so the package is genuinely importable without writing into the source tree.
"""

import importlib
import sys
from pathlib import Path

import pytest
from api.identity import DefaultIdentityProvider, get_identity_provider, set_identity_provider
from api.routing import domain_router
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

# A domain that installs a provider at import time — what domains/README.md
# documents and what tabsii's domains/tabsii/__init__.py already does for two
# other Core registries. Written as source rather than imported so the
# registration really happens during `importlib.import_module`.
_REGISTERING_DOMAIN = '''\
"""Synthetic product domain that installs an identity provider at import time."""

from api.identity import set_identity_provider

SESSIONS: list[str] = []


class ProbeProvider:
    """A deployment's provider, living in the domain package that registers it."""

    def session(self):
        return _probe_session()

    async def resolve(self, db, claims):
        raise AssertionError("this test never authenticates")

    async def sync_platform_admin(self, db, user_id, is_member):
        return None

    async def resolve_permissions(self, db, user_id):
        return frozenset()


async def _probe_session():
    SESSIONS.append("opened")
    yield "probe-session"
    SESSIONS.append("closed")


PROVIDER = ProbeProvider()
set_identity_provider(PROVIDER)
'''

# The negative control: a well-formed domain that simply does not register. If a
# test cannot tell this apart from the one above, it is not testing registration.
_INERT_DOMAIN = '''\
"""Synthetic product domain that registers nothing."""

routers = ()
'''


@pytest.fixture(autouse=True)
def _restore_provider():
    """The provider is process-global; never let a test leak one."""
    original = get_identity_provider()
    yield
    set_identity_provider(original)


@pytest.fixture
def install_domain(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Make a real, importable `api.domains.<name>` backed by tmp_path.

    Both halves are needed and they are separate concerns: `_DOMAINS_DIR` is what
    discovery globs, and `api.domains.__path__` is what the import system
    searches. Extending the package path rather than writing into
    `services/api/src/api/domains/` keeps the source tree clean even if this test
    fails midway.
    """
    domains_pkg = importlib.import_module("api.domains")
    monkeypatch.setattr(domain_router, "_DOMAINS_DIR", tmp_path)
    monkeypatch.setattr(domains_pkg, "__path__", [*domains_pkg.__path__, str(tmp_path)])

    installed: list[str] = []

    def _install(name: str, source: str) -> str:
        package = tmp_path / name
        package.mkdir()
        (package / "__init__.py").write_text(source)
        importlib.invalidate_caches()
        installed.append(f"api.domains.{name}")
        return f"api.domains.{name}"

    yield _install

    for module_name in installed:
        sys.modules.pop(module_name, None)


def test_a_domain_can_install_the_provider_from_its_own_package(install_domain) -> None:
    module_name = install_domain("shopidentity", _REGISTERING_DOMAIN)

    domain_router.build_domain_router()

    module = sys.modules[module_name]
    assert get_identity_provider() is module.PROVIDER
    # Named for the record: the provider a deployment owns, installed without one
    # template-owned file being edited.
    assert type(get_identity_provider()).__name__ == "ProbeProvider"


def test_a_domain_that_registers_nothing_leaves_the_default_installed(install_domain) -> None:
    # The control. `build_domain_router()` imports this package too, so a test
    # that passes here *and* above is distinguishing registration from mere
    # discovery.
    install_domain("shopinert", _INERT_DOMAIN)

    domain_router.build_domain_router()

    assert isinstance(get_identity_provider(), DefaultIdentityProvider)


def test_the_registered_provider_is_live_on_the_request_path(install_domain) -> None:
    """Installed is not the same as in effect — assert through a served request."""
    from api.identity import identity_session

    module_name = install_domain("shopserving", _REGISTERING_DOMAIN)
    domain_router.build_domain_router()
    module = sys.modules[module_name]

    app = FastAPI()

    @app.get("/whose-session")
    def _whose_session(db=Depends(identity_session)) -> dict:
        return {"session": db}

    with TestClient(app) as client:
        assert client.get("/whose-session").json() == {"session": "probe-session"}

    # Opened *and* closed: `identity_session` drives the provider's generator
    # through its full lifecycle rather than leaking it.
    assert module.SESSIONS == ["opened", "closed"]


def test_domain_registration_precedes_the_handler_in_main() -> None:
    """The ordering that makes import-time registration sufficient.

    `main.py` builds the handler with `lifespan="off"`, so there is no startup
    event and **import time is the only registration window**. A provider
    installed by a domain is therefore in place for the first request only
    because `build_domain_router()` runs above the handler assignment. Nothing
    else pins that, and #668 is what an unpinned ordering here costs.
    """
    source = (Path(domain_router.__file__).resolve().parents[1] / "main.py").read_text()

    assert 'lifespan="off"' in source, "no startup event: import time must stay the only window"
    assert source.index("build_domain_router()") < source.index("Mangum(")
