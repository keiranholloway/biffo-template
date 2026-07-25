"""The shared plugin host's mounting + group-gating core (ADR-0021 §1/§1a)."""

from __future__ import annotations

from plugin_host.mount import GateError, MountedPlugin, build_host, current_plugin
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient


def _plugin_app(name: str) -> Starlette:
    """A fake plugin that echoes back the path it saw and the bound plugin identity."""

    async def ping(request):
        return JSONResponse({"name": name, "identity": current_plugin.get()})

    return Starlette(routes=[Route("/ping", ping)])


def _authorizer(token: str, required_group: str):
    # Test token shape: "<sub>|<comma-groups>", e.g. "alice|founder,editor".
    if not token:
        raise GateError(401, "No bearer token.")
    groups = token.split("|", 1)[1].split(",") if "|" in token else []
    if required_group not in groups:
        raise GateError(403, f"Requires group '{required_group}'.")
    return {"sub": token.split("|", 1)[0]}


def _host(*plugins: MountedPlugin) -> TestClient:
    return TestClient(build_host(list(plugins), authorize=_authorizer))


def test_gated_request_reaches_the_plugin_with_stripped_path_and_bound_identity():
    client = _host(MountedPlugin("ideation", _plugin_app("ideation"), "founder"))
    r = client.get("/ideation/ping", headers={"X-Biffo-Founder-Token": "alice|founder"})
    assert r.status_code == 200
    body = r.json()
    # The plugin declares only Route("/ping"); a 200 from it proves Mount stripped
    # the /ideation prefix for routing (else the plugin would 404), so a plugin needs
    # no knowledge of where it is mounted — no per-plugin base-path hack.
    assert body["name"] == "ideation"
    # the plugin's identity is bound for the duration of its request (§1a)
    assert body["identity"] == "ideation"


def test_no_token_is_json_401_not_html():
    client = _host(MountedPlugin("ideation", _plugin_app("ideation"), "founder"))
    r = client.get("/ideation/ping")
    assert r.status_code == 401
    assert r.headers["content-type"] == "application/json"  # never the SPA's HTML
    assert r.json() == {"detail": "No bearer token."}


def test_wrong_group_is_json_403():
    client = _host(MountedPlugin("ideation", _plugin_app("ideation"), "founder"))
    r = client.get("/ideation/ping", headers={"X-Biffo-Founder-Token": "bob|viewer"})
    assert r.status_code == 403
    assert r.headers["content-type"] == "application/json"
    assert "founder" in r.json()["detail"]


def test_authorization_bearer_fallback_is_accepted():
    client = _host(MountedPlugin("ideation", _plugin_app("ideation"), "founder"))
    r = client.get("/ideation/ping", headers={"Authorization": "Bearer alice|founder"})
    assert r.status_code == 200


def test_each_plugin_routes_and_binds_its_own_identity():
    client = _host(
        MountedPlugin("ideation", _plugin_app("ideation"), "founder"),
        MountedPlugin("crm", _plugin_app("crm"), "editor"),
    )
    a = client.get("/ideation/ping", headers={"X-Biffo-Founder-Token": "u|founder"}).json()
    b = client.get("/crm/ping", headers={"X-Biffo-Founder-Token": "u|editor"}).json()
    assert a["name"] == a["identity"] == "ideation"
    assert b["name"] == b["identity"] == "crm"
    # a founder-only caller can't reach the editor plugin
    assert (
        client.get("/crm/ping", headers={"X-Biffo-Founder-Token": "u|founder"}).status_code == 403
    )


def test_identity_is_unset_outside_a_request():
    _host(MountedPlugin("ideation", _plugin_app("ideation"), "founder"))
    assert current_plugin.get() is None


def test_gated_request_binds_the_sdk_acting_as_plugin_for_outbound_core_calls():
    """The SDK's acting_as_plugin ContextVar (read by SignedCoreClient to stamp the
    X-Biffo-Plugin identity header, ADR-0021 §1a) is bound to the plugin name inside
    a gated request, and unset outside it."""
    from biffo_plugin_sdk import acting_as_plugin
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    async def whoami(request):
        return JSONResponse({"acting_as": acting_as_plugin.get()})

    app = Starlette(routes=[Route("/whoami", whoami)])
    client = TestClient(build_host([MountedPlugin("ideation", app, "founder")], authorize=_authorizer))

    resp = client.get("/ideation/whoami", headers={"x-biffo-founder-token": "alice|founder"})
    assert resp.status_code == 200
    assert resp.json()["acting_as"] == "ideation"
    assert acting_as_plugin.get() is None  # reset after the request
