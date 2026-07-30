"""Mounting and group-gating user-facing and admin-facing plugin apps in the shared
plugin host (ADR-0021 §1/§1a).

The shared plugin host is ONE Lambda that runs every installed user-facing plugin's
API. Each plugin contributes an ASGI app (a FastAPI app or router); the host mounts
it at ``/<name>`` behind a group-gate, and optionally at ``/<name>/admin`` for the
admin ingress. The gate:

- authorizes the founder JWT against the plugin's declared ``required_group`` — the
  host, being platform code, enforces authorization (ADR-0011), not the plugin;
- on success binds the plugin's identity (``current_plugin``) for the request, so
  the outbound Core transport can assert *which* plugin is calling Core's internal
  endpoints (ADR-0021 §1a — the shared IAM role no longer identifies the plugin);
- on failure returns **JSON**, never the HTML the shared SPA distribution would
  (the ADR-0018 ``Unexpected token '<'`` bug).

This module is pure: the authorizer is injected, so it is fully testable without
FastAPI, Cognito, or a real token. `app.py` binds the real Cognito authorizer.
"""

from __future__ import annotations

import contextlib
import json
from collections.abc import AsyncIterator, Callable
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

from biffo_plugin_sdk import acting_as_plugin
from starlette.applications import Starlette
from starlette.routing import Mount

from .discover import DeclaredRoute
from .forward import DeclaredRouteForwarder, forwarding_gate
from .lifespan import PluginLifespans

#: The plugin whose router is handling the current request. None outside a gated
#: plugin request. Bound alongside the SDK's ``acting_as_plugin`` (which the
#: outbound Core transport actually reads to assert plugin identity, ADR-0021 §1a).
current_plugin: ContextVar[str | None] = ContextVar("current_plugin", default=None)


class GateError(Exception):
    """Authorization failed. ``status`` is 401 (no/invalid token) or 403 (wrong group)."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


#: ``(token, required_group) -> identity`` — returns the authorized founder (any
#: truthy value), or raises :class:`GateError`. Injected so the core is testable.
Authorizer = Callable[[str, str], Any]


@dataclass(frozen=True)
class MountedPlugin:
    """A plugin ready to mount: its name (URL segment + asserted identity), its ASGI
    app, and the Cognito group a caller must be in. Optionally includes an admin app
    mounted at ``/<name>/admin``."""

    name: str
    app: Any
    required_group: str
    admin_app: Any | None = None
    admin_required_group: str | None = None
    #: Manifest-declared api_routes (ADR-0003). Served by Core, not by the
    #: plugin — the host forwards them (#652). Empty means nothing to forward.
    api_routes: tuple[DeclaredRoute, ...] = ()


def _founder_token(headers: list[tuple[bytes, bytes]]) -> str:
    """The founder JWT from request headers. Prefers ``X-Biffo-Founder-Token`` (raw),
    falls back to ``Authorization: Bearer`` (ADR-0018 header decision)."""
    lookup = {k.decode().lower(): v.decode() for k, v in headers}
    token = lookup.get("x-biffo-founder-token", "").strip()
    if token:
        return token.split(" ", 1)[1].strip() if token.lower().startswith("bearer ") else token
    auth = lookup.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth.split(" ", 1)[1].strip()
    return ""


async def _send_json(send: Callable, status: int, body: dict) -> None:
    payload = json.dumps(body).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(payload)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": payload})


#: Paths within an admin_ingress mount that are the built UI shell, not the JSON
#: API — served publicly (no token), mirroring how a founder app's static UI is
#: hosted unauthenticated on its own CloudFront distribution (ADR-0018) while only
#: its *API calls* are gated. admin_ingress instead serves both from this one
#: mount, so the exemption has to happen here. Matches Vite's own build-output
#: convention (``dist/index.html`` + hashed files under ``dist/assets/``) — a
#: plugin's admin API must not declare routes at ``/`` or under ``/assets/*``.
def _is_public_admin_asset(path: str) -> bool:
    return path in ("", "/") or path.startswith("/assets/")


def _route_path(scope: dict) -> str:
    """The request path relative to this ASGI callable's own mount point.

    Starlette's ``Mount`` does not rewrite ``scope["path"]`` in place — it only
    grows ``scope["root_path"]`` by the matched prefix, leaving ``path`` as the
    full original request path throughout (verified against Starlette's own
    ``Mount.matches``/``get_route_path``). This mirrors that same, tiny
    computation without importing Starlette's private ``_utils`` module.
    """
    path: str = scope["path"]
    root_path = scope.get("root_path", "")
    if not root_path or not path.startswith(root_path):
        return path
    if path == root_path:
        return ""
    return path[len(root_path) :] if path[len(root_path)] == "/" else path


def group_gate(
    app: Any,
    required_group: str,
    plugin_name: str,
    authorize: Authorizer,
    *,
    is_public_path: Callable[[str], bool] | None = None,
) -> Callable:
    """Wrap a plugin's ASGI app so every HTTP request is authorized against the
    required group and runs with the plugin's identity bound.

    ``is_public_path``, when given, exempts matching request paths from the
    token check entirely — used only for the admin mount's static UI shell
    (see :func:`_is_public_admin_asset`). The API Gateway route this Lambda sits
    behind must independently allow these same paths through unauthenticated
    (biffo-template#627) — this in-Lambda exemption alone does not help if the
    Gateway itself already rejected the request first.
    """

    async def gated(scope: dict, receive: Callable, send: Callable) -> None:
        if scope["type"] != "http":
            await app(scope, receive, send)
            return
        if is_public_path is not None and is_public_path(_route_path(scope)):
            await app(scope, receive, send)
            return
        token = _founder_token(scope.get("headers", []))
        try:
            authorize(token, required_group)
        except GateError as exc:
            await _send_json(send, exc.status, {"detail": exc.detail})
            return
        reset = current_plugin.set(plugin_name)
        # The SDK's SignedCoreClient reads this to stamp the X-Biffo-Plugin identity
        # header on the plugin's outbound Core calls (ADR-0021 §1a), so Core grants
        # `system:<plugin>` rather than the host's own role identity.
        reset_sdk = acting_as_plugin.set(plugin_name)
        try:
            await app(scope, receive, send)
        finally:
            current_plugin.reset(reset)
            acting_as_plugin.reset(reset_sdk)

    return gated


def _normalize_bare_admin_paths(app: Any, bare_paths: frozenset[str]) -> Callable:
    """Rewrite scope["path"] to add a trailing slash for an exact, bare
    ``/<name>/admin`` request before Starlette's own router ever sees it.

    Starlette's ``Mount("/<name>/admin", ...)`` compiles to a regex requiring a
    trailing slash (``^/<name>/admin/(?P<path>.*)$``) — proven by inspecting
    ``Mount(...).path_regex.pattern`` directly. A request for the bare path
    with NO trailing slash and nothing after it therefore never matches that
    Mount at all; Starlette falls through to the next route that DOES match —
    the founder-facing ``Mount("/<name>", ...)``, which happens to also match
    ``/<name>/admin`` as "founder mount, sub-path admin" and gates it with the
    wrong (founder) group entirely. Confirmed live: a real deployed request to
    the bare admin path returned "No bearer token" from the FOUNDER gate, not
    a 404 or the admin gate — i.e. it silently routed to the wrong plugin app.

    This can't be fixed by redirecting to the trailing-slash form either: the
    API Gateway route in front of this Lambda has no unauthenticated route for
    that form at all (AWS rejects a route_key ending in a bare "/" —
    biffo-template#631) — the bare, no-slash path is the ONLY form reachable
    unauthenticated at the Gateway, so it has to resolve correctly as-is.
    """

    async def normalized(scope: dict, receive: Callable, send: Callable) -> None:
        if scope["type"] == "http" and scope.get("path") in bare_paths:
            scope = {**scope, "path": scope["path"] + "/"}
        await app(scope, receive, send)

    return normalized


def _quarantine(app: Any, label: str, failures: dict[str, str]) -> Callable:
    """Wrap a mount so it hard-fails once its plugin's startup has failed.

    ``failures`` is read per request (not captured), because it is filled in during
    the host's lifespan startup — after the routes are built. A quarantined plugin
    returns 503 rather than serving a half-initialised app; only that plugin's mount
    is affected. See :meth:`PluginLifespans.startup` for why the failure is contained
    here rather than failing the whole host.

    **The stored reason is deliberately NOT put in the response.** Starlette reports
    a failed startup by sending the whole formatted traceback as the
    ``lifespan.startup.failed`` message, so ``failures[label]`` holds absolute
    filesystem paths, dependency versions, source lines, and whatever the exception
    itself carried — a DSN with its password, for instance. Interpolating it into the
    body leaked all of that to any caller that could reach the mount. The plugin
    *name* is host-controlled and safe, so the 503 stays attributable ("which plugin
    is down") without being disclosive ("and here is its stack"); the reason goes to
    the host's logs only, via :meth:`PluginLifespans.startup`. Same rule as
    :func:`plugin_host.forward.forwarding_gate`'s "never leak a stack trace to a
    caller". Guarded by a test asserting the body carries no traceback.
    """

    async def guarded(scope: dict, receive: Callable, send: Callable) -> None:
        if failures.get(label) is not None and scope["type"] == "http":
            await _send_json(
                send,
                503,
                {"detail": f"Plugin '{label}' failed to start. See the plugin host logs."},
            )
            return
        await app(scope, receive, send)

    return guarded


def build_host(
    plugins: list[MountedPlugin],
    *,
    authorize: Authorizer,
    send_to_core: Any | None = None,
) -> Any:
    """The shared plugin-host ASGI app: each plugin mounted, gated, under ``/<name>``
    and optionally under ``/<name>/admin`` if an admin ingress is declared.

    Starlette's ``Mount`` strips the ``/<name>`` prefix, so a plugin's routes stay
    clean (``/sessions``, …) with no per-plugin knowledge of where it is mounted —
    replacing ADR-0018's per-plugin Mangum ``api_gateway_base_path`` hack.

    The host also owns a **lifespan** that runs each mounted plugin's own startup
    handler, because ``Mount`` does not (#924) — see :mod:`plugin_host.lifespan`.
    It runs before the first request is served, so a plugin's cold-start work
    (self-seeding via Core's service-principal routes) has completed by then.
    """
    routes = []
    bare_admin_paths = set()
    #: (mount label, app) for every app whose lifespan the host must run.
    mounted: list[tuple[str, Any]] = []
    #: Filled in place during lifespan startup; read per request by _quarantine.
    failures: dict[str, str] = {}
    for p in plugins:
        # Admin app mount (if declared) — must come before user-facing mount so
        # /ideation/admin/* matches before /ideation/* (Starlette routes are
        # checked in order, and a Mount matches if the path starts with its prefix)
        if p.admin_app is not None and p.admin_required_group is not None:
            admin_label = f"{p.name}/admin"
            routes.append(
                Mount(
                    f"/{p.name}/admin",
                    app=_quarantine(
                        group_gate(
                            p.admin_app,
                            p.admin_required_group,
                            p.name,
                            authorize,
                            is_public_path=_is_public_admin_asset,
                        ),
                        admin_label,
                        failures,
                    ),
                )
            )
            bare_admin_paths.add(f"/{p.name}/admin")
            mounted.append((admin_label, p.admin_app))
        # User-facing app mount. When the plugin declares api_routes, the
        # forwarder wraps the gated app OUTSIDE the group gate: those routes are
        # authorised by their table's own permissions in Core (ADR-0004), and
        # gating them on the plugin's user group as well would reject the admin
        # an admin-only required_role exists to admit (#652). Everything else
        # falls through to the gated plugin app untouched.
        user_app = group_gate(p.app, p.required_group, p.name, authorize)
        if p.api_routes and send_to_core is not None:
            user_app = forwarding_gate(
                user_app,
                DeclaredRouteForwarder(p.name, p.api_routes, send_to_core=send_to_core),
                token_of=_founder_token,
            )
        routes.append(Mount(f"/{p.name}", app=_quarantine(user_app, p.name, failures)))
        mounted.append((p.name, p.app))

    lifespans = PluginLifespans(mounted, failures=failures)

    @contextlib.asynccontextmanager
    async def host_lifespan(_app: Any) -> AsyncIterator[None]:
        # Mangum enters this before the request cycle, so every plugin's startup
        # has run by the time the first request is served. `PluginLifespans` makes
        # it a no-op on warm invocations (Mangum re-enters the cycle every time).
        await lifespans.startup()
        yield

    host = Starlette(routes=routes, lifespan=host_lifespan)
    if not bare_admin_paths:
        return host
    return _normalize_bare_admin_paths(host, frozenset(bare_admin_paths))
