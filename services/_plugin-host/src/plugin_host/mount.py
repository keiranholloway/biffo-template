"""Mounting and group-gating user-facing plugin apps in the shared plugin host
(ADR-0021 §1/§1a).

The shared plugin host is ONE Lambda that runs every installed user-facing plugin's
API. Each plugin contributes an ASGI app (a FastAPI app or router); the host mounts
it at ``/<name>`` behind a group-gate. The gate:

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

import json
from collections.abc import Callable
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

from biffo_plugin_sdk import acting_as_plugin
from starlette.applications import Starlette
from starlette.routing import Mount

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
    app, and the Cognito group a caller must be in."""

    name: str
    app: Any
    required_group: str


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


def group_gate(plugin: MountedPlugin, authorize: Authorizer) -> Callable:
    """Wrap a plugin's ASGI app so every HTTP request is authorized against the
    plugin's group and runs with the plugin's identity bound."""

    async def gated(scope: dict, receive: Callable, send: Callable) -> None:
        if scope["type"] != "http":
            await plugin.app(scope, receive, send)
            return
        token = _founder_token(scope.get("headers", []))
        try:
            authorize(token, plugin.required_group)
        except GateError as exc:
            await _send_json(send, exc.status, {"detail": exc.detail})
            return
        reset = current_plugin.set(plugin.name)
        # The SDK's SignedCoreClient reads this to stamp the X-Biffo-Plugin identity
        # header on the plugin's outbound Core calls (ADR-0021 §1a), so Core grants
        # `system:<plugin>` rather than the host's own role identity.
        reset_sdk = acting_as_plugin.set(plugin.name)
        try:
            await plugin.app(scope, receive, send)
        finally:
            current_plugin.reset(reset)
            acting_as_plugin.reset(reset_sdk)

    return gated


def build_host(plugins: list[MountedPlugin], *, authorize: Authorizer) -> Starlette:
    """The shared plugin-host ASGI app: each plugin mounted, gated, under ``/<name>``.

    Starlette's ``Mount`` strips the ``/<name>`` prefix, so a plugin's routes stay
    clean (``/sessions``, …) with no per-plugin knowledge of where it is mounted —
    replacing ADR-0018's per-plugin Mangum ``api_gateway_base_path`` hack.
    """
    routes = [Mount(f"/{p.name}", app=group_gate(p, authorize)) for p in plugins]
    return Starlette(routes=routes)
