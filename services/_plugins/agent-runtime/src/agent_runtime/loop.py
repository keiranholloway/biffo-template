"""The turn loop (ADR-0014 §6.3, §7, §8).

M1 was a walking skeleton: one model call, no tools, no memory. M3 fills the tool
seam the ``while`` loop was built around — the control flow is unchanged, and
that was the point. The *shape* is not provisional, because §6 lists the choices
that are cheap now and expensive later. Two of them live here.

**The loop is internally incremental.** ``AgentLoop.stream`` is an async
generator that yields a :class:`TurnEvent` per step — the opening messages, each
turn's start, each assistant message, each turn's usage, and the terminal event.
The only consumer today is :func:`collect`, which folds them into one
:class:`RunOutcome` for the completion POST. §6.3 is explicit about why: "if it
returns one final string, adding streaming later means rewriting the core loop."
Streaming becomes a second consumer of this same generator.

**``max_turns > 1`` is a config change, not a rewrite.** The loop is a bounded
``while`` over turns that appends to a persistent message array and asks after
each turn whether the model wants another. Tool execution slots in between the
assistant message and the next turn: the model asks, the loop runs what it asked
for, appends the results, and goes round again. Nothing about "one turn" was ever
baked into the control flow, which is why M3 adds a branch rather than a rewrite.

**A worker only ever gets the tools it declared** (§7). The loop executes from a
resolved list handed to it, never from the registry — so a model naming a tool
that was not offered gets an error result, not the tool. The list is resolved
before the run starts (``plugin.py``), because a run that has already spent money
is the wrong place to discover a definition is wrong.

**Both limits are hard stops (§8), enforced here rather than by convention.**
``max_turns`` bounds iterations; a wall-clock deadline bounds elapsed time and is
re-checked before every turn *and* applied to the in-flight provider call. Hitting
either is a terminal **failure**, not a truncated success: a subscriber must be
able to tell a finished run from a curtailed one (§5), and the transcript
collected so far still travels with it. Tools make this live rather than
theoretical: a model that keeps calling tools is exactly the unbounded loop §8
says must be impossible by construction.
"""

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import AsyncIterator, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from .messages import Message, assistant_message, build_messages, tool_result_message
from .openrouter import LLMClient, LLMError, LLMResponse, ToolCall
from .state import COMPLETED, FAILED
from .tools import ToolDefinition, ToolError

# The platform ceiling §8 names: "A Lambda invocation is capped at 15 minutes, so
# a multi-turn loop must either finish inside one invocation or be resumable
# across several." A per-worker wall clock must therefore sit inside this, not
# merely inside a cost budget — so every configured limit is clamped below it.
LAMBDA_MAX_SECONDS = 900

# Runtime ceilings, overridable per deployment. Deliberately generous rather than
# rationing: §8's posture is "make an unbounded loop impossible", not "meter
# ordinary use", while the platform is single-operator.
DEFAULT_MAX_TURNS = 1
MAX_TURNS_CEILING_ENV = "AGENT_RUNTIME_MAX_TURNS"
DEFAULT_MAX_TURNS_CEILING = 10

DEFAULT_TIMEOUT_SECONDS = 120.0
TIMEOUT_CEILING_ENV = "AGENT_RUNTIME_MAX_SECONDS"
# Sits comfortably inside both LAMBDA_MAX_SECONDS and the Lambda timeout
# Terraform configures (300s), leaving room to POST the completion afterwards —
# a run that spends its whole invocation on the model and is then killed before
# reporting is the stranded-run failure §5 warns about.
DEFAULT_TIMEOUT_CEILING = 240.0

# How many tool calls one turn may actually run. A model can ask for arbitrarily
# many in a single message, and each is a paid outbound request whose result then
# re-enters the next turn's input tokens — so the §8 posture ("make an unbounded
# loop impossible") applies within a turn as well as across turns. Calls past the
# cap are answered with an error result rather than dropped, so the model is told
# what happened instead of inferring it from silence.
MAX_TOOL_CALLS_PER_TURN = 8

# Event kinds yielded by the loop.
RUN_STARTED = "run.started"
TURN_STARTED = "turn.started"
MESSAGE = "message"
TURN_COMPLETED = "turn.completed"
RUN_FINISHED = "run.finished"


@dataclass(frozen=True)
class TurnEvent:
    """One step of a run, as it happens."""

    kind: str
    turn: int
    data: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class RunLimits:
    """The hard stops for one run, resolved from its snapshot and clamped."""

    max_turns: int
    timeout_seconds: float

    @classmethod
    def from_snapshot(cls, snapshot: dict[str, Any]) -> RunLimits:
        """Read ``max_turns``/``timeout_seconds`` from the definition snapshot.

        A worker chooses its own limits (§8: "per-worker ``max_turns``, token
        ceilings and wall-clock timeouts"), but only downward: both are clamped
        into the deployment's ceilings, so an edited definition can never widen
        what the runtime will spend. A missing or unparseable value falls back to
        the default rather than to "unbounded".
        """
        max_turns = _positive_int(snapshot.get("max_turns"), DEFAULT_MAX_TURNS)
        timeout = _positive_float(snapshot.get("timeout_seconds"), DEFAULT_TIMEOUT_SECONDS)

        turns_ceiling = _positive_int(
            os.environ.get(MAX_TURNS_CEILING_ENV), DEFAULT_MAX_TURNS_CEILING
        )
        time_ceiling = min(
            _positive_float(os.environ.get(TIMEOUT_CEILING_ENV), DEFAULT_TIMEOUT_CEILING),
            float(LAMBDA_MAX_SECONDS),
        )
        return cls(
            max_turns=max(1, min(max_turns, turns_ceiling)),
            timeout_seconds=max(1.0, min(timeout, time_ceiling)),
        )


@dataclass
class RunOutcome:
    """What the runtime reports to Core — the terminal state of one run."""

    status: str
    messages: list[Message] = field(default_factory=list)
    result: dict[str, Any] | None = None
    error: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None

    def to_completion_body(self) -> dict[str, Any]:
        """The body for ``POST /api/v1/internal/agent-runs/{id}/complete``.

        A failure reports the same way a success does — status, transcript, cost
        — because §5 requires a subscriber to distinguish "failed" from "still
        running", and because the tokens a failed run burned were still billed.
        """
        return {
            "status": self.status,
            "messages": list(self.messages),
            "result": self.result,
            "error": self.error,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cost_usd": self.cost_usd,
        }


def failure(error: str, messages: list[Message] | None = None) -> RunOutcome:
    """A terminal failure outcome — the only way this runtime ever gives up."""
    return RunOutcome(status=FAILED, messages=list(messages or []), error=error)


class AgentLoop:
    """Runs one agent run's turns, emitting a :class:`TurnEvent` per step."""

    def __init__(self, llm: LLMClient, *, clock: Callable[[], float] = time.monotonic) -> None:
        self._llm = llm
        # Injectable so the wall-clock hard stop is testable without sleeping.
        self._clock = clock

    async def stream(
        self,
        *,
        model: str,
        instructions: str,
        input_payload: dict[str, Any],
        limits: RunLimits,
        tools: Sequence[ToolDefinition] = (),
    ) -> AsyncIterator[TurnEvent]:
        """Yield the run's turn events, ending with exactly one ``run.finished``."""
        messages = build_messages(instructions, input_payload)
        offered = {tool.name: tool for tool in tools}
        schemas = [tool.to_provider_schema() for tool in tools] or None
        yield TurnEvent(
            RUN_STARTED,
            0,
            {
                "model": model,
                "max_turns": limits.max_turns,
                "timeout_seconds": limits.timeout_seconds,
                "tools": sorted(offered),
            },
        )
        for message in messages:
            yield TurnEvent(MESSAGE, 0, {"message": message})

        deadline = self._clock() + limits.timeout_seconds
        turn = 0
        while turn < limits.max_turns:
            turn += 1
            remaining = deadline - self._clock()
            if remaining <= 0:
                yield _finished(
                    turn,
                    FAILED,
                    error=(
                        f"Wall-clock limit of {limits.timeout_seconds:g}s reached "
                        f"before turn {turn} (ADR-0014 §8 hard stop)."
                    ),
                )
                return

            yield TurnEvent(TURN_STARTED, turn, {"remaining_seconds": remaining})
            try:
                response = await asyncio.wait_for(
                    self._llm.complete(
                        model=model,
                        messages=list(messages),
                        timeout=remaining,
                        tools=schemas,
                    ),
                    timeout=remaining,
                )
            except TimeoutError:
                yield _finished(
                    turn,
                    FAILED,
                    error=(
                        f"Turn {turn} exceeded the run's remaining wall clock "
                        f"({limits.timeout_seconds:g}s total, ADR-0014 §8 hard stop)."
                    ),
                )
                return
            except LLMError as exc:
                yield _finished(turn, FAILED, error=f"LLM call failed on turn {turn}: {exc}")
                return

            message = assistant_message(
                response.content, [call.to_wire() for call in response.tool_calls]
            )
            messages.append(message)
            yield TurnEvent(MESSAGE, turn, {"message": message})
            yield TurnEvent(
                TURN_COMPLETED,
                turn,
                {
                    "finish_reason": response.finish_reason,
                    "model": response.model,
                    "input_tokens": response.input_tokens,
                    "output_tokens": response.output_tokens,
                    "cost_usd": response.cost_usd,
                    "tool_calls": [call.name for call in response.tool_calls],
                },
            )

            # The tool seam. Results are appended to the same array the next turn
            # replays, each one fenced and redacted on the way in (messages.py) —
            # a tool result never reaches the model as plain content.
            for result in await self._run_tools(response.tool_calls, offered):
                messages.append(result)
                yield TurnEvent(MESSAGE, turn, {"message": result})

            if not _wants_another_turn(response):
                yield _finished(
                    turn,
                    COMPLETED,
                    result={
                        "output": response.content,
                        "model": response.model,
                        "turns": turn,
                        "finish_reason": response.finish_reason,
                    },
                )
                return

        yield _finished(
            turn,
            FAILED,
            error=(
                f"Run stopped after {limits.max_turns} turn(s) without finishing "
                "(ADR-0014 §8 max_turns hard stop)."
            ),
        )

    async def _run_tools(
        self,
        calls: Sequence[ToolCall],
        offered: dict[str, ToolDefinition],
    ) -> list[Message]:
        """Execute the model's tool calls, in order, into fenced result messages.

        Sequential rather than concurrent: a transcript that replays in the order
        things happened is worth more here than the latency, and the run's wall
        clock already bounds the total.

        **Nothing raises out of here.** Every failure — an unoffered tool, bad
        arguments, a provider outage inside a tool — becomes a result the model
        can read. A search that fails should degrade an enrichment, not end it,
        and the alternative (a terminal failure per tool hiccup) would make tools
        a liability rather than a capability. The one thing that is *not*
        forgiving is a tool the worker never declared: it is answered with an
        error naming what was actually offered, and it can never execute.
        """
        results: list[Message] = []
        for index, call in enumerate(calls):
            if index >= MAX_TOOL_CALLS_PER_TURN:
                content = (
                    f"Not run: this turn already used its limit of "
                    f"{MAX_TOOL_CALLS_PER_TURN} tool calls. Ask for fewer at a time."
                )
            else:
                content = await _execute_call(call, offered)
            results.append(
                tool_result_message(tool_call_id=call.id, tool_name=call.name, content=content)
            )
        return results


async def collect(events: AsyncIterator[TurnEvent]) -> RunOutcome:
    """Fold a turn-event stream into one :class:`RunOutcome`.

    The *only* consumer in M1, and deliberately a separate function rather than
    logic inside the loop: a streaming consumer (§6.3) is a sibling of this, not
    a change to :meth:`AgentLoop.stream`.
    """
    outcome = RunOutcome(status=FAILED, error="Loop produced no terminal event.")
    messages: list[Message] = []
    # Accumulated as floats and narrowed on the way out: token counts are
    # integers, but the folding helper is shared with the cost total.
    input_tokens: float | None = None
    output_tokens: float | None = None
    cost_usd: float | None = None

    async for event in events:
        if event.kind == MESSAGE:
            messages.append(dict(event.data["message"]))
        elif event.kind == TURN_COMPLETED:
            input_tokens = _add(input_tokens, event.data.get("input_tokens"))
            output_tokens = _add(output_tokens, event.data.get("output_tokens"))
            cost_usd = _add(cost_usd, event.data.get("cost_usd"))
        elif event.kind == RUN_FINISHED:
            outcome.status = str(event.data.get("status"))
            outcome.result = event.data.get("result")
            outcome.error = event.data.get("error")

    outcome.messages = messages
    outcome.input_tokens = _as_optional_int(input_tokens)
    outcome.output_tokens = _as_optional_int(output_tokens)
    outcome.cost_usd = cost_usd
    return outcome


async def _execute_call(call: ToolCall, offered: dict[str, ToolDefinition]) -> str:
    """Run one tool call, returning the text the model gets back."""
    tool = offered.get(call.name)
    if tool is None:
        # Either the model invented a name, or it named a registered tool this
        # worker did not declare. Both are the same answer: it is not available
        # here (§7 — the declaration is the ceiling, not the registry).
        return (
            f"No tool named {call.name!r} is available to this worker. "
            f"Available: {sorted(offered) or 'none'}."
        )
    try:
        arguments = tool.coerce_arguments(call.arguments)
        return await tool.execute(arguments)
    except ToolError as exc:
        return f"Tool {call.name} could not run: {exc}"
    except Exception as exc:  # noqa: BLE001 — a failing tool degrades a run, never ends it
        return f"Tool {call.name} failed: {exc}"


def _wants_another_turn(response: LLMResponse) -> bool:
    """Whether the model asked for work the loop must do before answering.

    ``tool_calls`` is the provider's signal that the assistant wants a tool run,
    and the loop has by now appended a result for each. Deliberately keyed on
    ``finish_reason`` rather than on "were there parsed calls": a provider that
    says it wants tools but sends nothing usable must not read as a finished
    answer with empty content. It goes round again and, finding nothing new,
    terminates on the ``max_turns`` hard stop — bounded, and visible in the
    transcript as what it was.
    """
    return response.finish_reason == "tool_calls"


def _finished(
    turn: int,
    status: str,
    *,
    result: dict[str, Any] | None = None,
    error: str | None = None,
) -> TurnEvent:
    return TurnEvent(RUN_FINISHED, turn, {"status": status, "result": result, "error": error})


def _add(total: float | None, value: Any) -> float | None:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return total
    return value if total is None else total + value


def _as_optional_int(value: float | None) -> int | None:
    return None if value is None else int(value)


def _positive_int(value: Any, fallback: int) -> int:
    try:
        parsed = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed > 0 else fallback


def _positive_float(value: Any, fallback: float) -> float:
    try:
        parsed = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed > 0 else fallback
