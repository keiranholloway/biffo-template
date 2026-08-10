"""The shared plugin-host Lambda (ADR-0021).

One Lambda, behind the shared API Gateway at ``/api/v1/plugins/*``, that mounts
every installed user-facing plugin's API. It holds no database access (ADR-0002);
plugins reach data by calling Core over SigV4, asserting their identity from the
``current_plugin`` context the gate binds (ADR-0021 §1a).

The handler is built lazily on first invocation so the module imports without the
Cognito environment (tests import :func:`build_plugin_host` with an injected
authorizer instead).
"""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any

from .authz import cognito_authorizer
from .discover import discover_plugins, load_app
from .forward import FORWARDED_USER_HEADER
from .mount import Authorizer, MountedPlugin, build_host

#: Where the packaged plugins live in the Lambda image (set by the host's Terraform).
SERVICES_ROOT = os.environ.get("BIFFO_PLUGINS_ROOT", "/var/task/plugins")

#: The API Gateway prefix the host is mounted under; stripped before plugin routing.
BASE_PATH = "/api/v1/plugins"

#: Core's base URL, for forwarding manifest-declared api_routes (#652).
CORE_API_URL = os.environ.get("BIFFO_CORE_API_URL", "")


def core_sender(base_url: str = "") -> Callable[..., Any] | None:
    """The signed sender the forwarder uses to reach Core, or ``None``.

    ``None`` when no Core URL is configured, which disables forwarding rather
    than failing at import — a deployment without the variable set keeps working
    exactly as before instead of breaking every plugin request.

    Uses ``raw_request`` so Core's status reaches the original caller unchanged:
    a 403 from the permission check must surface as a 403, not as an exception
    the host has to invent a status for.
    """
    url = base_url or CORE_API_URL
    if not url:
        return None

    from biffo_plugin_sdk import SignedCoreClient

    client = SignedCoreClient(base_url=url)

    async def send(*, method: str, path: str, body: bytes | None, user_token: str):
        return await client.raw_request(
            method,
            path,
            content=body or None,
            extra_signed_headers={FORWARDED_USER_HEADER: user_token},
        )

    return send


def build_plugin_host(
    services_root: str = SERVICES_ROOT,
    *,
    authorize: Authorizer | None = None,
    load: Callable[[str], object] = load_app,
    send_to_core: Callable[..., Any] | None = None,
) -> Any:
    """Discover installed user-facing plugins, load each one's ASGI app, and build
    the gated host. ``authorize`` defaults to the real Cognito authorizer; ``load``
    is injectable so the composition is testable without importing real plugins."""
    plugins = [
        MountedPlugin(
            name=p.name,
            app=load(p.app_ref) if p.app_ref else None,
            required_group=p.required_group,
            admin_app=load(p.admin_app_ref) if p.admin_app_ref else None,
            admin_required_group=p.admin_required_group,
            api_routes=p.api_routes,
        )
        for p in discover_plugins(services_root)
    ]
    return build_host(
        plugins,
        authorize=authorize or cognito_authorizer(),
        send_to_core=send_to_core if send_to_core is not None else core_sender(),
    )


_handler: Callable[..., Any] | None = None


def handler(event: dict, context: Any) -> Any:
    """AWS Lambda entry. Builds the host on first invocation (warm-reused after),
    so the Cognito config is resolved at runtime, not import time."""
    global _handler
    if _handler is None:
        from mangum import Mangum

        # No `lifespan=` argument, so Mangum's default "auto" applies and the host's
        # lifespan RUNS — that is load-bearing, not incidental. `build_host` hangs each
        # mounted plugin's own startup off it, because Starlette's `Mount` never
        # delivers the lifespan scope to a sub-app (#924). Passing lifespan="off" here
        # (as `services/api` does) would silently stop every plugin self-seeding again.
        # Note Mangum re-enters the lifespan cycle on every invocation, not just cold
        # starts; `plugin_host.lifespan.PluginLifespans` latches startup accordingly.
        _handler = Mangum(build_plugin_host(), api_gateway_base_path=BASE_PATH)
    return _handler(event, context)
