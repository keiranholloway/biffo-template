"""Discovery, the ASGI-app loader, the Cognito authorizer adapter, and composition."""

from __future__ import annotations

import json

import pytest
from plugin_host.app import build_plugin_host
from plugin_host.authz import cognito_authorizer
from plugin_host.discover import discover_plugins, load_app
from plugin_host.mount import GateError
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient


def _write_plugin(root, name, *, ingress):
    d = root / name
    d.mkdir()
    manifest = {"name": name}
    if ingress is not None:
        manifest["user_ingress"] = ingress
    (d / "biffo.plugin.json").write_text(json.dumps(manifest))


def test_discover_returns_only_user_facing_plugins(tmp_path):
    _write_plugin(
        tmp_path, "ideation", ingress={"app": "ideation.app:app", "required_group": "founder"}
    )
    _write_plugin(tmp_path, "crm", ingress={"app": "crm.app:app", "required_group": "editor"})
    _write_plugin(tmp_path, "analytics", ingress=None)  # data/event plugin — skipped
    (tmp_path / "not-a-plugin").mkdir()  # no manifest — skipped

    found = discover_plugins(tmp_path)
    assert [(p.name, p.app_ref, p.required_group) for p in found] == [
        ("crm", "crm.app:app", "editor"),
        ("ideation", "ideation.app:app", "founder"),  # sorted by name
    ]


def test_discover_populates_admin_ingress_when_present(tmp_path):
    d = tmp_path / "ideation"
    d.mkdir()
    manifest = {
        "name": "ideation",
        "user_ingress": {"app": "ideation.app:app", "required_group": "founder"},
        "admin_ingress": {"app": "ideation.admin:app", "required_group": "admin"},
    }
    (d / "biffo.plugin.json").write_text(json.dumps(manifest))

    found = discover_plugins(tmp_path)
    assert len(found) == 1
    plugin = found[0]
    assert plugin.name == "ideation"
    assert plugin.admin_app_ref == "ideation.admin:app"
    assert plugin.admin_required_group == "admin"


def test_discover_leaves_admin_fields_none_when_absent(tmp_path):
    _write_plugin(
        tmp_path, "ideation", ingress={"app": "ideation.app:app", "required_group": "founder"}
    )

    found = discover_plugins(tmp_path)
    assert len(found) == 1
    plugin = found[0]
    assert plugin.admin_app_ref is None
    assert plugin.admin_required_group is None


def test_discover_empty_when_root_missing(tmp_path):
    assert discover_plugins(tmp_path / "nope") == []


def test_load_app_imports_module_attr():
    assert load_app("json:dumps") is json.dumps
    with pytest.raises(ValueError):
        load_app("json")  # not "module:attr"


def test_cognito_authorizer_maps_sdk_errors():
    # inject a fake verifier returning founder claims for any non-empty token
    def fake_verify(token, **_):
        return {"sub": "alice", "cognito:groups": ["founder"]}

    cfg = type("Cfg", (), {"user_pool_id": "p", "region": "r", "client_id": "c", "jwks_json": ""})()
    authorize = cognito_authorizer(config=cfg, verify=fake_verify)

    user = authorize("good", "founder")
    assert user.sub == "alice"
    with pytest.raises(GateError) as e401:
        authorize("", "founder")  # empty token → 401
    assert e401.value.status == 401
    with pytest.raises(GateError) as e403:
        authorize("good", "admin")  # wrong group → 403
    assert e403.value.status == 403


def test_build_plugin_host_composes_discovery_and_mounting(tmp_path):
    _write_plugin(tmp_path, "demo", ingress={"app": "demo:app", "required_group": "founder"})

    async def ping(request):
        return JSONResponse({"ok": True})

    fake_app = Starlette(routes=[Route("/ping", ping)])

    def fake_authorize(token, required_group):
        if token != "ok":
            raise GateError(401, "nope")
        return {"sub": "u"}

    host = build_plugin_host(
        tmp_path, authorize=fake_authorize, load=lambda ref: fake_app if ref == "demo:app" else None
    )
    client = TestClient(host)
    assert client.get("/demo/ping", headers={"X-Biffo-Founder-Token": "ok"}).status_code == 200
    assert client.get("/demo/ping").status_code == 401  # gate still enforced


def test_an_admin_only_plugin_is_discovered(tmp_path) -> None:
    """A plugin declaring only ``admin_ingress`` must not be discarded.

    Discovery required ``user_ingress`` and parsed ``admin_ingress`` only for
    the survivors, so an admin-only plugin was dropped at runtime even after
    the deploy had packaged its code onto the host — the same filter one layer
    down from the packaging loop fixed in #1466. Both pre-existing plugins
    declare both surfaces, so nothing exercised this until
    biffo-plugin-marketing, the estate's first admin-only plugin.
    """
    root = tmp_path / "services" / "marketing"
    root.mkdir(parents=True)
    (root / "biffo.plugin.json").write_text(
        json.dumps(
            {
                "name": "marketing",
                "admin_ingress": {"app": "marketing.admin_app:app", "required_group": "admin"},
            }
        )
    )

    found = discover_plugins(tmp_path / "services")

    assert [p.name for p in found] == ["marketing"]
    assert found[0].admin_app_ref == "marketing.admin_app:app"
    assert found[0].admin_required_group == "admin"
    # No user surface — these stay None rather than being invented.
    assert found[0].app_ref is None
    assert found[0].required_group is None


def test_a_declared_but_incomplete_user_ingress_is_still_skipped(tmp_path) -> None:
    """Admitting admin-only plugins must not admit broken declarations.

    A ``user_ingress`` present but missing ``app`` or ``required_group`` is a
    malformed manifest, not an admin-only plugin. Skipping it is the behaviour
    that existed before, and this asserts the widening did not swallow it.
    """
    root = tmp_path / "services" / "broken"
    root.mkdir(parents=True)
    (root / "biffo.plugin.json").write_text(
        json.dumps({"name": "broken", "user_ingress": {"app": "broken:app"}})
    )

    assert discover_plugins(tmp_path / "services") == []
