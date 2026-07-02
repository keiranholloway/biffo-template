"""RBAC plugin Lambda entrypoint.

Mirrors services/_template/src/service/main.py's documented event shape and
rules (ADR-0002): never import a DB client, talk to the Core API only via
``BiffoAPIClient``, react to state changes via EventBridge.

This handler's only wired responsibility today is dispatching EventBridge
events the plugin subscribes to (currently just ``biffo.core/UserCreated``,
see plugin.py) through ``RbacPlugin``'s ``EventSubscriber``.
``check_permission`` (permissions.py's ``PermissionChecker``) deliberately
has no HTTP entrypoint wired up here — there is no Terraform (issue #25)
exposing this Lambda over API Gateway or a Function URL yet. It's ready to
be called from whatever entrypoint that infra eventually adds.
"""

from __future__ import annotations

import asyncio

from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.typing import LambdaContext
from biffo_plugin_sdk import create_event_handler

from .plugin import RbacPlugin

logger = Logger()
tracer = Tracer()

_plugin: RbacPlugin | None = None


def _get_plugin() -> RbacPlugin:
    """Lazily construct the plugin singleton, reused across warm invocations
    (same rationale as BiffoAPIClient's eager-construction note in
    BiffoPluginBase: a misconfigured environment surfaces at first use, not
    buried inside every event)."""
    global _plugin
    if _plugin is None:
        _plugin = RbacPlugin()
    return _plugin


@logger.inject_lambda_context
@tracer.capture_lambda_handler
def handler(event: dict, context: LambdaContext) -> dict:
    logger.info("Received event", extra={"event": event})

    biffo_event = create_event_handler(event)
    plugin = _get_plugin()
    asyncio.run(plugin.events.dispatch(biffo_event))

    return {"statusCode": 200}
