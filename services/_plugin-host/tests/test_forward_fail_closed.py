"""The host refuses a declared route whose table rule authorises nobody (#1837).

A plugin's ``api_routes`` are served by Core and authorised by the table's own
ADR-0004 rule (see :mod:`plugin_host.forward`). When that rule expresses **no
authorisation of its own** — ``allowed`` with an empty ``required_role`` *and* an
empty ``permission_code`` — nothing is checked anywhere: the host deliberately
sits outside the plugin's group gate, and Core admits any authenticated caller of
the tenant. Reproduced live against deployed dev: an ``hq-admin`` persona JWT with
no ``cognito:groups`` claim at all read five marketing tables with HTTP 200.

The rule these tests pin (plan ``docs/implementation/0005-declared-route-fail-closed``,
decisions 1-3):

- **fallback applies iff the rule authorises nobody** —
  ``allowed and not required_role and not permission_code``. Both ADR-0004 axes,
  because Core ANDs them: a ``permission_code``-only table HAS expressed
  authorisation, and gating it on the plugin's user group would reject a caller
  who holds the code but is not in the group — the same class of regression as
  rejecting ``admin`` on ``marketing_click``;
- **``allowed: false`` is left alone** — Core answers 404 for it deliberately, and
  the host must not turn that into a 403 that leaks the route's existence;
- **no group to fall back to means forward** — no group is invented; discovery
  logs the case loudly instead.
"""

from __future__ import annotations

import json

from plugin_host.app import build_plugin_host
from plugin_host.discover import DeclaredRoute, discover_plugins
from plugin_host.forward import DeclaredRouteForwarder, forwarding_gate
from plugin_host.mount import GateError
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient


class FakeCore:
    """Stands in for the SigV4 call to Core, recording what it was asked to do.

    ``calls`` is the assertion that matters: a 403 the host produced *after*
    asking Core is not a fix, it is a leak with a nicer status code.
    """

    def __init__(self, status: int = 200, payload: object = None) -> None:
        self.calls: list[dict] = []
        self._status = status
        self._payload = [] if payload is None else payload

    async def __call__(self, *, method, path, body, user_token):
        self.calls.append({"method": method, "path": path, "body": body, "user_token": user_token})
        return self._status, json.dumps(self._payload).encode(), "application/json"


class SpyAuthorizer:
    """The host's real group check, instrumented.

    Admits a caller whose token names one of ``admits``; refuses everyone else
    with the same ``GateError`` shape :func:`plugin_host.authz.cognito_authorizer`
    raises. Every consultation is recorded, so a test can assert the gate was
    **not** consulted — which is the only way to prove the role-gated path is
    untouched rather than merely returning the same status by luck.
    """

    def __init__(self, *admits: str) -> None:
        self.admits = set(admits)
        self.calls: list[tuple[str, str]] = []

    def __call__(self, token: str, required_group: str):
        self.calls.append((token, required_group))
        if required_group in self.admits:
            return {"sub": "u", "groups": [required_group]}
        raise GateError(403, f"This surface requires the '{required_group}' group.")


def _plugin_app() -> Starlette:
    async def sessions(request):
        return JSONResponse({"served_by": "plugin"})

    async def catch_all(request):
        return JSONResponse({"served_by": "plugin", "path": request.url.path}, status_code=404)

    return Starlette(routes=[Route("/sessions", sessions), Route("/{rest:path}", catch_all)])


def _open_rule() -> dict:
    """The live marketing shape: readable by any authenticated caller."""
    return {"allowed": True, "required_role": []}


def _admin_rule() -> dict:
    return {"allowed": True, "required_role": ["admin"]}


def _write_marketing_manifest(root, **overrides) -> None:
    """A manifest mirroring `biffo-plugin-marketing`'s live shape: an open
    list/read on `marketing_campaign`, an admin-only list on `marketing_click`,
    and `user_ingress.required_group: founder`."""
    d = root / "marketing"
    d.mkdir(parents=True)
    manifest = {
        "name": "marketing",
        "version": "1.0.0",
        "user_ingress": {"app": "marketing.app:app", "required_group": "founder"},
        "tables": [
            {
                "name": "marketing_campaign",
                "columns": [{"name": "title", "type": "String(200)"}],
                "permissions": {"list": _open_rule(), "read": _open_rule()},
            },
            {
                "name": "marketing_click",
                "columns": [{"name": "url", "type": "String(200)"}],
                "permissions": {"list": _admin_rule(), "read": _admin_rule()},
            },
        ],
        "api_routes": [
            {
                "method": "GET",
                "path": "/campaigns",
                "table": "marketing_campaign",
                "operation": "list",
            },
            {"method": "GET", "path": "/clicks", "table": "marketing_click", "operation": "list"},
        ],
    }
    manifest.update(overrides)
    (d / "biffo.plugin.json").write_text(json.dumps(manifest))


def _host(tmp_path, core: FakeCore, authorize: SpyAuthorizer):
    """The whole wiring — discovery, mount, forwarder — from a real manifest, so
    a fix that stops at `forward.py` and is never passed the plugin's group is
    still red here."""
    _write_marketing_manifest(tmp_path / "services")
    return build_plugin_host(
        tmp_path / "services",
        authorize=authorize,
        load=lambda ref: _plugin_app(),
        send_to_core=core,
    )


# ── decision 1: the rule authorises nobody → fall back to the plugin's group ────


def test_an_open_declared_route_is_refused_when_the_caller_fails_the_plugin_group(tmp_path):
    """THE fail-first test (#1837 done-condition 1, plan criterion 1).

    `marketing_campaign.list` is `allowed` with an empty `required_role` and no
    `permission_code`, so Core authorises any authenticated caller of the tenant
    and the host, sitting outside the group gate, checks nothing. A caller who has
    not passed the plugin's `founder` group must now be refused **here**, and Core
    must never be asked — asserted on the call log, not on the status alone.
    """
    core = FakeCore(payload=[{"id": "leaked"}])
    authorize = SpyAuthorizer("admin")  # the hq-admin persona: not in `founder`
    client = TestClient(_host(tmp_path, core, authorize))

    resp = client.get("/marketing/campaigns", headers={"authorization": "Bearer hq-admin-token"})

    assert resp.status_code == 403, resp.text
    assert resp.headers["content-type"].startswith("application/json")
    assert "founder" in resp.json()["detail"]
    assert core.calls == []  # never forwarded — no row ever left Core


def test_the_same_open_route_is_forwarded_when_the_caller_passes_the_plugin_group(tmp_path):
    """The fallback denies the right caller, not everyone (plan criterion 5's
    local proxy): a `founder` still reaches the open route."""
    core = FakeCore(payload=[{"id": "1"}])
    authorize = SpyAuthorizer("founder")
    client = TestClient(_host(tmp_path, core, authorize))

    resp = client.get("/marketing/campaigns", headers={"authorization": "Bearer founder-token"})

    assert resp.status_code == 200, resp.text
    assert len(core.calls) == 1
    assert core.calls[0]["path"] == "/api/v1/internal/plugins/marketing/campaigns"
    assert core.calls[0]["user_token"] == "founder-token"


def test_a_role_gated_route_is_forwarded_without_consulting_the_group_gate(tmp_path):
    """The `marketing_click`/`marketing_spend` regression guard (#1837
    done-condition 3, plan criterion 2).

    `marketing_click.list` requires role `admin`, i.e. the table rule HAS
    expressed authorisation, so Core stays the sole authority and the plugin's
    `founder` gate must not be consulted at all. Asserted on the spy: an
    authorizer that happened to admit this caller would return 200 either way,
    so the status alone cannot tell "not gated" from "gated and passed".
    """
    core = FakeCore(payload=[{"id": "1"}])
    authorize = SpyAuthorizer("admin")  # would REFUSE `founder` if consulted
    client = TestClient(_host(tmp_path, core, authorize))

    resp = client.get("/marketing/clicks", headers={"authorization": "Bearer admin-token"})

    assert resp.status_code == 200, resp.text
    assert authorize.calls == []  # the group gate was never asked
    assert len(core.calls) == 1


def test_a_permission_code_only_route_is_not_gated_on_the_plugin_group():
    """Decision 1's second conjunct. `permission_code` is ADR-0004's other axis and
    Core ANDs the two, so a code-gated table HAS expressed authorisation. Gating it
    on the plugin's user group as well would reject a caller who holds the code but
    is not in the group — the same regression as rejecting `admin` above."""
    core = FakeCore()
    authorize = SpyAuthorizer()  # refuses everyone, if it is ever consulted
    route = DeclaredRoute(
        method="GET", path="/spends", allowed=True, permission_code="marketing:read:spend"
    )
    client = _gate_client(route, core, authorize, required_group="founder")

    resp = client.get("/spends", headers={"authorization": "Bearer code-holder"})

    assert resp.status_code == 200, resp.text
    assert authorize.calls == []
    assert len(core.calls) == 1


# ── decision 2: `allowed: false` is left alone ──────────────────────────────────


def test_a_denied_route_is_left_alone_and_still_forwarded():
    """Core answers 404 for a rule that is not `allowed` (deliberate
    indistinguishability). The host must not convert that into a 403 and leak
    the route's existence, so a denied route forwards exactly as today."""
    core = FakeCore(status=404, payload={"detail": "Not Found"})
    authorize = SpyAuthorizer()
    route = DeclaredRoute(method="GET", path="/hidden", allowed=False)
    client = _gate_client(route, core, authorize, required_group="founder")

    resp = client.get("/hidden", headers={"authorization": "Bearer anyone"})

    assert resp.status_code == 404
    assert authorize.calls == []
    assert len(core.calls) == 1


# ── decision 3: no group to fall back to means forward, and log ─────────────────


def test_an_open_route_on_a_plugin_with_no_required_group_is_forwarded():
    """#1837 done-condition 4. No group is invented: a plugin with no
    `user_ingress.required_group` forwards as today. Discovery logs it (below);
    the request is not refused."""
    core = FakeCore(payload=[])
    authorize = SpyAuthorizer()
    route = DeclaredRoute(method="GET", path="/campaigns", allowed=True)
    client = _gate_client(route, core, authorize, required_group=None)

    resp = client.get("/campaigns", headers={"authorization": "Bearer anyone"})

    assert resp.status_code == 200, resp.text
    assert authorize.calls == []
    assert len(core.calls) == 1


def test_discovery_logs_an_open_route_with_no_group_to_fall_back_to(tmp_path, caplog):
    """Decision 3's honest consequence: such a route stays open, so it must not
    stay silent. Logged at ERROR, once per route, naming plugin/table/operation."""
    d = tmp_path / "services" / "openish"
    d.mkdir(parents=True)
    (d / "biffo.plugin.json").write_text(
        json.dumps(
            {
                "name": "openish",
                "version": "1.0.0",
                # admin_ingress only — no user_ingress, so no required_group exists
                "admin_ingress": {"app": "openish.admin:app", "required_group": "admin"},
                "tables": [
                    {
                        "name": "openish_thing",
                        "columns": [{"name": "title", "type": "String(200)"}],
                        "permissions": {"list": _open_rule()},
                    }
                ],
                "api_routes": [
                    {
                        "method": "GET",
                        "path": "/things",
                        "table": "openish_thing",
                        "operation": "list",
                    }
                ],
            }
        )
    )

    with caplog.at_level("ERROR"):
        found = discover_plugins(tmp_path / "services")

    assert [p.name for p in found] == ["openish"]
    assert found[0].required_group is None
    messages = [r.getMessage() for r in caplog.records if r.levelname == "ERROR"]
    assert any("openish" in m and "openish_thing" in m and "list" in m for m in messages), messages


# ── the 401 paths ───────────────────────────────────────────────────────────────


def test_a_request_with_no_token_is_still_refused_before_any_authorization():
    """Unchanged from today, and asserted so the new branch cannot reorder it:
    no token is 401, Core is not called, and the group check is not consulted
    with an empty token."""
    core = FakeCore()
    authorize = SpyAuthorizer("founder")
    route = DeclaredRoute(method="GET", path="/campaigns", allowed=True)
    client = _gate_client(route, core, authorize, required_group="founder")

    resp = client.get("/campaigns")

    assert resp.status_code == 401
    assert core.calls == []
    assert authorize.calls == []


def test_the_authorizers_401_is_answered_as_401_not_flattened_to_403():
    """`cognito_authorizer` raises `GateError(401)` for an invalid/expired token
    and 403 for the wrong group. The host answers the gate's own status."""
    core = FakeCore()

    def expired(token, required_group):
        raise GateError(401, "Token expired")

    route = DeclaredRoute(method="GET", path="/campaigns", allowed=True)
    client = _gate_client(route, core, expired, required_group="founder")

    resp = client.get("/campaigns", headers={"authorization": "Bearer stale"})

    assert resp.status_code == 401
    assert resp.json()["detail"] == "Token expired"
    assert core.calls == []


# ── discovery resolves the table rule onto the route ────────────────────────────


def test_discovery_resolves_each_routes_table_rule_onto_the_declared_route(tmp_path):
    """The facts the forwarder decides on come from the manifest's own `tables`,
    resolved per route's `operation` — not from a new manifest field."""
    _write_marketing_manifest(tmp_path / "services")

    found = discover_plugins(tmp_path / "services")
    by_path = {r.path: r for r in found[0].api_routes}

    assert by_path["/campaigns"].allowed is True
    assert by_path["/campaigns"].required_role == ()
    assert by_path["/campaigns"].permission_code == ""
    assert by_path["/campaigns"].authorises_nobody is True

    assert by_path["/clicks"].required_role == ("admin",)
    assert by_path["/clicks"].authorises_nobody is False


def test_a_bare_declared_route_construction_stays_valid_and_forwards():
    """Backward compatibility, and the reason every existing `test_forward.py`
    case is untouched: `DeclaredRoute(method=..., path=...)` still constructs,
    and defaults to `allowed=False` exactly as `PermissionRule` does — so it is
    decision 2's leave-alone case, never the fallback's."""
    route = DeclaredRoute(method="GET", path="/x")
    assert route.allowed is False
    assert route.authorises_nobody is False


def _gate_client(route: DeclaredRoute, core: FakeCore, authorize, *, required_group: str | None):
    """A `forwarding_gate` over one declared route, wired the way `mount.py` wires
    it — the plugin's group and the host's authorizer passed through."""
    app = forwarding_gate(
        _plugin_app(),
        DeclaredRouteForwarder("marketing", (route,), send_to_core=core),
        token_of=lambda headers: (
            {k.decode().lower(): v.decode() for k, v in headers}.get("authorization", "")
            .removeprefix("Bearer ")
            .strip()
        ),
        required_group=required_group,
        authorize=authorize,
    )
    return TestClient(app)
