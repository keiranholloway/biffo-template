"""Forwarding manifest-declared ``api_routes`` to Core (#652).

A plugin's ``api_routes`` are generated and served by **Core**, from the table
declaration — the plugin's own app never implements them. Core registers them at
``/api/v1/plugins/<name>/<path>``, but API Gateway sends all of
``/api/v1/plugins/*`` to this host (ADR-0021's catch-all), so that mount is
unaddressable from outside: a call to it lands back here, not at Core. The
result was that declared ``api_routes`` did not work in any deployed instance.

Core therefore also mounts them under ``/api/v1/internal/plugins/<name>/<path>``,
which is IAM-authorized and does reach Core. This module is the other half: the
host recognises a declared route and forwards it there, SigV4-signed as the
host, carrying the caller's own token in ``X-Biffo-User-Token`` so Core resolves
and authorises the **user**, not the host.

**Authorization for these routes is the table's own ADR-0004 ``permissions``**,
evaluated by Core — not the plugin's ``user_ingress.required_group``. That is
deliberate: the admin UI's calls are admin-gated by the table's
``required_role``, and gating them additionally on the plugin's *founder* group
would reject the admin the route exists for. So the forwarder sits ahead of the
group gate and matches ONLY declared routes; everything else still reaches the
plugin's app behind its gate, unchanged.

**With one exception, added in #1837: a rule that authorises nobody.** The
sentence above holds only while the table rule actually decides something. A rule
that is ``allowed`` with an empty ``required_role`` and an empty
``permission_code`` names nobody in particular, so Core admits any authenticated
caller of the tenant — and because the forwarder sits outside the group gate,
nothing was checked anywhere. Reproduced live: an ``hq-admin`` persona JWT with
no ``cognito:groups`` claim at all read five marketing tables with HTTP 200,
while the same mount correctly returned 403 on a sub-route it evaluates itself.

So *only in that case*, the forwarder falls back to the plugin's
``user_ingress.required_group`` and refuses a caller who has not passed it,
without calling Core at all. Where the rule expresses any authorisation —
either axis — behaviour is exactly as before and Core remains the sole
authority. The predicate is :attr:`~plugin_host.discover.DeclaredRoute.authorises_nobody`;
its docstring holds the reasoning for why both axes are in it.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from typing import Any

from .discover import DeclaredRoute

#: Header the caller's own token rides in when the request is SigV4-signed
#: (the signature owns ``Authorization``). Must match Core's
#: ``middleware/forwarded_user.FORWARDED_USER_HEADER``.
FORWARDED_USER_HEADER = "X-Biffo-User-Token"

#: Where Core mounts the same declared routes behind IAM.
INTERNAL_PREFIX = "/api/v1/internal/plugins"


def _pattern(path: str) -> re.Pattern[str]:
    """A declared path (``/model-catalog/{id}``) as an exact-match regex.

    Path params match a single segment, mirroring how Starlette/FastAPI resolve
    ``{id}`` — so ``/a/{id}`` matches ``/a/x`` but never ``/a/x/y``.
    """
    return re.compile(
        "^"
        + re.sub(r"\{[^/}]+\}", r"[^/]+", re.escape(path).replace(r"\{", "{").replace(r"\}", "}"))
        + "$"
    )


class DeclaredRouteForwarder:
    """Matches declared routes for one plugin and forwards them to Core."""

    def __init__(
        self,
        plugin_name: str,
        routes: tuple[DeclaredRoute, ...],
        *,
        send_to_core: Callable[..., Any],
    ) -> None:
        self.plugin_name = plugin_name
        self._routes = tuple((r.method.upper(), _pattern(r.path), r) for r in routes)
        self._send_to_core = send_to_core

    def match(self, method: str, path: str) -> DeclaredRoute | None:
        """The matched declared route, or ``None``.

        The route itself rather than a bool (#1837): the gate has to read the
        route's own table rule to decide whether anything authorised it.

        If a manifest declares two routes matching the same method and path, the
        first wins — which is the one this forwarder already routed to before
        #1837, so nothing about routing order changes here.
        """
        for m, pattern, route in self._routes:
            if m == method.upper() and pattern.match(path):
                return route
        return None

    def matches(self, method: str, path: str) -> bool:
        """Whether any declared route matches. Kept as the boolean form of
        :meth:`match` for callers that only need routing, not the rule."""
        return self.match(method, path) is not None

    def core_path(self, path: str) -> str:
        return f"{INTERNAL_PREFIX}/{self.plugin_name}{path}"


async def _respond(send: Callable, status: int, body: bytes, content_type: str) -> None:
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", content_type.encode()),
                (b"content-length", str(len(body)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


async def _respond_json(send: Callable, status: int, payload: dict) -> None:
    await _respond(send, status, json.dumps(payload).encode(), "application/json")


def forwarding_gate(
    plugin_app: Any,
    forwarder: DeclaredRouteForwarder,
    *,
    token_of: Callable[[list[tuple[bytes, bytes]]], str],
    required_group: str | None = None,
    authorize: Callable[[str, str], Any] | None = None,
) -> Callable:
    """Wrap ``plugin_app`` so declared routes go to Core and everything else
    reaches the plugin unchanged.

    Deliberately placed OUTSIDE the plugin's group gate: a declared route is
    normally authorised by its table's own permissions in Core, and gating it on
    the plugin's user group as well would reject the admin that e.g. an
    admin-only ``required_role`` exists to admit. Non-declared paths fall
    through untouched, so the plugin's own routes keep their gate.

    **Except where the table rule authorises nobody** (#1837). Then Core admits
    any authenticated caller of the tenant, "outside the group gate" means
    nothing is checked anywhere, and this gate falls back to the plugin's own
    ``required_group``: it calls ``authorize`` and answers the resulting
    :class:`~plugin_host.mount.GateError`'s status and detail as JSON **without
    calling Core**. See the module docstring, and
    :attr:`~plugin_host.discover.DeclaredRoute.authorises_nobody` for why the
    predicate reads both ADR-0004 axes.

    ``required_group``/``authorize`` are optional so an existing caller keeps
    today's behaviour, and because a plugin may have no group to fall back to —
    in which case no group is invented and the route is forwarded as before
    (decision 3). ``discover`` logs that case at ERROR rather than leaving it
    silent.
    """
    # Deferred to here rather than module scope: `mount` imports this module, so
    # a top-level import would be circular. Resolved once per wrap, not per
    # request — `build_host` calls this while `mount` is fully imported.
    from .mount import GateError

    async def app(scope: dict, receive: Callable, send: Callable) -> None:
        if scope.get("type") != "http":
            await plugin_app(scope, receive, send)
            return

        path = _route_path(scope)
        route = forwarder.match(scope.get("method", "GET"), path)
        if route is None:
            await plugin_app(scope, receive, send)
            return

        token = token_of(scope.get("headers") or [])
        if not token:
            # Core cannot authorise without a user; fail here rather than
            # forwarding an unaccompanied signed call.
            await _respond_json(send, 401, {"detail": "No bearer token"})
            return

        if route.authorises_nobody and required_group and authorize is not None:
            # Nothing downstream will check this caller — the table rule names
            # nobody and Core would admit any authenticated user of the tenant.
            try:
                authorize(token, required_group)
            except GateError as exc:
                await _respond_json(send, exc.status, {"detail": exc.detail})
                return

        body = await _read_body(receive)
        try:
            status, payload, content_type = await forwarder._send_to_core(
                method=scope.get("method", "GET"),
                path=forwarder.core_path(path),
                body=body,
                user_token=token,
            )
        except Exception:  # noqa: BLE001 — never leak a stack trace to a caller
            await _respond_json(send, 502, {"detail": "Upstream Core request failed"})
            return

        await _respond(send, status, payload, content_type)

    return app


async def _read_body(receive: Callable) -> bytes:
    chunks: list[bytes] = []
    while True:
        message = await receive()
        if message["type"] != "http.request":
            break
        chunks.append(message.get("body", b"") or b"")
        if not message.get("more_body"):
            break
    return b"".join(chunks)


def _route_path(scope: dict) -> str:
    """Path relative to this callable's mount point (same rule as mount.py)."""
    path: str = scope["path"]
    root_path = scope.get("root_path", "")
    if not root_path or not path.startswith(root_path):
        return path
    if path == root_path:
        return ""
    return path[len(root_path) :] if path[len(root_path)] == "/" else path
