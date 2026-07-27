"""The host forwarding manifest-declared api_routes to Core (#652).

A plugin's ``api_routes`` are generated and served by Core, not by the plugin's
own app. Core's public mount for them is unaddressable (API Gateway sends all of
/api/v1/plugins/* to this host), so the host recognises a declared route and
forwards it to Core's IAM-reachable internal mount instead.

The assertions that matter:

- only *declared* routes are intercepted; everything else still reaches the
  plugin's own app behind its group gate, untouched;
- the caller's own token is forwarded so Core authorises the **user**, and a
  request without one is refused here rather than forwarded unaccompanied;
- the forwarder sits outside the group gate on purpose, so an admin can reach an
  admin-gated table on a plugin whose user group is `founder` — the case #652
  was reported for.
"""

import json

import pytest
from plugin_host.discover import DeclaredRoute
from plugin_host.forward import DeclaredRouteForwarder, forwarding_gate
from plugin_host.mount import MountedPlugin, build_host
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient

_ROUTES = (
    DeclaredRoute(method="GET", path="/model-catalog"),
    DeclaredRoute(method="POST", path="/model-catalog"),
    DeclaredRoute(method="GET", path="/model-catalog/{id}"),
)


class FakeCore:
    """Stands in for the SigV4 call to Core, recording what it was asked to do."""

    def __init__(self, status: int = 200, payload: object = None):
        self.calls: list[dict] = []
        self._status = status
        self._payload = [] if payload is None else payload

    async def __call__(self, *, method, path, body, user_token):
        self.calls.append({"method": method, "path": path, "body": body, "user_token": user_token})
        return self._status, json.dumps(self._payload).encode(), "application/json"


def _plugin_app() -> Starlette:
    async def sessions(request):
        return JSONResponse({"served_by": "plugin"})

    async def catch_all(request):
        return JSONResponse({"served_by": "plugin", "path": request.url.path}, status_code=404)

    return Starlette(routes=[Route("/sessions", sessions), Route("/{rest:path}", catch_all)])


def _client(core: FakeCore) -> TestClient:
    app = forwarding_gate(
        _plugin_app(),
        DeclaredRouteForwarder("ideation", _ROUTES, send_to_core=core),
        token_of=lambda headers: {k.decode().lower(): v.decode() for k, v in headers}.get(
            "x-biffo-user", ""
        ),
    )
    return TestClient(app)


def test_a_declared_route_is_forwarded_to_cores_internal_mount():
    core = FakeCore(payload=[{"id": "1"}])
    resp = _client(core).get("/model-catalog", headers={"x-biffo-user": "tok"})

    assert resp.status_code == 200
    assert resp.json() == [{"id": "1"}]
    assert core.calls[0]["path"] == "/api/v1/internal/plugins/ideation/model-catalog"
    assert core.calls[0]["method"] == "GET"


def test_the_callers_own_token_is_forwarded_so_core_authorises_the_user():
    core = FakeCore()
    _client(core).get("/model-catalog", headers={"x-biffo-user": "the-users-token"})
    assert core.calls[0]["user_token"] == "the-users-token"


def test_a_path_parameter_route_is_matched():
    core = FakeCore(payload={"id": "abc"})
    resp = _client(core).get("/model-catalog/abc", headers={"x-biffo-user": "tok"})
    assert resp.status_code == 200
    assert core.calls[0]["path"] == "/api/v1/internal/plugins/ideation/model-catalog/abc"


def test_a_path_parameter_matches_one_segment_only():
    """`/model-catalog/{id}` must not swallow `/model-catalog/a/b`."""
    core = FakeCore()
    resp = _client(core).get("/model-catalog/a/b", headers={"x-biffo-user": "tok"})
    assert core.calls == []  # not forwarded
    assert resp.json()["served_by"] == "plugin"


def test_an_undeclared_path_still_reaches_the_plugins_own_app():
    core = FakeCore()
    resp = _client(core).get("/sessions", headers={"x-biffo-user": "tok"})
    assert resp.status_code == 200
    assert resp.json() == {"served_by": "plugin"}
    assert core.calls == []


def test_a_declared_path_with_an_undeclared_method_is_not_forwarded():
    """DELETE /model-catalog is not declared; only GET and POST are."""
    core = FakeCore()
    _client(core).delete("/model-catalog", headers={"x-biffo-user": "tok"})
    assert core.calls == []


def test_a_request_with_no_user_token_is_refused_not_forwarded():
    """Core cannot authorise without a user, and a signed call carrying no user
    must never be sent — that would be the host acting on its own authority."""
    core = FakeCore()
    resp = _client(core).get("/model-catalog")

    assert resp.status_code == 401
    assert core.calls == []


def test_cores_status_is_passed_through_not_flattened():
    """A 403 from Core's permission check must reach the caller as a 403 — the
    whole point of #652/#647 is that failures stop being disguised."""
    core = FakeCore(status=403, payload={"detail": "no"})
    resp = _client(core).get("/model-catalog", headers={"x-biffo-user": "tok"})
    assert resp.status_code == 403


def test_an_upstream_failure_is_a_502_not_a_stack_trace():
    class Boom:
        async def __call__(self, **kwargs):
            raise RuntimeError("connection reset")

    app = forwarding_gate(
        _plugin_app(),
        DeclaredRouteForwarder("ideation", _ROUTES, send_to_core=Boom()),
        token_of=lambda headers: "tok",
    )
    resp = TestClient(app).get("/model-catalog")
    assert resp.status_code == 502
    assert "detail" in resp.json()


# ── composition: the forwarder sits outside the group gate ──────────────────────


def _deny_founder(token: str, required_group: str):
    """An authorizer that refuses everyone — standing in for a caller who is an
    admin but not a founder."""
    from plugin_host.mount import GateError

    raise GateError(403, f"not in {required_group}")


def test_a_declared_route_bypasses_the_plugins_user_group_gate():
    """The reported case: the admin UI calls a founder-gated plugin's declared
    route. Authorisation for it is the table's own permissions in Core, so the
    founder gate must not refuse it first."""
    core = FakeCore(payload=[])
    host = build_host(
        [
            MountedPlugin(
                name="ideation",
                app=_plugin_app(),
                required_group="founder",
                api_routes=_ROUTES,
            )
        ],
        authorize=_deny_founder,
        send_to_core=core,
    )

    resp = TestClient(host).get(
        "/ideation/model-catalog", headers={"authorization": "Bearer admin-token"}
    )

    assert resp.status_code == 200, resp.text
    assert core.calls[0]["user_token"] == "admin-token"


def test_the_plugins_own_routes_still_hit_the_gate():
    """Containment: only declared routes skip the gate."""
    core = FakeCore()
    host = build_host(
        [
            MountedPlugin(
                name="ideation",
                app=_plugin_app(),
                required_group="founder",
                api_routes=_ROUTES,
            )
        ],
        authorize=_deny_founder,
        send_to_core=core,
    )

    resp = TestClient(host).get(
        "/ideation/sessions", headers={"authorization": "Bearer admin-token"}
    )

    assert resp.status_code == 403
    assert core.calls == []


def test_a_plugin_declaring_no_api_routes_is_untouched():
    core = FakeCore()
    host = build_host(
        [MountedPlugin(name="plain", app=_plugin_app(), required_group="founder")],
        authorize=lambda token, group: {"sub": "u"},
        send_to_core=core,
    )
    resp = TestClient(host).get("/plain/sessions", headers={"authorization": "Bearer t"})
    assert resp.status_code == 200
    assert core.calls == []


@pytest.mark.parametrize(
    "declared,candidate,expected",
    [
        ("/model-catalog", "/model-catalog", True),
        ("/model-catalog", "/model-catalogue", False),
        ("/model-catalog", "/x/model-catalog", False),
        ("/a/{id}", "/a/1", True),
        ("/a/{id}", "/a/", False),
    ],
)
def test_path_matching_is_exact(declared, candidate, expected):
    fwd = DeclaredRouteForwarder(
        "p", (DeclaredRoute(method="GET", path=declared),), send_to_core=FakeCore()
    )
    assert fwd.matches("GET", candidate) is expected


# ── the production wiring (#652): sender construction and signing ───────────────


def test_no_core_url_disables_forwarding_rather_than_failing():
    """A deployment without BIFFO_CORE_API_URL keeps working exactly as before,
    instead of breaking every plugin request at import."""
    from plugin_host.app import core_sender

    assert core_sender("") is None


def test_the_forwarded_user_token_is_covered_by_the_signature():
    """The header Core authenticates the user on must be signed, not appended to
    an already-signed request — otherwise it can be altered in transit."""
    import asyncio

    from biffo_plugin_sdk import SignedCoreClient

    signed: dict = {}

    class FakeHttp:
        async def request(self, method, url, headers=None, content=None):
            signed["headers"] = headers

            class R:
                status_code = 200
                content = b"[]"
                headers = {"content-type": "application/json"}

            return R()

    client = SignedCoreClient(
        base_url="https://core.example",
        region="eu-west-1",
        credentials=_FakeCreds(),
        client=FakeHttp(),
    )

    status, body, ctype = asyncio.run(
        client.raw_request(
            "GET",
            "/api/v1/internal/plugins/ideation/model-catalog",
            extra_signed_headers={"X-Biffo-User-Token": "the-token"},
        )
    )

    assert (status, body, ctype) == (200, b"[]", "application/json")
    # present...
    assert signed["headers"]["X-Biffo-User-Token"] == "the-token"
    # ...and named in the SigV4 SignedHeaders list, i.e. actually signed.
    assert "x-biffo-user-token" in signed["headers"]["Authorization"].lower()


def test_raw_request_does_not_raise_on_a_non_2xx():
    """Pass-through semantics: a 403 is data, not an exception."""
    import asyncio

    from biffo_plugin_sdk import SignedCoreClient

    class FakeHttp:
        async def request(self, method, url, headers=None, content=None):
            class R:
                status_code = 403
                content = b'{"detail":"nope"}'
                headers = {"content-type": "application/json"}

            return R()

    client = SignedCoreClient(
        base_url="https://core.example",
        region="eu-west-1",
        credentials=_FakeCreds(),
        client=FakeHttp(),
    )
    status, body, _ = asyncio.run(client.raw_request("GET", "/x"))
    assert status == 403
    assert b"nope" in body


class _FakeCreds:
    access_key = "AKIAIOSFODNN7EXAMPLE"
    secret_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
    token = None

    def get_frozen_credentials(self):
        return self
