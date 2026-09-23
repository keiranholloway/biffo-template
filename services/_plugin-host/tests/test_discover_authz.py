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


def test_build_plugin_host_isolates_one_plugins_broken_app_import(tmp_path, caplog) -> None:
    """One plugin's ``load(app_ref)`` raising must not raise out of
    ``build_plugin_host`` and must not affect any other plugin sharing the host
    (biffo-template#2092).

    Reproduced live on biffo-platform dev 2026-09-23: the vendored ideation
    plugin's manifest.py raised ``FileNotFoundError`` at import. Before this
    fix, ``build_plugin_host``'s list comprehension called ``load()`` for every
    plugin inline with no per-plugin isolation, so that one exception
    propagated all the way out — ``app.py``'s ``handler()`` never got to assign
    ``_handler``, and every plugin behind the shared host 500'd on every
    request, not just the broken one.
    """
    _write_plugin(
        tmp_path, "broken", ingress={"app": "broken.app:app", "required_group": "founder"}
    )
    _write_plugin(
        tmp_path, "healthy", ingress={"app": "healthy.app:app", "required_group": "founder"}
    )

    async def ping(request):
        return JSONResponse({"ok": True})

    healthy_app = Starlette(routes=[Route("/ping", ping)])

    def flaky_load(ref: str):
        if ref == "broken.app:app":
            raise FileNotFoundError("manifest.py assumed a path that doesn't exist")
        if ref == "healthy.app:app":
            return healthy_app
        raise AssertionError(f"unexpected app ref {ref!r}")

    def fake_authorize(token, required_group):
        if token != "ok":
            raise GateError(401, "nope")
        return {"sub": "u"}

    # Must not raise, despite "broken"'s load() raising.
    with caplog.at_level("ERROR"):
        host = build_plugin_host(tmp_path, authorize=fake_authorize, load=flaky_load)
    client = TestClient(host)

    # The healthy plugin's routes work exactly as if "broken" didn't exist...
    r = client.get("/healthy/ping", headers={"X-Biffo-Founder-Token": "ok"})
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    # ...while the broken plugin was simply never mounted (no route at all —
    # a 404, not a 500 from a half-built host, and not silently gated as if it
    # existed).
    r = client.get("/broken/ping", headers={"X-Biffo-Founder-Token": "ok"})
    assert r.status_code == 404

    # The failure is logged loudly (plugin name, app_ref, exception) rather
    # than swallowed without a trace.
    messages = [rec.message for rec in caplog.records if rec.name == "plugin_host.app"]
    assert any("broken" in m and "broken.app:app" in m for m in messages)


def test_build_plugin_host_isolates_one_plugins_broken_admin_app_import(tmp_path, caplog) -> None:
    """The same isolation for ``load(admin_app_ref)`` — a distinct call site
    from the user-facing ``app_ref`` load (biffo-template#2092). A plugin whose
    admin app fails to import keeps its user-facing app working, and a second,
    wholly separate plugin is unaffected either way.
    """
    root = tmp_path / "half-broken"
    root.mkdir()
    (root / "biffo.plugin.json").write_text(
        json.dumps(
            {
                "name": "half-broken",
                "version": "1.0.0",
                "user_ingress": {"app": "half_broken.app:app", "required_group": "founder"},
                "admin_ingress": {
                    "app": "half_broken.admin_app:app",
                    "required_group": "admin",
                },
            }
        )
    )
    _write_plugin(
        tmp_path, "healthy", ingress={"app": "healthy.app:app", "required_group": "founder"}
    )

    async def ping(request):
        return JSONResponse({"ok": True})

    user_app = Starlette(routes=[Route("/ping", ping)])
    healthy_app = Starlette(routes=[Route("/ping", ping)])

    def flaky_load(ref: str):
        if ref == "half_broken.app:app":
            return user_app
        if ref == "half_broken.admin_app:app":
            raise ModuleNotFoundError("no module named 'half_broken.admin_app'")
        if ref == "healthy.app:app":
            return healthy_app
        raise AssertionError(f"unexpected app ref {ref!r}")

    def fake_authorize(token, required_group):
        if token != "ok":
            raise GateError(401, "nope")
        return {"sub": "u"}

    with caplog.at_level("ERROR"):
        host = build_plugin_host(tmp_path, authorize=fake_authorize, load=flaky_load)
    client = TestClient(host)

    # half-broken's user-facing app still works...
    r = client.get("/half-broken/ping", headers={"X-Biffo-Founder-Token": "ok"})
    assert r.status_code == 200
    # ...its admin mount was never built (404, not 500)...
    r = client.get("/half-broken/admin/ping", headers={"X-Biffo-Founder-Token": "ok"})
    assert r.status_code == 404
    # ...and an entirely separate plugin is unaffected.
    r = client.get("/healthy/ping", headers={"X-Biffo-Founder-Token": "ok"})
    assert r.status_code == 200

    messages = [rec.message for rec in caplog.records if rec.name == "plugin_host.app"]
    assert any("half-broken" in m and "half_broken.admin_app:app" in m for m in messages)


# --- biffo-template#2095: a failed import must keep the plugin's URL space OWNED ---
#
# #2092's isolation turned a failed import into "no mount". That is not neutral:
# a missing ``/<name>/admin`` mount lets ``/<name>/admin/*`` fall through to the
# founder-gated ``/<name>`` user mount (the trap ``_normalize_bare_admin_paths``
# documents), and a missing ``/<name>`` mount is a bare 404, indistinguishable
# from "plugin not installed". Each test below reproduces one of #2095's three
# defects through the real ``discover_plugins`` + real ``build_host`` +
# a real Starlette ``TestClient``.

_METHODS = ("get", "post", "put", "patch", "delete")


def _group_authorizer(token: str, required_group: str):
    """Token ``founder-tok`` is in group ``founder`` only; ``admin-tok`` in
    ``admin`` only. Anything else is a 401 — so a founder token reaching an
    admin-gated route is a 403, and reaching a founder-gated route is a pass."""
    groups = {"founder-tok": "founder", "admin-tok": "admin"}
    if token not in groups:
        raise GateError(401, "nope")
    if groups[token] != required_group:
        raise GateError(403, "wrong group")
    return {"sub": "u"}


def _write_two_ingress_plugin(root, name) -> None:
    d = root / name
    d.mkdir()
    (d / "biffo.plugin.json").write_text(
        json.dumps(
            {
                "name": name,
                "version": "1.0.0",
                "user_ingress": {"app": f"{name}.app:app", "required_group": "founder"},
                "admin_ingress": {"app": f"{name}.admin:app", "required_group": "admin"},
            }
        )
    )


def _user_app_with_admin_route() -> Starlette:
    """A user app that (plausibly — ``_is_public_admin_asset`` treats
    ``/admin/assets`` as a public shape) serves something under ``/admin/``."""

    async def hi(request):
        return JSONResponse({"who": "userapp"})

    async def admin_hi(request):
        return JSONResponse({"who": "userapp-admin-route-LEAK"})

    return Starlette(routes=[Route("/hi", hi), Route("/admin/hi", admin_hi)])


def _assert_503_naming_only(response, name: str, *, forbidden: str) -> None:
    assert response.status_code == 503, (response.request.method, response.request.url)
    assert response.headers["content-type"] == "application/json"
    detail = response.json()["detail"]
    assert name in detail
    # The exception text is host-log material, never response material
    # (same rule as ``_quarantine``'s "never leak a stack trace").
    assert forbidden not in response.text


def test_failed_admin_import_keeps_admin_path_owned_not_routed_to_user_app(tmp_path) -> None:
    """Defect 1 (auth boundary). ``/<name>/admin/*`` must NOT be served by the
    founder-gated user app when the admin app failed to import."""
    _write_two_ingress_plugin(tmp_path, "halfbad")
    _write_plugin(tmp_path, "goodp", ingress={"app": "goodp.app:app", "required_group": "founder"})
    good = _user_app_with_admin_route()

    def load(ref: str):
        if ref == "halfbad.app:app":
            return _user_app_with_admin_route()
        if ref == "halfbad.admin:app":
            raise ImportError("SECRET-/srv/plugins/halfbad/admin.py exploded")
        if ref == "goodp.app:app":
            return good
        raise AssertionError(ref)

    host = build_plugin_host(tmp_path, authorize=_group_authorizer, load=load)
    client = TestClient(host)
    founder = {"X-Biffo-Founder-Token": "founder-tok"}
    admin = {"X-Biffo-Founder-Token": "admin-tok"}

    # The founder token used to reach the user app's /admin/hi route (200 LEAK).
    for headers in (founder, admin, {}):
        for method in _METHODS:
            for path in ("/halfbad/admin/hi", "/halfbad/admin/", "/halfbad/admin/x/y"):
                r = getattr(client, method)(path, headers=headers)
                _assert_503_naming_only(r, "halfbad/admin", forbidden="SECRET")
    # The bare, no-slash form (the only unauthenticated one at the Gateway).
    _assert_503_naming_only(
        client.get("/halfbad/admin", headers=founder), "halfbad/admin", forbidden="SECRET"
    )

    # Only the failed ADMIN surface is down: the user app and other plugins are fine.
    assert client.get("/halfbad/hi", headers=founder).json() == {"who": "userapp"}
    assert client.get("/goodp/hi", headers=founder).status_code == 200
    assert client.get("/goodp/admin/hi", headers=founder).json()["who"].endswith("LEAK")


def test_failed_user_app_import_answers_503_for_that_plugin_only(tmp_path) -> None:
    """Defect 2. #2092 asked for a 503 for the broken plugin's own routes; a
    bare 404 is indistinguishable from "plugin not installed"."""
    _write_plugin(
        tmp_path, "badfnf", ingress={"app": "badfnf.app:app", "required_group": "founder"}
    )
    _write_plugin(
        tmp_path, "healthy", ingress={"app": "healthy.app:app", "required_group": "founder"}
    )
    healthy = _user_app_with_admin_route()

    def load(ref: str):
        if ref == "badfnf.app:app":
            raise FileNotFoundError("SECRET-/srv/plugins/badfnf/manifest.json")
        if ref == "healthy.app:app":
            return healthy
        raise AssertionError(ref)

    host = build_plugin_host(tmp_path, authorize=_group_authorizer, load=load)
    client = TestClient(host)

    for headers in ({"X-Biffo-Founder-Token": "founder-tok"}, {"X-Biffo-Founder-Token": "bad"}, {}):
        for method in _METHODS:
            for path in ("/badfnf/hi", "/badfnf/", "/badfnf/a/b/c"):
                r = getattr(client, method)(path, headers=headers)
                _assert_503_naming_only(r, "badfnf", forbidden="SECRET")

    assert (
        client.get("/healthy/hi", headers={"X-Biffo-Founder-Token": "founder-tok"}).status_code
        == 200
    )
    # A path no plugin owns is still a plain 404 — 503 is for the failed plugin only.
    assert (
        client.get("/nosuchplugin/hi", headers={"X-Biffo-Founder-Token": "founder-tok"}).status_code
        == 404
    )


def test_failed_user_app_import_keeps_a_working_admin_app(tmp_path) -> None:
    """The user app and admin app fail independently: a broken user app must
    not take down a working admin app mounted ahead of it."""
    _write_two_ingress_plugin(tmp_path, "splitp")

    async def ping(request):
        return JSONResponse({"who": "admin"})

    admin_app = Starlette(routes=[Route("/ping", ping)])

    def load(ref: str):
        if ref == "splitp.app:app":
            raise ImportError("user side broken")
        if ref == "splitp.admin:app":
            return admin_app
        raise AssertionError(ref)

    client = TestClient(build_plugin_host(tmp_path, authorize=_group_authorizer, load=load))
    assert client.get(
        "/splitp/admin/ping", headers={"X-Biffo-Founder-Token": "admin-tok"}
    ).json() == {"who": "admin"}
    assert (
        client.get("/splitp/ping", headers={"X-Biffo-Founder-Token": "founder-tok"}).status_code
        == 503
    )


def test_system_exit_at_import_is_isolated_like_any_other_import_failure(tmp_path) -> None:
    """Defect 3. ``sys.exit()`` at module import (some config-check patterns do
    this) raises ``SystemExit`` — a ``BaseException`` — which an
    ``except Exception`` isolation lets straight through and out of
    ``build_plugin_host``, taking every plugin down."""
    _write_two_ingress_plugin(tmp_path, "exiter")
    _write_plugin(
        tmp_path, "exiter2", ingress={"app": "exiter2.app:app", "required_group": "founder"}
    )
    _write_plugin(
        tmp_path, "healthy", ingress={"app": "healthy.app:app", "required_group": "founder"}
    )
    healthy = _user_app_with_admin_route()

    def load(ref: str):
        if ref in ("exiter.app:app", "exiter.admin:app", "exiter2.app:app"):
            raise SystemExit(3)
        if ref == "healthy.app:app":
            return healthy
        raise AssertionError(ref)

    # Must not raise SystemExit.
    client = TestClient(build_plugin_host(tmp_path, authorize=_group_authorizer, load=load))
    founder = {"X-Biffo-Founder-Token": "founder-tok"}
    assert client.get("/exiter/hi", headers=founder).status_code == 503
    assert client.get("/exiter/admin/hi", headers=founder).status_code == 503
    assert client.get("/exiter2/hi", headers=founder).status_code == 503
    assert client.get("/healthy/hi", headers=founder).status_code == 200


def test_keyboard_interrupt_at_import_is_not_swallowed(tmp_path) -> None:
    """Isolation catches a plugin's *own* failure modes (``Exception``,
    ``SystemExit``) — never the operator's interrupt."""
    _write_plugin(tmp_path, "kb", ingress={"app": "kb.app:app", "required_group": "founder"})

    def load(ref: str):
        raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        build_plugin_host(tmp_path, authorize=_group_authorizer, load=load)


def test_failed_plugin_websocket_is_refused_not_routed_elsewhere(tmp_path) -> None:
    """A websocket upgrade to a failed plugin's URL space is refused too."""
    from starlette.websockets import WebSocketDisconnect

    _write_two_ingress_plugin(tmp_path, "wsbad")

    def load(ref: str):
        raise ImportError("broken")

    client = TestClient(build_plugin_host(tmp_path, authorize=_group_authorizer, load=load))
    for path in ("/wsbad/socket", "/wsbad/admin/socket"):
        with pytest.raises(WebSocketDisconnect), client.websocket_connect(path):
            pass


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
