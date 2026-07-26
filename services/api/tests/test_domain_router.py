"""Unit tests for the product-domain registration seam (ADR-0022):
``api.routing.domain_router``.

Covers the two things the seam must get right: discovering which packages under
``domains/`` are real domains (ignoring private/non-package entries), and
aggregating each discovered domain's exported ``routers`` into one router with
their native paths preserved. The filesystem and import steps are exercised
through their own seams (``_DOMAINS_DIR`` / ``importlib.import_module``) so the
test needs no real installable domain package. Aggregation is verified the way
``main.py`` actually mounts it — included into a FastAPI app and driven with a
``TestClient`` — rather than by introspecting route objects.
"""

from pathlib import Path
from types import SimpleNamespace

import pytest
from api.routing import domain_router
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

# services/api/tests/ -> services/api/ -> services/ -> repo root.
_REPO_ROOT = Path(__file__).resolve().parents[3]
_IS_INSTANCE = (_REPO_ROOT / "biffo.core.json").is_file()


def _client_for(router: APIRouter) -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


@pytest.mark.skipif(
    _IS_INSTANCE,
    reason=(
        "only true of the template's own pristine domains/ (__init__.py + "
        "README, no domain packages); an instance is expected to add "
        "domains/<name>/ (ADR-0022), which correctly makes real discovery "
        "non-empty — this assertion is template-only, not a general contract"
    ),
)
def test_base_template_has_no_domains_and_mounts_nothing() -> None:
    # The base template ships domains/ with only __init__.py + README (no domain
    # packages), so real discovery finds nothing.
    assert domain_router._discover_domain_names() == []
    client = _client_for(domain_router.build_domain_router())
    assert client.get("/brands").status_code == 404


def test_discover_ignores_private_and_non_package_entries(tmp_path, monkeypatch) -> None:
    (tmp_path / "shop").mkdir()
    (tmp_path / "shop" / "__init__.py").touch()
    (tmp_path / "crm").mkdir()
    (tmp_path / "crm" / "__init__.py").touch()
    # Ignored: private prefix, missing __init__.py, and a plain file.
    (tmp_path / "_scratch").mkdir()
    (tmp_path / "_scratch" / "__init__.py").touch()
    (tmp_path / "notapackage").mkdir()
    (tmp_path / "README.md").touch()

    monkeypatch.setattr(domain_router, "_DOMAINS_DIR", tmp_path)
    assert domain_router._discover_domain_names() == ["crm", "shop"]


def test_discover_is_empty_when_the_tree_is_absent(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(domain_router, "_DOMAINS_DIR", tmp_path / "does-not-exist")
    assert domain_router._discover_domain_names() == []


def test_build_aggregates_each_domains_routers_with_native_paths(monkeypatch) -> None:
    shop = APIRouter()

    @shop.get("/brands")
    def _brands() -> dict:
        return {"domain": "shop"}

    crm = APIRouter()

    @crm.get("/leads")
    def _leads() -> dict:
        return {"domain": "crm"}

    modules = {
        "api.domains.shop": SimpleNamespace(routers=[shop]),
        "api.domains.crm": SimpleNamespace(routers=[crm]),
    }
    monkeypatch.setattr(domain_router, "_discover_domain_names", lambda: ["shop", "crm"])
    monkeypatch.setattr("importlib.import_module", lambda name: modules[name])

    client = _client_for(domain_router.build_domain_router())
    # Native paths preserved — no /domains/<name> namespacing (the ADR-0022
    # "contract unchanged" guarantee).
    assert client.get("/brands").json() == {"domain": "shop"}
    assert client.get("/leads").json() == {"domain": "crm"}


def test_build_tolerates_a_domain_that_exports_no_routers(monkeypatch) -> None:
    monkeypatch.setattr(domain_router, "_discover_domain_names", lambda: ["bare"])
    monkeypatch.setattr("importlib.import_module", lambda name: SimpleNamespace())
    client = _client_for(domain_router.build_domain_router())
    assert client.get("/anything").status_code == 404


@pytest.mark.parametrize(
    ("module_name", "expected_root"),
    [
        ("api.routing.domain_router", "api"),
        # Regression: this project's own test suite sometimes imports the app
        # as ``src.api.main`` (chdir'd into services/api/, so ``src`` becomes
        # the importable top-level) rather than ``api.main``. Taking only
        # __name__'s first dotted segment used to silently resolve the
        # domains package as "src.domains" instead of the real
        # "src.api.domains" in that context — invisible as long as no domain
        # package existed to discover, ModuleNotFoundError the moment one did.
        ("src.api.routing.domain_router", "src.api"),
    ],
)
def test_root_package_resolves_correctly_regardless_of_import_depth(
    module_name: str, expected_root: str
) -> None:
    assert domain_router._root_package_from_module_name(module_name) == expected_root
