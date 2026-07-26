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
    client = TestClient(
        build_host([MountedPlugin("ideation", app, "founder")], authorize=_authorizer)
    )

    resp = client.get("/ideation/whoami", headers={"x-biffo-founder-token": "alice|founder"})
    assert resp.status_code == 200
    assert resp.json()["acting_as"] == "ideation"
    assert acting_as_plugin.get() is None  # reset after the request


# --- ADR-0021 §1a: known boundary, not a bug -----------------------------------
#
# Pinned per issue #563. This is DELIBERATE DOCUMENTATION of a known, accepted
# limit on what `group_gate`'s identity binding protects — not a regression this
# test is trying to catch, and not something a future PR should "fix" by making
# this test pass differently. If this test starts failing, the limitation it
# pins has changed and ADR-0021 §1a needs re-reading before touching anything.
#
# `group_gate` binds `acting_as_plugin` to the MOUNTED plugin's own name before
# dispatching into its app (proven by the two tests above). But that binding is
# an ordinary, mutable `ContextVar` — readable and writable by any code sharing
# the host process, including the plugin's own request handler. A plugin's own
# code can call `acting_as_plugin.set(<other name>)` itself, before making its
# own outbound `SignedCoreClient` call, and the signed request will assert
# whichever identity was set LAST — not the one `group_gate` bound for this
# mount.
#
# This is not closable by hardening the SDK's convenience wrapper (a closure, a
# private per-request client, hiding the ContextVar, etc.): any code running in
# this same process already has the host's IAM credentials via the standard AWS
# SDK credential chain (`botocore.session.get_session().get_credentials()` —
# exactly what `SignedCoreClient._get_credentials()` calls) and could
# hand-construct its own SigV4-signed request naming any plugin identity, with
# or without this ContextVar existing at all. Genuine isolation against a
# plugin an operator does not fully trust requires `isolated: true` (its own
# Lambda, its own IAM role). Per-plugin STS-scoped credentials were considered
# and DELIBERATELY NOT adopted: #579 ratified the shared host as a trust-based
# boundary (ADR-0021 amendment 2026-07-26) — it runs only plugins the operator
# trusts to the same degree, and `isolated: true` (tracked in #595) is the escape
# hatch for anything else. So this property is accepted by policy, not a bug
# awaiting a fix; the test pins it so the accepted boundary stays visible.
def test_a_plugins_own_code_can_override_the_bound_identity_before_its_own_outbound_call():
    """Pin the known (not fixed) boundary: the plugin's own handler overrides
    `acting_as_plugin` after `group_gate` bound it, and its own outbound signed
    request asserts the OVERRIDDEN identity, not the one `group_gate` bound."""
    import httpx
    from biffo_plugin_sdk import PLUGIN_IDENTITY_HEADER, SignedCoreClient, acting_as_plugin
    from botocore.credentials import Credentials

    captured: dict[str, object] = {}

    def handle_outbound(request: httpx.Request) -> httpx.Response:
        captured["plugin_header"] = request.headers.get(PLUGIN_IDENTITY_HEADER)
        return httpx.Response(200, json={})

    async def act(request):
        # This runs as the "ideation" plugin's OWN mounted code — not the host,
        # not group_gate. group_gate already bound acting_as_plugin to
        # "ideation" for this request; this handler overrides it itself, as
        # nothing in-process stops it.
        acting_as_plugin.set("other-plugin-name")
        client = SignedCoreClient(
            base_url="https://core.example.com",
            region="eu-west-1",
            credentials=Credentials("AKIDTEST", "SECRETTEST"),
            client=httpx.AsyncClient(transport=httpx.MockTransport(handle_outbound)),
        )
        await client.post("/api/v1/internal/owner-data/other_plugin_table", json={"x": 1})
        return JSONResponse({"ok": True})

    app = Starlette(routes=[Route("/act", act, methods=["POST"])])
    client = TestClient(
        build_host([MountedPlugin("ideation", app, "founder")], authorize=_authorizer)
    )

    resp = client.post("/ideation/act", headers={"X-Biffo-Founder-Token": "alice|founder"})

    assert resp.status_code == 200
    # The signed outbound request asserts "other-plugin-name" — the identity the
    # plugin's own code chose — not "ideation", the identity group_gate bound.
    # This is the accepted, tested property (issue #563; ratified by #579 as a
    # trust-based boundary), not a bug awaiting a fix.
    assert captured["plugin_header"] == "other-plugin-name"


def test_admin_app_mount_is_accessible_and_gated_independently():
    """A plugin with an admin app is reachable at /<name>/admin/<path>, gated by
    its own admin_required_group independently of the user-facing required_group."""
    client = _host(
        MountedPlugin(
            "ideation",
            _plugin_app("ideation"),
            "founder",
            admin_app=_plugin_app("ideation-admin"),
            admin_required_group="admin",
        )
    )
    # User-facing route works with founder token
    r = client.get("/ideation/ping", headers={"X-Biffo-Founder-Token": "alice|founder"})
    assert r.status_code == 200

    # Admin route works with admin token
    r = client.get("/ideation/admin/ping", headers={"X-Biffo-Founder-Token": "bob|admin"})
    assert r.status_code == 200
    body = r.json()
    assert body["identity"] == "ideation"  # plugin identity stays the same

    # User-facing route fails with admin-only token (wrong group)
    r = client.get("/ideation/ping", headers={"X-Biffo-Founder-Token": "bob|admin"})
    assert r.status_code == 403

    # Admin route fails with founder-only token (wrong group)
    r = client.get("/ideation/admin/ping", headers={"X-Biffo-Founder-Token": "alice|founder"})
    assert r.status_code == 403


def _admin_app_with_static_shell(name: str) -> Starlette:
    """A fake admin app with one gated API route plus a root/assets static shell,
    mirroring ideation's admin_app.py (a JSON API + a StaticFiles(html=True)
    mount at "/")."""

    async def api(request):
        return JSONResponse({"name": name, "identity": current_plugin.get()})

    async def shell(request):
        return JSONResponse({"shell": True, "path": request.url.path})

    from starlette.routing import Route as _Route

    return Starlette(
        routes=[
            _Route("/agents", api),
            # Registered after the real API route, matching how the real
            # admin_app.py mounts StaticFiles last — Starlette checks routes in
            # order, so /agents still matches its own route first.
            _Route("/{path:path}", shell),
        ]
    )


def test_admin_static_shell_paths_bypass_the_gate_without_a_token():
    """The admin mount's root and /assets/* — the built UI shell (biffo-template#627)
    — are reachable with NO token at all, since the API Gateway route in front of
    this Lambda must independently allow them through unauthenticated (a plain
    browser navigation can never attach a custom Authorization header)."""
    client = _host(
        MountedPlugin(
            "ideation",
            _plugin_app("ideation"),
            "founder",
            admin_app=_admin_app_with_static_shell("ideation"),
            admin_required_group="admin",
        )
    )
    r = client.get("/ideation/admin/", follow_redirects=False)
    assert r.status_code == 200
    assert r.json()["shell"] is True

    r = client.get("/ideation/admin/assets/index-abc123.js")
    assert r.status_code == 200
    assert r.json()["shell"] is True


def test_bare_admin_path_with_no_trailing_slash_reaches_the_admin_shell_not_founder():
    """Regression pin: a request for the EXACT bare "/ideation/admin" (no
    trailing slash, nothing after) must resolve to the admin app's public
    shell — not silently fall through to the founder-facing mount and get
    gated with the wrong (founder) group. Starlette's Mount compiles a regex
    requiring a trailing slash, so without the bare-path normalization this
    request used to match "/ideation" (the founder mount) instead, since
    "/ideation/admin" also starts with "/ideation/". This is the exact shape
    of the API Gateway route that's actually reachable unauthenticated
    (AWS rejects a route_key ending in a bare "/" — biffo-template#631), so it
    must resolve correctly with no token at all."""
    client = _host(
        MountedPlugin(
            "ideation",
            _plugin_app("ideation"),
            "founder",
            admin_app=_admin_app_with_static_shell("ideation"),
            admin_required_group="admin",
        )
    )
    r = client.get("/ideation/admin", follow_redirects=False)
    assert r.status_code == 200
    assert r.json()["shell"] is True


def test_admin_api_paths_still_require_a_token_even_alongside_a_public_shell():
    """Only the shell paths are exempted — the actual JSON API stays gated."""
    client = _host(
        MountedPlugin(
            "ideation",
            _plugin_app("ideation"),
            "founder",
            admin_app=_admin_app_with_static_shell("ideation"),
            admin_required_group="admin",
        )
    )
    r = client.get("/ideation/admin/agents")
    assert r.status_code == 401

    r = client.get("/ideation/admin/agents", headers={"X-Biffo-Founder-Token": "bob|admin"})
    assert r.status_code == 200
    assert r.json()["identity"] == "ideation"


def test_user_facing_mount_is_not_given_the_public_shell_exemption():
    """The exemption is scoped to the admin mount only — a founder-facing plugin
    with a route literally at "/" stays fully gated."""

    async def root(request):
        return JSONResponse({"ok": True})

    from starlette.routing import Route as _Route

    app = Starlette(routes=[_Route("/", root)])
    client = _host(MountedPlugin("ideation", app, "founder"))

    r = client.get("/ideation/")
    assert r.status_code == 401


def test_plugin_without_admin_app_has_no_admin_route():
    """A plugin without an admin_app (admin_app=None) has no /<name>/admin route."""
    client = _host(MountedPlugin("ideation", _plugin_app("ideation"), "founder"))
    # User-facing route works
    r = client.get("/ideation/ping", headers={"X-Biffo-Founder-Token": "alice|founder"})
    assert r.status_code == 200

    # Admin route does not exist (404, not auth failure)
    r = client.get("/ideation/admin/ping", headers={"X-Biffo-Founder-Token": "alice|founder"})
    assert r.status_code == 404
