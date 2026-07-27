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
        self._routes = tuple((r.method.upper(), _pattern(r.path)) for r in routes)
        self._send_to_core = send_to_core

    def matches(self, method: str, path: str) -> bool:
        return any(m == method.upper() and p.match(path) for m, p in self._routes)

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
) -> Callable:
    """Wrap ``plugin_app`` so declared routes go to Core and everything else
    reaches the plugin unchanged.

    Deliberately placed OUTSIDE the plugin's group gate: a declared route is
    authorised by its table's own permissions in Core, and gating it on the
    plugin's user group as well would reject the admin that e.g. an
    admin-only ``required_role`` exists to admit. Non-declared paths fall
    through untouched, so the plugin's own routes keep their gate.
    """

    async def app(scope: dict, receive: Callable, send: Callable) -> None:
        if scope.get("type") != "http":
            await plugin_app(scope, receive, send)
            return

        path = _route_path(scope)
        if not forwarder.matches(scope.get("method", "GET"), path):
            await plugin_app(scope, receive, send)
            return

        token = token_of(scope.get("headers") or [])
        if not token:
            # Core cannot authorise without a user; fail here rather than
            # forwarding an unaccompanied signed call.
            await _respond_json(send, 401, {"detail": "No bearer token"})
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
