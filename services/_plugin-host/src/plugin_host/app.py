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

import logging
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .authz import cognito_authorizer
from .discover import discover_plugins, load_app
from .forward import FORWARDED_USER_HEADER
from .mount import Authorizer, MountedPlugin, build_host

_LOGGER = logging.getLogger(__name__)

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


def _load_isolated(
    load: Callable[[str], object], app_ref: str | None, *, plugin_name: str, field: str
) -> tuple[object | None, bool]:
    """``(app, failed)``: ``load(app_ref)``, or ``(None, True)`` (logged at ERROR)
    if importing it raised.

    A single plugin's broken import must not crash ``build_plugin_host`` and take
    every other installed plugin's app down with it (biffo-template#2092) —
    reproduced live on biffo-platform dev when one plugin's manifest-adjacent module
    raised ``FileNotFoundError`` at import and every plugin behind the shared host
    500'd. The same reasoning ``mount.py``'s ``_SpaStaticFiles`` guard and
    ``discover.py``'s module docstring state for a malformed manifest.

    ``failed`` is reported separately from ``app is None`` because the two mean
    different things to the router (#2095): a plugin that never declared this ref has
    nothing to mount and nothing to protect, whereas one that declared it and failed
    must keep its URL space owned by a 503 mount — omitting the mount would let
    ``/<name>/admin/*`` fall through to the founder-gated user app, and would turn
    "plugin is down" into a bare 404 ("plugin not installed"). ``build_host`` reads
    the flag; see :func:`plugin_host.mount._load_failed`.

    Caught as ``(Exception, SystemExit)``: a module import can fail in essentially any
    way a plugin author's code can raise — ``ModuleNotFoundError``,
    ``FileNotFoundError``, ``AttributeError`` (a bad ``:attr``), a ``SyntaxError``, or
    an arbitrary exception executed at import time — and some config-check patterns
    call ``sys.exit()``, which raises ``SystemExit`` (a ``BaseException``) straight
    through a bare ``except Exception``. ``KeyboardInterrupt`` and the like are
    deliberately NOT caught: those are the operator's, not the plugin's.

    This is the *import*-stage containment; ``mount.py``'s ``_quarantine``/``failures``
    covers the later stage — a plugin that mounted but whose ASGI *lifespan* startup
    then fails.
    """
    if app_ref is None:
        return None, False
    try:
        return load(app_ref), False
    except (Exception, SystemExit) as exc:  # noqa: BLE001 — a plugin's import can raise anything
        _LOGGER.error(
            "Plugin %r declares %s %r but importing it raised %s; serving 503 at its "
            "%s mount so every other plugin still starts: %s",
            plugin_name,
            field,
            app_ref,
            type(exc).__name__,
            field,
            exc,
        )
        return None, True


def build_plugin_host(
    services_root: str = SERVICES_ROOT,
    *,
    authorize: Authorizer | None = None,
    load: Callable[[str], object] = load_app,
    send_to_core: Callable[..., Any] | None = None,
) -> Any:
    """Discover installed user-facing plugins, load each one's ASGI app, and build
    the gated host. ``authorize`` defaults to the real Cognito authorizer; ``load``
    is injectable so the composition is testable without importing real plugins.

    Each plugin's ``app``/``admin_app`` is loaded in its own isolation boundary
    (:func:`_load_isolated`) — one plugin's broken import must not prevent
    ``build_plugin_host`` from returning a host for everyone else, and the failed
    plugin's URL space stays owned by a 503 mount (#2095), not absent.
    """
    plugins = []
    for p in discover_plugins(services_root):
        app, app_failed = _load_isolated(load, p.app_ref, plugin_name=p.name, field="app_ref")
        admin_app, admin_failed = _load_isolated(
            load, p.admin_app_ref, plugin_name=p.name, field="admin_app_ref"
        )
        plugins.append(
            MountedPlugin(
                name=p.name,
                app=app,
                required_group=p.required_group,
                admin_app=admin_app,
                admin_required_group=p.admin_required_group,
                api_routes=p.api_routes,
                # Resolved here, not in discover.py: discover.py only knows the
                # manifest-relative dir (ADR-0021 §2's "who serves" — the host
                # derives BIFFO_PLUGINS_ROOT/<name>/<user_frontend.dir> itself).
                user_frontend_dir=(
                    str(Path(services_root) / p.name / p.user_frontend_dir)
                    if p.user_frontend_dir is not None
                    else None
                ),
                app_load_failed=app_failed,
                admin_app_load_failed=admin_failed,
            )
        )
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
