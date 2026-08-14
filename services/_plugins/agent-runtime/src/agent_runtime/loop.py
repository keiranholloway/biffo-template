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

**Empty ``:online`` grounding does not fail the run here (issue #1528).** Now
that citations are carried faithfully (``RunOutcome.annotations``), a run whose
model was asked for ``:online`` and returned none is finally distinguishable
from one whose model simply declined to transcribe its sources — which was the
issue's whole point. It does not follow that the loop should fail such a run:
this module is shared by every worker on every model, it cannot tell an
``:online`` suffix was *requested for grounding* from one that was merely
inherited, and a genuine no-results retrieval is a legitimate outcome for an
obscure query, not necessarily a defect. Deciding "zero citations on an
``:online`` run is fatal" is exactly the domain-specific policy a caller like
`biffo-plugin-marketing` already enforces on its own guard (marketing#65) — and
after this fix it can enforce it *correctly*, reading `annotations` instead of
inferring from the model's prose. Making that the runtime's decision instead
would be a behaviour change for every existing ``:online`` caller in the estate,
imposed by the shared loop rather than chosen by each one.
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
from .tools import OutputTool, ToolDefinition, ToolError

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
# The fallback ceiling for a deployment that sets no AGENT_RUNTIME_MAX_SECONDS.
# It sits comfortably inside both LAMBDA_MAX_SECONDS and the smallest Lambda
# timeout this runtime has ever been deployed under, leaving room to POST the
# completion afterwards — a run that spends its whole invocation on the model
# and is then killed before reporting is the stranded-run failure §5 warns
# about. Deliberately *lower* than what this repo's Terraform now configures
# (`run_timeout_seconds` = 300 under a 360s Lambda): the deployment knows its
# own function timeout and this constant does not, so the unconfigured case
# stays conservative rather than tracking the configured one.
DEFAULT_TIMEOUT_CEILING = 240.0

# The share of its wall clock a run may consume before finishing is worth
# saying out loud (issue #937). A run at 98% of its limit and one at 20% both
# report "completed", so a whole class of agent drifted to one slow generation
# from failing without anything noticing. Everything above this is reported at
# warning level rather than info: the margin is the signal, not the duration.
NEAR_LIMIT_SHARE = 0.8

# How many tool calls one turn may actually run. A model can ask for arbitrarily
# many in a single message, and each is a paid outbound request whose result then
# re-enters the next turn's input tokens — so the §8 posture ("make an unbounded
# loop impossible") applies within a turn as well as across turns. Calls past the
# cap are answered with an error result rather than dropped, so the model is told
# what happened instead of inferring it from silence.
MAX_TOOL_CALLS_PER_TURN = 8

# Where a ceiling came from. Three different things bound a run's budget, and
# they are three different fixes — so a reader is told which, rather than only
# that "the limit was 240". `environment` is a deployment knob somebody set
# (Terraform's `run_timeout_seconds`/`max_turns_ceiling`); `code_default` means
# nobody set it and this module's built-in applies; `lambda_hard_cap` is AWS's
# 15-minute invocation cap, which no configuration raises.
CEILING_SOURCE_ENV = "environment"
CEILING_SOURCE_DEFAULT = "code_default"
CEILING_SOURCE_LAMBDA = "lambda_hard_cap"

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
class LimitClamp:
    """One budget the runtime granted in a reduced form, and what bound it.

    Recorded as data rather than logged here so the emitter can carry the run's
    own identifiers (``plugin.py``), and so "was this clamped?" is a plain
    assertion in a test rather than an inspection of log output.
    """

    limit: str
    requested: float
    granted: float
    ceiling: float
    source: str
    #: The environment variable that raises this ceiling — named even when it is
    #: unset, because that is precisely the lever an operator would reach for.
    #: ``None`` only for the Lambda cap, which nothing raises.
    ceiling_env: str | None

    def describe(self) -> str:
        return f"{self.limit} {self.requested:g} -> {self.granted:g} ({self._bound()})"

    def _bound(self) -> str:
        if self.source == CEILING_SOURCE_LAMBDA:
            return f"ceiling {self.ceiling:g}s is the AWS Lambda invocation cap"
        if self.source == CEILING_SOURCE_ENV:
            return f"ceiling {self.ceiling:g} set by {self.ceiling_env}"
        return f"ceiling {self.ceiling:g} is the runtime default; {self.ceiling_env} is unset"

    def as_fields(self) -> dict[str, Any]:
        """Flat, per-limit structured fields, so a log filter can target one limit."""
        return {
            f"{self.limit}_requested": self.requested,
            f"{self.limit}_granted": self.granted,
            f"{self.limit}_ceiling": self.ceiling,
            f"{self.limit}_ceiling_source": self.source,
            f"{self.limit}_ceiling_env": self.ceiling_env,
        }


@dataclass(frozen=True)
class RunLimits:
    """The hard stops for one run, resolved from its snapshot and clamped."""

    max_turns: int
    timeout_seconds: float
    #: Which of the two the deployment reduced, if either (marketing#132).
    #: Empty on the ordinary run, which is the case that must stay silent.
    clamps: tuple[LimitClamp, ...] = ()

    @classmethod
    def from_snapshot(cls, snapshot: dict[str, Any]) -> RunLimits:
        """Read ``max_turns``/``timeout_seconds`` from the definition snapshot.

        A worker chooses its own limits (§8: "per-worker ``max_turns``, token
        ceilings and wall-clock timeouts"), but only downward: both are clamped
        into the deployment's ceilings, so an edited definition can never widen
        what the runtime will spend. A missing or unparseable value falls back to
        the default rather than to "unbounded".

        **The reduction is recorded, because doing it in silence is a defect of
        its own** (biffo-plugin-marketing#132). Clamping down is right and stays;
        being unobservable is not. A worker asking for 300s and granted 240s
        produced a run indistinguishable from one that asked for 240s, so the
        cut only became visible when a run died on it — every instance of that
        class so far (marketing#126, #130, and two since) was found by a failed
        campaign rather than by the runtime that made the decision. What is
        recorded here is emitted by the caller, which knows whose budget it is.
        """
        max_turns = _positive_int(snapshot.get("max_turns"), DEFAULT_MAX_TURNS)
        timeout = _positive_float(snapshot.get("timeout_seconds"), DEFAULT_TIMEOUT_SECONDS)

        turns_ceiling, turns_source = _ceiling(
            os.environ.get(MAX_TURNS_CEILING_ENV), DEFAULT_MAX_TURNS_CEILING, int
        )
        time_ceiling, time_source = _ceiling(
            os.environ.get(TIMEOUT_CEILING_ENV), DEFAULT_TIMEOUT_CEILING, float
        )
        if float(LAMBDA_MAX_SECONDS) < time_ceiling:
            # §8's platform ceiling wins over a misconfigured deployment — and is
            # reported as itself, since no environment variable raises it.
            time_ceiling, time_source = float(LAMBDA_MAX_SECONDS), CEILING_SOURCE_LAMBDA

        granted_turns = max(1, min(max_turns, int(turns_ceiling)))
        granted_timeout = max(1.0, min(timeout, time_ceiling))
        clamps = tuple(
            clamp
            for clamp in (
                _clamp(
                    "max_turns",
                    max_turns,
                    granted_turns,
                    int(turns_ceiling),
                    turns_source,
                    MAX_TURNS_CEILING_ENV,
                ),
                _clamp(
                    "timeout_seconds",
                    timeout,
                    granted_timeout,
                    time_ceiling,
                    time_source,
                    None if time_source == CEILING_SOURCE_LAMBDA else TIMEOUT_CEILING_ENV,
                ),
            )
            if clamp is not None
        )
        return cls(
            max_turns=granted_turns,
            timeout_seconds=granted_timeout,
            clamps=clamps,
        )

    @property
    def was_clamped(self) -> bool:
        """Whether the deployment granted either limit in a reduced form."""
        return bool(self.clamps)

    def clamp_report(self) -> dict[str, Any]:
        """The reductions, as structured log fields — **empty when there were none**.

        Deliberately empty rather than ``{"budget_clamped": False}``: a line on
        every run is noise, noise gets filtered, and a filtered line reports
        nothing. The caller emits only when this is non-empty, so the presence of
        ``budget_clamped`` in the logs *is* the signal.
        """
        if not self.clamps:
            return {}
        fields: dict[str, Any] = {
            "budget_clamped": True,
            "clamped_limits": [clamp.limit for clamp in self.clamps],
            "clamp_summary": "; ".join(clamp.describe() for clamp in self.clamps),
        }
        for clamp in self.clamps:
            fields.update(clamp.as_fields())
        return fields


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
    # How much of the run's wall clock it actually used (issue #937). Carried on
    # the outcome rather than only inside the loop so the caller can report it
    # once, next to the tokens and cost it already reports.
    elapsed_seconds: float | None = None
    timeout_seconds: float | None = None
    wall_clock_share: float | None = None
    # The `:online` grounding citations OpenRouter returned, across every turn
    # (issue #1528). Accumulated rather than taken only from the last turn: a
    # multi-turn run can retrieve on more than one turn, and the whole point is
    # that this is a fact about the *run*, not an inference from its final
    # message. Always a list — empty when nothing was cited, never `None` — so
    # "we checked and found zero" reads differently from "this run predates the
    # fix" (which stays `None` on the persisted record; see `models/agent_run.py`).
    annotations: list[dict[str, Any]] = field(default_factory=list)

    @property
    def near_wall_clock_limit(self) -> bool:
        """Whether this run finished inside :data:`NEAR_LIMIT_SHARE` of its limit.

        A run that *exceeded* the limit is near it too: its share is >= 1.0.
        """
        return self.wall_clock_share is not None and self.wall_clock_share >= NEAR_LIMIT_SHARE

    def wall_clock_report(self) -> dict[str, Any]:
        """The margin, as structured log fields — empty when it is unknown."""
        if self.wall_clock_share is None:
            return {}
        return {
            "elapsed_seconds": self.elapsed_seconds,
            "timeout_seconds": self.timeout_seconds,
            "wall_clock_share": self.wall_clock_share,
            "wall_clock_pct": round(self.wall_clock_share * 100, 1),
            "near_wall_clock_limit": self.near_wall_clock_limit,
        }

    def to_completion_body(self) -> dict[str, Any]:
        """The body for ``POST /api/v1/internal/agent-runs/{id}/complete``.

        A failure reports the same way a success does — status, transcript, cost
        — because §5 requires a subscriber to distinguish "failed" from "still
        running", and because the tokens a failed run burned were still billed.

        The wall-clock margin is deliberately **not** in this body: Core's
        completion schema has no field for it, so sending it would be dropped at
        best. It is reported through the runtime's own structured logs instead
        (see :meth:`wall_clock_report`); persisting it is a Core-side change.
        """
        return {
            "status": self.status,
            "messages": list(self.messages),
            "result": self.result,
            "error": self.error,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cost_usd": self.cost_usd,
            "annotations": list(self.annotations),
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
        output_tools: Sequence[OutputTool] = (),
        goals: str | None = None,
    ) -> AsyncIterator[TurnEvent]:
        """Yield the run's turn events, ending with exactly one ``run.finished``."""
        messages = build_messages(instructions, input_payload, goals)
        offered = {tool.name: tool for tool in tools}
        # Output tools are offered to the model alongside executable tools, but the
        # loop never runs them: calling one is how the model *submits* its result
        # (see the terminal check below). They carry no executor, so they are kept
        # apart from `offered`.
        output_offered = {tool.name for tool in output_tools}
        output_by_name = {tool.name: tool for tool in output_tools}
        schemas = (
            [tool.to_provider_schema() for tool in tools]
            + [tool.to_provider_schema() for tool in output_tools]
        ) or None
        yield TurnEvent(
            RUN_STARTED,
            0,
            {
                "model": model,
                "max_turns": limits.max_turns,
                "timeout_seconds": limits.timeout_seconds,
                "tools": sorted(offered),
                "output_tools": sorted(output_offered),
            },
        )
        for message in messages:
            yield TurnEvent(MESSAGE, 0, {"message": message})

        started = self._clock()
        deadline = started + limits.timeout_seconds

        def _end(
            turn: int,
            status: str,
            *,
            result: dict[str, Any] | None = None,
            error: str | None = None,
        ) -> TurnEvent:
            """Terminate, reporting how much of the wall clock the run used."""
            return _finished(
                turn,
                status,
                result=result,
                error=error,
                elapsed=max(0.0, self._clock() - started),
                timeout_seconds=limits.timeout_seconds,
            )

        turn = 0
        while turn < limits.max_turns:
            turn += 1
            remaining = deadline - self._clock()
            if remaining <= 0:
                yield _end(
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
                yield _end(
                    turn,
                    FAILED,
                    error=(
                        f"Turn {turn} exceeded the run's remaining wall clock "
                        f"({limits.timeout_seconds:g}s total, ADR-0014 §8 hard stop)."
                    ),
                )
                return
            except LLMError as exc:
                yield _end(turn, FAILED, error=f"LLM call failed on turn {turn}: {exc}")
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
                    # This turn's `:online` citations, plain dicts (never the
                    # dataclass) so a downstream fold never needs the type. They
                    # travel no further than this event and `RunOutcome` below —
                    # never back into `messages`, so they never re-enter a prompt
                    # (see `Annotation`'s docstring in openrouter.py).
                    "annotations": [a.to_dict() for a in response.annotations],
                },
            )

            # Output tool = the model submitting its structured result (ADR-0017
            # §5). It is terminal: the arguments ARE the answer and are already in
            # the transcript (the assistant message above), so the loop does not
            # execute anything and does not go round again. Checked before the tool
            # seam so a submit call is never mistaken for an executable one; if the
            # model both submits and calls a tool in one message, submitting wins.
            submitted = _output_tool_call(response.tool_calls, output_offered)
            if submitted is not None:
                # Validate the submission against the output tool's declared schema
                # BEFORE accepting it as the terminal result. An LLM sometimes calls
                # the submit tool with required fields missing or mistyped; without
                # this the run "completes" with a payload its owner cannot parse,
                # surfacing as an opaque downstream error (a plugin 502). On a schema
                # violation, hand the errors back and let the model re-submit — one
                # more turn, bounded by max_turns like any other. Only a schema-valid
                # submission ends the run.
                schema_errors = _output_schema_errors(
                    output_by_name[submitted.name], submitted.arguments
                )
                if schema_errors is not None:
                    rejection = tool_result_message(
                        tool_call_id=submitted.id,
                        tool_name=submitted.name,
                        content=(
                            "Your submission was REJECTED — it does not satisfy the tool's "
                            f"required schema:\n{schema_errors}\n"
                            "Call the tool again with EVERY required field present and correctly "
                            "typed. Do not omit any section."
                        ),
                    )
                    messages.append(rejection)
                    yield TurnEvent(MESSAGE, turn, {"message": rejection})
                    continue
                yield _end(
                    turn,
                    COMPLETED,
                    result={
                        "output_tool": submitted.name,
                        "arguments": submitted.arguments,
                        "model": response.model,
                        "turns": turn,
                        "finish_reason": response.finish_reason,
                    },
                )
                return

            # The tool seam. Results are appended to the same array the next turn
            # replays, each one fenced and redacted on the way in (messages.py) —
            # a tool result never reaches the model as plain content.
            for result in await self._run_tools(response.tool_calls, offered):
                messages.append(result)
                yield TurnEvent(MESSAGE, turn, {"message": result})

            if not _wants_another_turn(response):
                yield _end(
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

        yield _end(
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
    # Every turn's citations, concatenated in order (issue #1528). Not
    # deduplicated by URL: a URL cited again on a later turn is itself evidence
    # the run kept finding it, and a consumer that only wants unique URLs can
    # dedupe on its own side without this fold guessing at that policy for it.
    annotations: list[dict[str, Any]] = []

    async for event in events:
        if event.kind == MESSAGE:
            messages.append(dict(event.data["message"]))
        elif event.kind == TURN_COMPLETED:
            input_tokens = _add(input_tokens, event.data.get("input_tokens"))
            output_tokens = _add(output_tokens, event.data.get("output_tokens"))
            cost_usd = _add(cost_usd, event.data.get("cost_usd"))
            annotations.extend(event.data.get("annotations") or [])
        elif event.kind == RUN_FINISHED:
            outcome.status = str(event.data.get("status"))
            outcome.result = event.data.get("result")
            outcome.error = event.data.get("error")
            outcome.elapsed_seconds = _as_optional_float(event.data.get("elapsed_seconds"))
            outcome.timeout_seconds = _as_optional_float(event.data.get("timeout_seconds"))
            outcome.wall_clock_share = _as_optional_float(event.data.get("wall_clock_share"))

    outcome.messages = messages
    outcome.input_tokens = _as_optional_int(input_tokens)
    outcome.output_tokens = _as_optional_int(output_tokens)
    outcome.cost_usd = cost_usd
    outcome.annotations = annotations
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


def _output_tool_call(calls: Sequence[ToolCall], output_tool_names: set[str]) -> ToolCall | None:
    """The first call to an offered output tool, if any — the model's submission."""
    for call in calls:
        if call.name in output_tool_names:
            return call
    return None


def _output_schema_errors(tool: OutputTool, arguments: dict[str, Any]) -> str | None:
    """Validate a submitted output-tool payload against its declared JSON Schema.

    Returns a compact, model-readable list of the violations (path + message), or
    ``None`` when the payload is valid. This is what lets the loop reject an
    incomplete submission and let the model fix it, instead of terminating the run
    with a result its owner cannot use."""
    from jsonschema import Draft202012Validator

    errors = sorted(
        Draft202012Validator(tool.parameters).iter_errors(arguments),
        key=lambda e: list(e.path),
    )
    if not errors:
        return None
    lines = []
    for err in errors[:12]:  # bound the feedback; the first dozen are plenty to fix
        location = ".".join(str(p) for p in err.path) or "(root)"
        lines.append(f"- {location}: {err.message}")
    return "\n".join(lines)


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
    elapsed: float,
    timeout_seconds: float,
) -> TurnEvent:
    """The single terminal event, carrying the run's wall-clock margin (#937).

    Every way out of the loop comes through here — success, a blown limit, a
    provider outage — so the margin is reported for *all* of them rather than
    only the ones somebody remembered to instrument. ``wall_clock_share`` is the
    number that matters: the same 100 seconds is comfortable against a 240s
    limit and one bad generation away from failing against a 120s one.
    """
    share = elapsed / timeout_seconds if timeout_seconds > 0 else None
    return TurnEvent(
        RUN_FINISHED,
        turn,
        {
            "status": status,
            "result": result,
            "error": error,
            "elapsed_seconds": round(elapsed, 3),
            "timeout_seconds": timeout_seconds,
            "wall_clock_share": None if share is None else round(share, 4),
        },
    )


def _add(total: float | None, value: Any) -> float | None:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return total
    return value if total is None else total + value


def _as_optional_int(value: float | None) -> int | None:
    return None if value is None else int(value)


def _as_optional_float(value: Any) -> float | None:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    return float(value)


def _ceiling(raw: str | None, default: float, cast: Callable[[Any], Any]) -> tuple[float, str]:
    """Resolve a deployment ceiling, and say where the value came from.

    An environment variable that is absent, unparseable or non-positive is not a
    ceiling — the built-in default applies — and the source says which happened.
    "Nobody configured this" and "somebody configured it to exactly this" reduce
    a budget identically and are fixed differently, so the distinction has to
    survive as far as the log line.
    """
    if raw is not None:
        try:
            parsed = cast(raw)
        except (TypeError, ValueError):
            parsed = None
        if parsed is not None and parsed > 0:
            return float(parsed), CEILING_SOURCE_ENV
    return float(default), CEILING_SOURCE_DEFAULT


def _clamp(
    limit: str,
    requested: float,
    granted: float,
    ceiling: float,
    source: str,
    ceiling_env: str | None,
) -> LimitClamp | None:
    """Record the reduction — or ``None`` when the run got everything it asked for."""
    if granted >= requested:
        return None
    return LimitClamp(
        limit=limit,
        requested=requested,
        granted=granted,
        ceiling=ceiling,
        source=source,
        ceiling_env=ceiling_env,
    )


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
