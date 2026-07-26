"""Orchestrator plugin Lambda entrypoint.

Invoked two ways:

1. By the plugin's EventBridge rule (terraform/) for each subscribed bus
   event — turned into a ``BiffoEvent`` and dispatched through
   ``OrchestratorPlugin``'s ``EventSubscriber`` (ADR-0002: no DB client, Core
   API only, react to events).
2. By EventBridge Scheduler, directly invoking this Lambda at a scheduled
   run's fire time (docs/implementation/0002-scheduled-workflow-actions,
   ADR-0023) with a small sentinel payload — not an EventBridge-rule-shaped
   event, and deliberately never turned into one: it is routed straight to
   ``fire_scheduled_run``, before ``create_event_handler`` ever sees it,
   since that call requires a source/detail-type/detail envelope and would
   raise on this shape.
"""

from __future__ import annotations

import asyncio

from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.typing import LambdaContext
from biffo_plugin_sdk import create_event_handler

from .plugin import SCHEDULED_RUN_ID_KEY, OrchestratorPlugin

logger = Logger()
tracer = Tracer()

# Reuse one event loop across warm invocations. asyncio.run() closes the loop
# each call, but the plugin's reused httpx client pools connections bound to
# the first loop -> "RuntimeError: Event loop is closed" on the next
# invocation. Mirrors services/api/src/api/main.py.
_loop = asyncio.new_event_loop()
asyncio.set_event_loop(_loop)

_plugin: OrchestratorPlugin | None = None


def _get_plugin() -> OrchestratorPlugin:
    """Lazily construct the plugin singleton, reused across warm invocations."""
    global _plugin
    if _plugin is None:
        _plugin = OrchestratorPlugin()
    return _plugin


@logger.inject_lambda_context
@tracer.capture_lambda_handler
def handler(event: dict, context: LambdaContext) -> dict:
    logger.info("Received event", extra={"event": event})

    global _loop
    if _loop.is_closed():
        _loop = asyncio.new_event_loop()
    asyncio.set_event_loop(_loop)

    plugin = _get_plugin()

    run_id = event.get(SCHEDULED_RUN_ID_KEY)
    if run_id is not None:
        _loop.run_until_complete(plugin.fire_scheduled_run(run_id))
        return {"statusCode": 200}

    biffo_event = create_event_handler(event)
    _loop.run_until_complete(plugin.events.dispatch(biffo_event))

    return {"statusCode": 200}
