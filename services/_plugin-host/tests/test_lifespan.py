"""The shared plugin host runs each mounted plugin's own lifespan startup (#924).

Every test here observes the *plugin's* startup handler firing, not that the host
booted. The bug this file exists for was precisely "host boots fine, plugin startup
never runs" — a test that only asserts the host serves requests is green either way,
which is how the defect shipped.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI
from mangum.types import LambdaCognitoIdentity, LambdaMobileClientContext
from plugin_host.lifespan import PluginLifespans, SubAppLifespan, startup_targets
from plugin_host.mount import GateError, MountedPlugin, build_host
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route
from starlette.testclient import TestClient

FOUNDER = {"X-Biffo-Founder-Token": "alice|founder"}
ADMIN = {"X-Biffo-Founder-Token": "alice|admin"}


def _authorizer(token: str, required_group: str):
    # Same test token shape as test_mount.py: "<sub>|<comma-groups>".
    if not token:
        raise GateError(401, "No bearer token.")
    groups = token.split("|", 1)[1].split(",") if "|" in token else []
    if required_group not in groups:
        raise GateError(403, f"Requires group '{required_group}'.")
    return {"sub": token.split("|", 1)[0]}


def _seeding_plugin(log: list[str], name: str = "ideation", *, fail: bool = False) -> FastAPI:
    """A plugin that self-seeds at startup, exactly as `internal_plugin_config.py`'s
    service-principal seed route is designed to be called (#913)."""

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        if fail:
            raise RuntimeError("could not reach Core to seed")
        log.append(f"{name}:startup")
        yield

    app = FastAPI(lifespan=lifespan)

    @app.get("/ping")
    def ping():
        log.append(f"{name}:request")
        return {"seeded": f"{name}:startup" in log}

    return app


# --------------------------------------------------------------------------------
# The defect itself, pinned: Starlette's Mount does not deliver lifespan.
# --------------------------------------------------------------------------------


def test_starlette_mount_does_not_propagate_lifespan_to_a_sub_app():
    """The upstream behaviour the host has to compensate for.

    Not a test of our code — a guard on the assumption underneath it. If a future
    Starlette starts propagating lifespan into ``Mount``, this fails and tells us the
    host's hand-rolled handshake would double-fire, rather than leaving us to find
    out from duplicated seed rows.
    """
    log: list[str] = []
    bare_mount = Starlette(routes=[Mount("/ideation", app=_seeding_plugin(log))])
    with TestClient(bare_mount) as client:
        assert client.get("/ideation/ping").status_code == 200  # fully reachable...
    assert log == ["ideation:request"]  # ...and its startup never ran


# --------------------------------------------------------------------------------
# The fix, observed through the host.
# --------------------------------------------------------------------------------


def test_mounted_plugin_startup_runs_before_the_first_request_is_served():
    log: list[str] = []
    host = build_host(
        [MountedPlugin("ideation", _seeding_plugin(log), "founder")], authorize=_authorizer
    )
    with TestClient(host) as client:
        r = client.get("/ideation/ping", headers=FOUNDER)
    assert r.status_code == 200
    # Ordering is the point: seeding must have completed, not merely happened.
    assert log == ["ideation:startup", "ideation:request"]
    assert r.json() == {"seeded": True}


def test_every_mounted_plugin_starts_not_just_the_first():
    log: list[str] = []
    host = build_host(
        [
            MountedPlugin("ideation", _seeding_plugin(log, "ideation"), "founder"),
            MountedPlugin("idea-scout", _seeding_plugin(log, "idea-scout"), "founder"),
        ],
        authorize=_authorizer,
    )
    with TestClient(host) as client:
        client.get("/ideation/ping", headers=FOUNDER)
    assert log[:2] == ["ideation:startup", "idea-scout:startup"]


def test_admin_ingress_app_also_gets_its_startup_run():
    log: list[str] = []
    host = build_host(
        [
            MountedPlugin(
                "ideation",
                _seeding_plugin(log, "user"),
                "founder",
                admin_app=_seeding_plugin(log, "admin"),
                admin_required_group="admin",
            )
        ],
        authorize=_authorizer,
    )
    with TestClient(host) as client:
        assert client.get("/ideation/admin/ping", headers=ADMIN).json() == {"seeded": True}
    assert sorted(e for e in log if e.endswith(":startup")) == ["admin:startup", "user:startup"]


def test_an_app_mounted_as_both_user_and_admin_ingress_starts_once():
    """A plugin may name the same app object in both ingresses. Startup must not
    double-fire — a seeder that runs twice is exactly what a duplicate-row bug
    looks like."""
    log: list[str] = []
    shared = _seeding_plugin(log, "shared")
    host = build_host(
        [
            MountedPlugin(
                "ideation", shared, "founder", admin_app=shared, admin_required_group="admin"
            )
        ],
        authorize=_authorizer,
    )
    with TestClient(host) as client:
        client.get("/ideation/ping", headers=FOUNDER)
    assert log.count("shared:startup") == 1


def test_a_plugin_without_a_lifespan_handler_does_not_break_the_host():
    """Not every ASGI app implements lifespan; a bare gated callable must still serve."""

    async def bare(scope, receive, send):  # noqa: ANN001 — raw ASGI, deliberately
        assert scope["type"] == "http"
        await send(
            {
                "type": "http.response.start",
                "status": 204,
                "headers": [(b"content-length", b"0")],
            }
        )
        await send({"type": "http.response.body", "body": b""})

    host = build_host([MountedPlugin("bare", bare, "founder")], authorize=_authorizer)
    with TestClient(host) as client:
        assert client.get("/bare/anything", headers=FOUNDER).status_code == 204


# --------------------------------------------------------------------------------
# Warm invocations: Mangum re-enters the lifespan cycle on EVERY invocation.
# --------------------------------------------------------------------------------


@dataclass
class _LambdaContext:
    """Satisfies mangum's ``LambdaContext`` protocol. Mangum's HTTP-API handler reads
    the event, not the context, but the protocol is structurally typed so a bare
    ``None`` fails pyright."""

    function_name: str = "biffo-platform-dev-plugin-host"
    function_version: str = "$LATEST"
    invoked_function_arn: str = "arn:aws:lambda:eu-west-1:123456789012:function:plugin-host"
    memory_limit_in_mb: int = 512
    # Hex-lettered final group deliberately: .gitleaks.toml's biffo-aws-account-id
    # rule matches ANY bare 12-digit number, so an all-numeric UUID tail fails
    # Secret Scan. The account id in the ARN above is the canonical allowlisted one.
    aws_request_id: str = "3f2a1b0c-4d5e-4f60-8a1b-2c3d4e5f6a7b"
    log_group_name: str = "/aws/lambda/biffo-platform-dev-plugin-host"
    log_stream_name: str = "2026/07/30/[$LATEST]0000"
    identity: LambdaCognitoIdentity | None = None
    client_context: LambdaMobileClientContext | None = None

    def get_remaining_time_in_millis(self) -> int:
        return 30_000


def _http_api_event(path: str) -> dict:
    """A minimal API Gateway HTTP API (payload 2.0) event, as the host's Lambda gets."""
    return {
        "version": "2.0",
        "routeKey": f"GET {path}",
        "rawPath": path,
        "rawQueryString": "",
        "headers": {"x-biffo-founder-token": "alice|founder", "host": "example.test"},
        "requestContext": {
            "http": {
                "method": "GET",
                "path": path,
                "protocol": "HTTP/1.1",
                "sourceIp": "127.0.0.1",
            },
            "stage": "$default",
        },
        "isBase64Encoded": False,
    }


def test_startup_runs_once_across_warm_lambda_invocations():
    """Through Mangum — the real deployed route, and the reason for the once-per-process
    latch.

    Mangum builds a fresh ``LifespanCycle`` inside every ``__call__`` (mangum 0.21.0),
    so the host's lifespan startup fires on every invocation, not once per cold start.
    An unlatched implementation would re-seed on every single request.
    """
    from mangum import Mangum

    log: list[str] = []
    host = build_host(
        [MountedPlugin("ideation", _seeding_plugin(log), "founder")], authorize=_authorizer
    )
    handler = Mangum(host, api_gateway_base_path="/api/v1/plugins")

    first = handler(_http_api_event("/api/v1/plugins/ideation/ping"), _LambdaContext())
    second = handler(_http_api_event("/api/v1/plugins/ideation/ping"), _LambdaContext())

    assert first["statusCode"] == 200, first
    assert second["statusCode"] == 200, second
    assert log.count("ideation:startup") == 1
    assert log == ["ideation:startup", "ideation:request", "ideation:request"]


# --------------------------------------------------------------------------------
# Failure policy: quarantine the failing plugin, never the whole host.
# --------------------------------------------------------------------------------


def test_a_failing_plugin_is_quarantined_and_its_neighbours_keep_serving():
    log: list[str] = []
    host = build_host(
        [
            MountedPlugin("broken", _seeding_plugin(log, "broken", fail=True), "founder"),
            MountedPlugin("healthy", _seeding_plugin(log, "healthy"), "founder"),
        ],
        authorize=_authorizer,
    )
    with TestClient(host) as client:
        broken = client.get("/broken/ping", headers=FOUNDER)
        healthy = client.get("/healthy/ping", headers=FOUNDER)

    # Hard-fails, rather than serving a half-initialised plugin whose missing seed
    # rows would surface on the founder's first run (#909 criterion 5).
    assert broken.status_code == 503
    assert broken.headers["content-type"] == "application/json"
    # Attributable — it names the failing plugin, which is host-controlled text.
    assert "broken" in broken.json()["detail"]
    # ...but the reason itself stays in the logs, not the body. See the leak test.
    assert "could not reach Core to seed" not in broken.json()["detail"]
    # ...and one plugin's bad boot does not black out the shared Lambda.
    assert healthy.status_code == 200
    assert healthy.json() == {"seeded": True}


# Both sides of the "raised on the lifespan scope" split. A raw-ASGI app need not
# send `lifespan.startup.failed` before dying, so the exception alone cannot say
# whether it failed or simply has no lifespan handler. The discriminator is whether
# it consumed the `lifespan.startup` event. Getting this wrong fails OPEN — the
# plugin serves traffic un-started, which is the bug #924 is about.


def _raw_asgi(log: list[str], *, engage: bool, then_raise: bool) -> Any:
    """A raw-ASGI plugin that either takes the lifespan.startup event or ignores the
    scope entirely, and then either dies or returns."""

    async def app(scope: dict, receive, send) -> None:  # noqa: ANN001
        if scope["type"] == "lifespan":
            if engage:
                await receive()
            if then_raise:
                raise RuntimeError("db unreachable at cold start")
            return
        log.append("request")
        await send(
            {"type": "http.response.start", "status": 204, "headers": [(b"content-length", b"0")]}
        )
        await send({"type": "http.response.body", "body": b""})

    return app


def test_a_startup_that_raises_after_engaging_lifespan_is_quarantined():
    """The fail-open case. It engaged with the protocol and died, so it must NOT be
    mistaken for an app that simply has no startup handler."""
    log: list[str] = []
    host = build_host(
        [MountedPlugin("crashy", _raw_asgi(log, engage=True, then_raise=True), "founder")],
        authorize=_authorizer,
    )
    with TestClient(host) as client:
        r = client.get("/crashy/ping", headers=FOUNDER)
    assert r.status_code == 503, r.status_code
    assert r.json()["detail"] == "Plugin 'crashy' failed to start. See the plugin host logs."
    assert log == []  # never served a request un-started

    # The reason is preserved internally (for the ERROR log), just not in the body.
    lifespans = PluginLifespans([("crashy", _raw_asgi([], engage=True, then_raise=True))])
    asyncio.run(lifespans.startup())
    assert "db unreachable at cold start" in lifespans.failures["crashy"]


def test_an_app_that_raises_without_engaging_lifespan_is_treated_as_having_no_handler():
    """The other side. A bare ASGI callable raising on an unrecognised scope type is
    the common no-lifespan idiom, not a startup failure — it must still serve."""
    log: list[str] = []
    host = build_host(
        [MountedPlugin("bare", _raw_asgi(log, engage=False, then_raise=True), "founder")],
        authorize=_authorizer,
    )
    with TestClient(host) as client:
        assert client.get("/bare/ping", headers=FOUNDER).status_code == 204
    assert log == ["request"]


def test_an_app_that_engages_then_returns_without_completing_is_quarantined():
    """Consumed the startup event, then returned without reporting an outcome. We
    cannot know its startup succeeded, so it must not serve."""
    log: list[str] = []
    host = build_host(
        [MountedPlugin("silent", _raw_asgi(log, engage=True, then_raise=False), "founder")],
        authorize=_authorizer,
    )
    with TestClient(host) as client:
        r = client.get("/silent/ping", headers=FOUNDER)
    assert r.status_code == 503
    assert r.json()["detail"] == "Plugin 'silent' failed to start. See the plugin host logs."

    lifespans = PluginLifespans([("silent", _raw_asgi([], engage=True, then_raise=False))])
    asyncio.run(lifespans.startup())
    assert "without completing the lifespan handshake" in lifespans.failures["silent"]


def test_a_fastapi_startup_crash_still_reports_via_startup_failed():
    """Starlette/FastAPI send `lifespan.startup.failed` BEFORE re-raising, so this
    path never depended on the engagement flag. Pinned so the two mechanisms stay
    independently covered — every plugin in the estate today is FastAPI."""
    log: list[str] = []
    lifespans = PluginLifespans([("p", _seeding_plugin(log, "p", fail=True))])
    asyncio.run(lifespans.startup())
    assert "could not reach Core to seed" in lifespans.failures["p"]


def test_the_503_body_leaks_no_traceback_while_the_log_keeps_the_full_reason(caplog):
    """Starlette reports a failed startup by sending the entire formatted traceback
    as the `lifespan.startup.failed` message, so `failures[label]` holds absolute
    paths, dependency versions, source lines, and whatever the exception carried —
    here a DSN password. None of that may reach an HTTP caller; all of it must reach
    the operator's logs. Regression guard: the first cut of this quarantine
    interpolated the reason straight into the response body."""
    log: list[str] = []
    secret_dsn = "postgresql://svc:hunter2@db.internal/scout"  # noqa: S105 — fixture

    @contextlib.asynccontextmanager
    async def leaky(_app: FastAPI) -> AsyncIterator[None]:
        raise RuntimeError(f"could not reach Core: {secret_dsn}")
        yield

    app = FastAPI(lifespan=leaky)
    host = build_host([MountedPlugin("scout", app, "founder")], authorize=_authorizer)

    with caplog.at_level("ERROR", logger="plugin_host.lifespan"), TestClient(host) as client:
        detail = client.get("/scout/ping", headers=FOUNDER).json()["detail"]

    assert "Traceback" not in detail
    assert "site-packages" not in detail
    assert "hunter2" not in detail
    assert secret_dsn not in detail
    assert detail == "Plugin 'scout' failed to start. See the plugin host logs."

    # ...and the operator loses nothing: the full reason is in the ERROR log.
    assert "hunter2" in caplog.text
    assert "scout" in caplog.text
    assert log == []


def test_a_failing_admin_ingress_quarantines_only_the_admin_mount():
    log: list[str] = []
    host = build_host(
        [
            MountedPlugin(
                "ideation",
                _seeding_plugin(log, "user"),
                "founder",
                admin_app=_seeding_plugin(log, "admin", fail=True),
                admin_required_group="admin",
            )
        ],
        authorize=_authorizer,
    )
    with TestClient(host) as client:
        assert client.get("/ideation/admin/ping", headers=ADMIN).status_code == 503
        assert client.get("/ideation/ping", headers=FOUNDER).status_code == 200


def test_a_failing_plugin_does_not_stop_the_host_from_booting():
    """Explicitly the chosen policy, so a later change to it has to break a test."""
    log: list[str] = []
    host = build_host(
        [MountedPlugin("broken", _seeding_plugin(log, "broken", fail=True), "founder")],
        authorize=_authorizer,
    )
    with TestClient(host) as client:  # no exception out of lifespan startup
        assert client.get("/broken/ping", headers=FOUNDER).status_code == 503


# --------------------------------------------------------------------------------
# The unit underneath, directly.
# --------------------------------------------------------------------------------


def test_startup_targets_groups_repeated_app_objects_and_keeps_order():
    a, b = object(), object()
    assert startup_targets([("x", a), ("x/admin", a), ("y", b), ("z", None)]) == [
        (("x", "x/admin"), a),
        (("y",), b),
    ]


def test_plugin_lifespans_records_the_failure_under_every_label():
    log: list[str] = []
    broken = _seeding_plugin(log, "broken", fail=True)
    lifespans = PluginLifespans([("p", broken), ("p/admin", broken)])
    asyncio.run(lifespans.startup())
    assert set(lifespans.failures) == {"p", "p/admin"}
    assert "could not reach Core to seed" in lifespans.failures["p"]


def test_plugin_lifespans_startup_is_idempotent():
    log: list[str] = []
    lifespans = PluginLifespans([("p", _seeding_plugin(log))])

    async def run():
        try:
            await lifespans.startup()
            await lifespans.startup()
        finally:
            await lifespans.aclose()

    asyncio.run(run())
    assert log.count("ideation:startup") == 1


def test_a_plugin_route_still_sees_a_healthy_neighbour_after_a_static_admin_asset():
    """The quarantine wrapper sits outside the admin mount's public-asset exemption,
    so it must not disturb the unauthenticated shell path for a healthy plugin."""
    log: list[str] = []

    async def shell(request):
        return JSONResponse({"shell": True})

    admin = Starlette(routes=[Route("/", shell)])
    host = build_host(
        [
            MountedPlugin(
                "ideation",
                _seeding_plugin(log),
                "founder",
                admin_app=admin,
                admin_required_group="admin",
            )
        ],
        authorize=_authorizer,
    )
    with TestClient(host) as client:
        assert client.get("/ideation/admin").json() == {"shell": True}  # no token


# --------------------------------------------------------------------------------
# aclose(): the shutdown handshake's `except Exception` branch.
#
# Never called by the host in production (the module docstring: Mangum closes the
# cycle itself every invocation, so driving shutdown here would tear a plugin down
# after its first request). It exists for non-Lambda embeddings and this package's
# own tests, and it still has to get this right: a genuine shutdown failure must
# reach the operator's logs — the docstring is explicit that this "deliberately no
# longer wraps the wait in a blanket suppress(Exception)" because that hid real
# shutdown errors.
#
# NOTE on the sibling `except (TimeoutError, asyncio.CancelledError): task.cancel()`
# branch (lifespan.py:173, one line above): investigated and NOT covered here — see
# this change's PR description for the full evidence. In short, `SubAppLifespan._run`
# wraps the whole app call in `except BaseException as exc: await self._replies.put(exc)`
# and always returns normally, so it unconditionally swallows any `CancelledError`
# thrown into it — including the one `asyncio.wait_for`'s own timeout mechanism (and
# an externally-cancelled awaiter) deliver on cancellation. Per `asyncio.wait_for`'s
# own documented contract ("If the task suppresses the cancellation and returns a
# value instead, that value is returned"), this means `await asyncio.wait_for(task,
# timeout=5)` can never actually raise `TimeoutError` or `CancelledError` for this
# specific `task` — confirmed empirically (branch-level `coverage run`, and directly
# cancelling the task and awaiting it bare) rather than assumed. `task.cancel()` on
# line 173 is therefore dead code as things stand today, not merely hard to trigger.
# --------------------------------------------------------------------------------


async def _hangs_after_shutdown_is_requested(scope: dict, receive, send) -> None:  # noqa: ANN001
    """Starts cleanly, then never returns once shutdown is requested."""
    assert scope["type"] == "lifespan"
    await receive()  # lifespan.startup
    await send({"type": "lifespan.startup.complete"})
    await receive()  # lifespan.shutdown
    await asyncio.Event().wait()  # never returns


def test_aclose_logs_a_genuine_shutdown_failure_unlike_its_quiet_sibling(caplog):
    """The `except Exception` branch. Same statement shape as the sibling
    `except (TimeoutError, asyncio.CancelledError)` clause one line above (catch,
    don't re-raise) but opposite loudness, because this one is a real defect
    rather than an expected outcome — see the module-level note above this test
    for why the sibling clause is not (and, on the evidence there, cannot be)
    covered the same way.

    Reproduced via the one concrete way `asyncio.wait_for(task, timeout=5)` raises
    a plain `Exception` rather than `TimeoutError`/`CancelledError`: awaiting a task
    that belongs to a *different* event loop than the one currently running —
    `RuntimeError: Task ... got Future ... attached to a different loop`. That is a
    real hazard for `aclose()` specifically: its own docstring says it exists for
    "a non-Lambda embedding" to drive shutdown outside the host's own request
    cycle, which is exactly the kind of caller that risks running `start()` and
    `aclose()` on two different loops."""
    loop_started = asyncio.new_event_loop()
    runner = SubAppLifespan("hangs", _hangs_after_shutdown_is_requested)
    try:
        loop_started.run_until_complete(runner.start())

        loop_closes = asyncio.new_event_loop()
        try:
            with caplog.at_level("ERROR", logger="plugin_host.lifespan"):
                result = loop_closes.run_until_complete(runner.aclose())
        finally:
            loop_closes.close()

        assert result is None  # swallowed, same as the quiet branches...
        assert "hangs" in caplog.text  # ...but THIS one reaches the log
        assert "different loop" in caplog.text
    finally:
        loop_started.close()
