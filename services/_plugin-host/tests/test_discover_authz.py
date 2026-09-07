"""Discovery, the ASGI-app loader, the Cognito authorizer adapter, and composition."""

from __future__ import annotations

import json
from pathlib import Path

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
    manifest = {"name": name, "version": "1.0.0"}
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


def test_discover_uses_manifest_literal_required_group_when_no_override_set(
    tmp_path, monkeypatch
) -> None:
    """No `BIFFO_PLUGIN_IDEATION_USER_INGRESS_REQUIRED_GROUP` in the host's
    environment — the manifest's own literal is used unchanged, so every
    already-shipped plugin manifest keeps working with zero changes
    (biffo-template#1517 Option B)."""
    monkeypatch.delenv("BIFFO_PLUGIN_IDEATION_USER_INGRESS_REQUIRED_GROUP", raising=False)
    _write_plugin(
        tmp_path, "ideation", ingress={"app": "ideation.app:app", "required_group": "founder"}
    )

    found = discover_plugins(tmp_path)

    assert found[0].required_group == "founder"


def test_discover_honours_an_instance_supplied_required_group_override(
    tmp_path, monkeypatch
) -> None:
    """An instance-supplied `BIFFO_PLUGIN_<PLUGIN>_USER_INGRESS_REQUIRED_GROUP`
    overrides the manifest's literal `user_ingress.required_group`
    (biffo-template#1517 Option B — unblocks marketing#46: a group name like
    `"founder"` baked into a third-party manifest is platform-specific and
    unreachable on an instance that names its equivalent group differently).
    """
    monkeypatch.setenv("BIFFO_PLUGIN_MARKETING_USER_INGRESS_REQUIRED_GROUP", "hq-marketing-admin")
    _write_plugin(
        tmp_path, "marketing", ingress={"app": "marketing.app:app", "required_group": "founder"}
    )

    found = discover_plugins(tmp_path)

    assert found[0].required_group == "hq-marketing-admin"


def test_discover_required_group_override_is_scoped_by_plugin_name(tmp_path, monkeypatch) -> None:
    """Two plugins never collide on this override — only the exact
    `BIFFO_PLUGIN_<PLUGIN>_USER_INGRESS_REQUIRED_GROUP` for THIS plugin's name
    is read, the same per-plugin scoping the rest of the `config:` mechanism
    already guarantees (`pluginConfigEnvNames`/`plugin_config_env_names`)."""
    monkeypatch.setenv("BIFFO_PLUGIN_CRM_USER_INGRESS_REQUIRED_GROUP", "crm-override")
    _write_plugin(
        tmp_path, "ideation", ingress={"app": "ideation.app:app", "required_group": "founder"}
    )
    _write_plugin(tmp_path, "crm", ingress={"app": "crm.app:app", "required_group": "editor"})

    found = discover_plugins(tmp_path)

    by_name = {p.name: p.required_group for p in found}
    assert by_name == {"crm": "crm-override", "ideation": "founder"}


def test_discover_required_group_override_is_ignored_for_an_admin_only_plugin(
    tmp_path, monkeypatch
) -> None:
    """A plugin with no `user_ingress` at all has no `required_group` to
    override — setting the env var anyway must not invent one out of an
    admin-only plugin's admin_ingress."""
    monkeypatch.setenv("BIFFO_PLUGIN_MARKETING_USER_INGRESS_REQUIRED_GROUP", "should-not-apply")
    root = tmp_path / "marketing"
    root.mkdir()
    (root / "biffo.plugin.json").write_text(
        json.dumps(
            {
                "name": "marketing",
                "version": "1.0.0",
                "admin_ingress": {"app": "marketing.admin_app:app", "required_group": "admin"},
            }
        )
    )

    found = discover_plugins(tmp_path)

    assert found[0].required_group is None
    assert found[0].admin_required_group == "admin"  # untouched — override is user_ingress-only


def test_discover_populates_admin_ingress_when_present(tmp_path):
    d = tmp_path / "ideation"
    d.mkdir()
    manifest = {
        "name": "ideation",
        "version": "1.0.0",
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


def test_discover_populates_user_frontend_when_present(tmp_path) -> None:
    """``user_frontend`` (dir, required_group) is carried onto DiscoveredPlugin
    — plumbing, not new validation (ADR-0021 §2, #558 M2)."""
    d = tmp_path / "ideation"
    d.mkdir()
    manifest = {
        "name": "ideation",
        "version": "1.0.0",
        "user_ingress": {"app": "ideation.app:app", "required_group": "founder"},
        "user_frontend": {"dir": "web/dist", "required_group": "founder"},
    }
    (d / "biffo.plugin.json").write_text(json.dumps(manifest))

    found = discover_plugins(tmp_path)
    assert len(found) == 1
    assert found[0].user_frontend_dir == "web/dist"
    assert found[0].user_frontend_required_group == "founder"


def test_discover_leaves_user_frontend_fields_none_when_absent(tmp_path) -> None:
    _write_plugin(
        tmp_path, "ideation", ingress={"app": "ideation.app:app", "required_group": "founder"}
    )

    found = discover_plugins(tmp_path)
    assert len(found) == 1
    assert found[0].user_frontend_dir is None
    assert found[0].user_frontend_required_group is None


def test_a_malformed_user_frontend_drops_only_the_frontend_not_the_plugin(tmp_path, caplog) -> None:
    """``user_frontend`` joined ``_SALVAGEABLE_FIELDS`` alongside user_ingress/
    admin_ingress: an incomplete declaration (missing required_group here) must
    drop just the frontend surface, not discard the whole plugin — the same
    salvage rule #1517 established for the other two ingress fields."""
    root = tmp_path / "services" / "ideation"
    root.mkdir(parents=True)
    (root / "biffo.plugin.json").write_text(
        json.dumps(
            {
                "name": "ideation",
                "version": "1.0.0",
                "user_ingress": {"app": "ideation.app:app", "required_group": "founder"},
                "user_frontend": {"dir": "web/dist"},  # missing required_group
            }
        )
    )

    with caplog.at_level("ERROR"):
        found = discover_plugins(tmp_path / "services")

    assert [p.name for p in found] == ["ideation"]
    assert found[0].app_ref == "ideation.app:app"  # the valid surface survives
    assert found[0].user_frontend_dir is None  # the malformed one was dropped
    assert found[0].user_frontend_required_group is None
    assert any("ideation" in record.message for record in caplog.records)


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


def test_build_plugin_host_resolves_and_serves_user_frontend(tmp_path) -> None:
    """``build_plugin_host`` joins discover.py's manifest-relative
    ``user_frontend_dir`` against ``BIFFO_PLUGINS_ROOT/<name>`` itself and the
    resulting mount actually serves the bundle end to end — the seam between
    discovery (relative path) and mounting (a real filesystem directory),
    which neither module's own unit tests exercise alone (ADR-0021 §2, #558
    M2)."""
    services_root = tmp_path / "services"
    plugin_dir = services_root / "demo"
    plugin_dir.mkdir(parents=True)
    (plugin_dir / "biffo.plugin.json").write_text(
        json.dumps(
            {
                "name": "demo",
                "version": "1.0.0",
                "user_ingress": {"app": "demo:app", "required_group": "founder"},
                "user_frontend": {"dir": "web/dist", "required_group": "founder"},
            }
        )
    )
    dist = plugin_dir / "web" / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("<div id='root'></div>")

    async def ping(request):
        return JSONResponse({"ok": True})

    fake_app = Starlette(routes=[Route("/ping", ping)])

    def fake_authorize(token, required_group):
        if token != "ok":
            raise GateError(401, "nope")
        return {"sub": "u"}

    host = build_plugin_host(
        services_root,
        authorize=fake_authorize,
        load=lambda ref: fake_app if ref == "demo:app" else None,
    )
    client = TestClient(host)
    # The API stays gated...
    assert client.get("/demo/ping").status_code == 401
    # ...while the resolved BIFFO_PLUGINS_ROOT/demo/web/dist shell is public.
    r = client.get("/demo/ui/")
    assert r.status_code == 200
    assert "root" in r.text


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
                "version": "1.0.0",
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
        json.dumps({"name": "broken", "version": "1.0.0", "user_ingress": {"app": "broken:app"}})
    )

    assert discover_plugins(tmp_path / "services") == []


def test_an_incomplete_user_ingress_does_not_discard_a_valid_admin_ingress(tmp_path) -> None:
    """The latent bug this module's docstring documents (biffo-template#1517).

    A ``user_ingress`` present but missing ``required_group`` used to fail the
    whole manifest's validation and discard it wholesale — including a
    perfectly valid, unrelated ``admin_ingress`` declared on the very same
    plugin. The malformed ``user_ingress`` is dropped (and logged), the plugin
    is still discovered, and its valid ``admin_ingress`` survives.
    """
    root = tmp_path / "services" / "half-broken"
    root.mkdir(parents=True)
    (root / "biffo.plugin.json").write_text(
        json.dumps(
            {
                "name": "half-broken",
                "version": "1.0.0",
                "user_ingress": {"app": "half_broken:app"},  # missing required_group
                "admin_ingress": {
                    "app": "half_broken.admin:app",
                    "required_group": "admin",
                },
            }
        )
    )

    found = discover_plugins(tmp_path / "services")

    assert [p.name for p in found] == ["half-broken"]
    assert found[0].admin_app_ref == "half_broken.admin:app"
    assert found[0].admin_required_group == "admin"
    # The malformed user_ingress was dropped, not invented.
    assert found[0].app_ref is None
    assert found[0].required_group is None


def test_a_manifest_broken_outside_the_ingress_fields_is_skipped_entirely(tmp_path) -> None:
    """A validation failure that is NOT confined to user_ingress/admin_ingress
    (here: a route referencing a table the manifest never declares) is a
    genuinely broken manifest, not a salvageable one — the whole plugin is
    skipped, including its otherwise-valid admin_ingress. Distinguishes the
    surgical salvage above from a blanket "always keep trying" policy.
    """
    root = tmp_path / "services" / "broken-routes"
    root.mkdir(parents=True)
    (root / "biffo.plugin.json").write_text(
        json.dumps(
            {
                "name": "broken-routes",
                "version": "1.0.0",
                "admin_ingress": {"app": "broken_routes.admin:app", "required_group": "admin"},
                "api_routes": [
                    {
                        "method": "GET",
                        "path": "/widgets",
                        "table": "widgets",  # never declared in `tables`
                        "operation": "list",
                    }
                ],
            }
        )
    )

    assert discover_plugins(tmp_path / "services") == []


def test_a_typo_d_admin_ingress_key_is_rejected_and_logged_loudly(tmp_path, caplog) -> None:
    """``admin_ingres`` (one 's') used to validate silently, per no
    ``model_config`` on ``PluginManifest`` at all — that is the exact typo the
    issue's second comment reproduced against the real marketing manifest.
    ``extra="forbid"`` now rejects it; discovery must skip the plugin rather
    than raise (a malformed manifest must not take every other installed
    plugin on the shared host down with it), but the skip must be loud —
    logged, not the silent ``continue`` this replaces.
    """
    root = tmp_path / "services" / "typo"
    root.mkdir(parents=True)
    (root / "biffo.plugin.json").write_text(
        json.dumps(
            {
                "name": "typo",
                "version": "1.0.0",
                "admin_ingres": {"app": "typo.admin:app", "required_group": "admin"},
            }
        )
    )

    with caplog.at_level("ERROR"):
        found = discover_plugins(tmp_path / "services")

    assert found == []
    assert any("typo" in record.message for record in caplog.records)
    assert any(record.levelname == "ERROR" for record in caplog.records)


def test_discover_skips_an_unreadable_manifest_but_keeps_other_plugins(
    tmp_path, caplog, monkeypatch
) -> None:
    """``_load_manifest_tolerant``'s ``except OSError`` branch (biffo-template
    #1517's error-branch coverage gate flagged it unexecuted).

    A manifest that exists but cannot be *read* — permissions, a transient
    filesystem error — must not raise out of ``discover_plugins`` and must
    not silently vanish either: the one plugin is skipped, loudly, and every
    other plugin in the same directory is still discovered. That last part is
    the one this test makes explicit rather than implied — it is the same
    shape of assertion that would have caught the pre-existing bug where one
    broken manifest silently discarded an unrelated, valid surface.
    """
    root = tmp_path / "services"
    root.mkdir()
    _write_plugin(root, "good", ingress={"app": "good.app:app", "required_group": "founder"})
    bad_dir = root / "unreadable"
    bad_dir.mkdir()
    bad_manifest = bad_dir / "biffo.plugin.json"
    bad_manifest.write_text(json.dumps({"name": "unreadable", "version": "1.0.0"}))

    real_read_text = Path.read_text

    def flaky_read_text(self, *args, **kwargs):
        if self == bad_manifest:
            raise OSError("simulated permission denied")
        return real_read_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", flaky_read_text)

    with caplog.at_level("ERROR"):
        found = discover_plugins(root)

    assert [p.name for p in found] == ["good"]
    assert any("unreadable" in record.message for record in caplog.records)
    assert any(record.levelname == "ERROR" for record in caplog.records)


def test_discover_skips_invalid_json_but_keeps_other_plugins(tmp_path, caplog) -> None:
    """``_load_manifest_tolerant``'s ``except json.JSONDecodeError`` branch
    (biffo-template#1517's error-branch coverage gate flagged it unexecuted).

    A manifest that is not valid JSON at all — the one raw-parsing failure
    mode discovery always had to handle, even before this PR — must not raise
    out of ``discover_plugins``, must be skipped loudly, and must not take an
    unrelated, valid plugin in the same directory down with it.
    """
    root = tmp_path / "services"
    root.mkdir()
    _write_plugin(root, "good", ingress={"app": "good.app:app", "required_group": "founder"})
    bad_dir = root / "badjson"
    bad_dir.mkdir()
    (bad_dir / "biffo.plugin.json").write_text("{not valid json")

    with caplog.at_level("ERROR"):
        found = discover_plugins(root)

    assert [p.name for p in found] == ["good"]
    assert any("badjson" in record.message for record in caplog.records)
    assert any(record.levelname == "ERROR" for record in caplog.records)
