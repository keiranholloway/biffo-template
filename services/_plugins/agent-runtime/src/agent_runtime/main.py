"""Agent runtime Lambda entrypoint.

Invoked by this plugin's EventBridge rule (``terraform/``) for each
``agent.run.requested`` event. Turns the raw EventBridge event into a
``BiffoEvent`` and dispatches it through ``AgentRuntimePlugin``'s
``EventSubscriber`` (ADR-0002: no DB client, Core API only, react to events).

The Lambda's configured timeout (300s, see ``terraform/variables.tf``) is the
outer bound; the loop's own wall clock (``AGENT_RUNTIME_MAX_SECONDS``, 240s by
default) sits inside it so a run that exhausts its budget still has time to POST
its failure to Core rather than being killed mid-report (ADR-0014 §8, §5).
"""

from __future__ import annotations

import asyncio

from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.typing import LambdaContext
from biffo_plugin_sdk import create_event_handler

from .plugin import AgentRuntimePlugin

logger = Logger()
tracer = Tracer()

# Reuse one event loop across warm invocations. asyncio.run() closes the loop
# each call, but the plugin's reused httpx clients pool connections bound to the
# first loop -> "RuntimeError: Event loop is closed" on the next invocation.
# Mirrors services/api/src/api/main.py and the orchestrator plugin.
_loop = asyncio.new_event_loop()
asyncio.set_event_loop(_loop)

_plugin: AgentRuntimePlugin | None = None


def _get_plugin() -> AgentRuntimePlugin:
    """Lazily construct the plugin singleton, reused across warm invocations."""
    global _plugin
    if _plugin is None:
        _plugin = AgentRuntimePlugin()
    return _plugin


@logger.inject_lambda_context
@tracer.capture_lambda_handler
def handler(event: dict, context: LambdaContext) -> dict:
    logger.info("Received event", extra={"event": event})

    global _loop
    if _loop.is_closed():
        _loop = asyncio.new_event_loop()
    asyncio.set_event_loop(_loop)

    biffo_event = create_event_handler(event)
    plugin = _get_plugin()
    _loop.run_until_complete(plugin.events.dispatch(biffo_event))

    return {"statusCode": 200}
