"""Agent runtime Lambda entrypoint.

Two dispatch paths, both AWS-internal, neither public (ADR-0002, ADR-0009):

1. **EventBridge worker** (the original path). Invoked by this plugin's
   EventBridge rule (``terraform/``) for each ``agent.run.requested`` event, and
   by the scheduled reap tick. The raw event becomes a ``BiffoEvent`` dispatched
   through ``AgentRuntimePlugin``'s ``EventSubscriber``. The runtime reads/claims/
   reports the run over the Core internal API (no DB client, ADR-0002).

2. **Synchronous chat turn** (ADR-0016, buffered amendment). Core synchronously
   invokes this Lambda (``RequestResponse``) for one prompt-assistant turn, having
   already assembled and fenced the messages under the user's authority. This path
   calls OpenRouter's buffered ``complete()`` and returns the reply — it touches
   neither Core nor the database. See ``chat_turn.py``.

The two are told apart by payload shape (:func:`chat_turn.is_chat_turn`): a chat
turn carries an explicit ``kind`` marker, an EventBridge event never does. The
worker path below is byte-behaviourally unchanged from before ADR-0016.

The Lambda's configured timeout (300s, see ``terraform/variables.tf``) is the
outer bound; the worker loop's own wall clock (``AGENT_RUNTIME_MAX_SECONDS``,
240s by default) sits inside it so a run that exhausts its budget still has time
to POST its failure to Core (ADR-0014 §8, §5). The chat turn has its own, much
tighter ceiling sized for the API Gateway window (``chat_turn.py``).
"""

from __future__ import annotations

import asyncio

from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.typing import LambdaContext
from biffo_plugin_sdk import create_event_handler

from .chat_turn import is_chat_turn, run_chat_turn
from .openrouter import OpenRouterClient
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
_llm: OpenRouterClient | None = None


def _get_plugin() -> AgentRuntimePlugin:
    """Lazily construct the plugin singleton, reused across warm invocations."""
    global _plugin
    if _plugin is None:
        _plugin = AgentRuntimePlugin()
    return _plugin


def _get_llm() -> OpenRouterClient:
    """Lazily construct the OpenRouter client for the chat-turn path.

    Deliberately independent of the plugin singleton (which also builds a
    ``SignedCoreClient``): the chat turn touches neither Core nor the database, so
    it needs only the LLM boundary. Reused across warm invocations so the key is
    resolved once per container, exactly like the worker path.
    """
    global _llm
    if _llm is None:
        _llm = OpenRouterClient()
    return _llm


def _ensure_loop() -> asyncio.AbstractEventLoop:
    global _loop
    if _loop.is_closed():
        _loop = asyncio.new_event_loop()
    asyncio.set_event_loop(_loop)
    return _loop


@logger.inject_lambda_context
@tracer.capture_lambda_handler
def handler(event: dict, context: LambdaContext) -> dict:
    logger.info("Received event", extra={"event": event})

    loop = _ensure_loop()

    # ADR-0016 synchronous chat turn — a direct RequestResponse invoke from Core.
    # Returns the reply payload directly; never reaches the EventBridge path.
    if is_chat_turn(event):
        return loop.run_until_complete(run_chat_turn(event, llm=_get_llm()))

    biffo_event = create_event_handler(event)
    plugin = _get_plugin()
    loop.run_until_complete(plugin.events.dispatch(biffo_event))

    return {"statusCode": 200}
