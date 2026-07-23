"""Request/response schemas for the prompt-assistant chat endpoint (ADR-0016).

The user-facing surface of the synchronous chat spine: an authenticated (admin)
author sends a message and, optionally, the ``thread_id`` of an ongoing chat; Core
runs the turn and returns the assistant's buffered reply plus the thread/run ids.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class AgentChatRequest(BaseModel):
    """One turn from the author.

    ``thread_id`` is omitted for a new chat (Core mints one) and echoed back to
    continue an existing one — a thread is a sequence of runs sharing it
    (ADR-0016 §2). ``message`` is the author's text; it is treated as untrusted
    content and fenced before it reaches the model (ADR-0014 §5 / ADR-0016 §7).
    """

    message: str = Field(min_length=1, max_length=16_000)
    thread_id: str | None = Field(default=None, max_length=36)


class AgentChatResponse(BaseModel):
    """The assistant's reply to one turn, plus the ids to continue the thread."""

    thread_id: str
    run_id: str
    reply: str
    model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
