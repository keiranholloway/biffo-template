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
from .mount import Authorizer, MountedPlugin, build_host

#: Where the packaged plugins live in the Lambda image (set by the host's Terraform).
SERVICES_ROOT = os.environ.get("BIFFO_PLUGINS_ROOT", "/var/task/plugins")

#: The API Gateway prefix the host is mounted under; stripped before plugin routing.
BASE_PATH = "/api/v1/plugins"


def build_plugin_host(
    services_root: str = SERVICES_ROOT,
    *,
    authorize: Authorizer | None = None,
    load: Callable[[str], object] = load_app,
) -> Any:
    """Discover installed user-facing plugins, load each one's ASGI app, and build
    the gated host. ``authorize`` defaults to the real Cognito authorizer; ``load``
    is injectable so the composition is testable without importing real plugins."""
    plugins = [
        MountedPlugin(name=p.name, app=load(p.app_ref), required_group=p.required_group)
        for p in discover_plugins(services_root)
    ]
    return build_host(plugins, authorize=authorize or cognito_authorizer())


_handler: Callable[..., Any] | None = None


def handler(event: dict, context: Any) -> Any:
    """AWS Lambda entry. Builds the host on first invocation (warm-reused after),
    so the Cognito config is resolved at runtime, not import time."""
    global _handler
    if _handler is None:
        from mangum import Mangum

        _handler = Mangum(build_plugin_host(), api_gateway_base_path=BASE_PATH)
    return _handler(event, context)
