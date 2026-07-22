"""AgentRuntimePlugin — the execution half of the agent framework (ADR-0014 §1).

The framework is first-party platform capability split across three homes:
definitions and runs live in Core, the authoring UI in the portal, and *this* —
"the execution runtime (LLM loop, tool calls)" — in ``services/_plugins/``,
template-owned and distributed by ``biffo core upgrade``.

Two triggers, both EventBridge — there is no synchronous invocation path (§4).
The execution flow:

    agent.run.requested (EventBridge)
      -> read the run      GET  /api/v1/internal/agent-runs/{id}
      -> claim it          POST /api/v1/internal/agent-runs/{id}/claim
                           409 => another invocation owns it; stop, spend nothing
      -> one turn loop     OpenRouter, model from the run's definition_snapshot
      -> report            POST /api/v1/internal/agent-runs/{id}/complete
                           Core persists and emits agent.run.completed

    agent.runs.reap_due (this plugin's own schedule, terraform/)
      -> sweep             POST /api/v1/internal/agent-runs/reap
                           Core fails runs a dead invocation left in `running`
                           and emits their completion (§5, issue #402)

The claim is what makes at-least-once delivery affordable. EventBridge can
deliver the same event twice; without a claim both invocations read ``pending``,
both call the provider, and both are billed (issue #371). The claim is a single
conditional UPDATE in Core, so exactly one invocation proceeds.

This plugin owns **no data** (ADR-0002): no tables, no API routes, no database
client. Every piece of run state is Core's, reached over the IAM-signed internal
API (ADR-0009) via ``SignedCoreClient``.

**Nothing terminal is silent.** Every path out of ``process_event`` that has
claimed a run ends in a completion POST — a bad definition, a provider outage, a
blown limit, an unexpected exception. §5 requires a subscriber to tell "failed"
from "still running", and ADR-0014 records a silently abandoned run as an open
stranding gap; this does not add to it.

The completion POST itself failing (§5's "second divergence point") is still not
*recovered* — the model work is paid for and its result is lost — but it is no
longer silent: the run stays ``running``, the sweep eventually fails it, and
whatever was waiting is released. Logged at error level so the lost result can
still be alarmed on.
"""

from __future__ import annotations

from typing import Any

from aws_lambda_powertools import Logger
from biffo_plugin_sdk import (
    BiffoAPIClient,
    BiffoAPIError,
    BiffoEvent,
    BiffoPluginBase,
    SignedCoreClient,
    load_manifest,
)

from .loop import AgentLoop, RunLimits, RunOutcome, collect, failure
from .manifest import MANIFEST_PATH
from .openrouter import LLMClient, OpenRouterClient
from .state import PENDING, RunState, RunStateError

logger = Logger()

AGENT_RUN_REQUESTED = "agent.run.requested"
# Synthesised by this plugin's own scheduled EventBridge rule (terraform/), not
# emitted by Core — hence its own source. It carries no payload: the sweep's
# subject is "whatever is stale now", which only Core can know (issue #402).
AGENT_RUNS_REAP_DUE = "agent.runs.reap_due"
AGENT_RUNTIME_SOURCE = "biffo.agent-runtime"
_AGENT_RUNS_PATH = "/api/v1/internal/agent-runs"

# Core answers a claim for a run someone else already owns with 409 (ADR-0014
# §5). Named rather than inlined: treating it as an ordinary error would make a
# duplicate delivery look like an outage, and treating an outage as a lost claim
# would silently drop runs.
_CLAIM_CONFLICT = 409

# Error text is stored on the run record and rendered in the run inspector; cap
# it so a provider dumping an HTML error page cannot dominate the row.
_MAX_ERROR_CHARS = 2000


class AgentRuntimePlugin(BiffoPluginBase):
    """Executes agent runs requested on the bus."""

    def __init__(
        self,
        api: BiffoAPIClient | None = None,
        llm: LLMClient | None = None,
        loop: AgentLoop | None = None,
    ) -> None:
        manifest = load_manifest(MANIFEST_PATH)
        super().__init__(manifest, api=api if api is not None else SignedCoreClient())
        self._llm = llm if llm is not None else OpenRouterClient()
        self._loop = loop if loop is not None else AgentLoop(self._llm)

        @self.subscribe(AGENT_RUN_REQUESTED)
        async def _on_run_requested(event: BiffoEvent) -> None:
            await self.process_event(event)

        @self.subscribe(AGENT_RUNS_REAP_DUE, source=AGENT_RUNTIME_SOURCE)
        async def _on_reap_due(event: BiffoEvent) -> None:
            await self.reap_stale_runs()

    def on_install(self) -> None:
        """No-op: this plugin declares no tables and seeds nothing. Workers are
        rows in Core authored through the portal (§2), not install-time data."""
        return None

    def on_uninstall(self) -> None:
        return None

    async def process_event(self, event: BiffoEvent) -> None:
        """Claim, execute and report one requested run."""
        run_id = event.payload.get("run_id")
        if not run_id:
            logger.warning("agent.run.requested carried no run_id", extra={"event": event.payload})
            return

        run = await self._claim(str(run_id))
        if run is None:
            return

        state = RunState(str(run_id), PENDING)
        state.transition_to("running")
        outcome = await self._execute(run)
        try:
            state.transition_to(outcome.status)
        except RunStateError:  # pragma: no cover — the loop only ever terminates
            logger.exception("Agent run produced an illegal terminal state")
        await self._report(str(run_id), outcome)

    async def reap_stale_runs(self) -> None:
        """Ask Core to fail runs a dead runtime left in ``running`` (§5, #402).

        All the work is Core's: it owns the runs, the clock and the threshold,
        and it emits the completion events. This is only the schedule tick — the
        plugin holds no state and makes no decision about what is stale.

        A failure here is logged and swallowed. The sweep runs again on the next
        tick, so one missed pass costs nothing, whereas raising would fail the
        Lambda invocation and produce an EventBridge retry storm against a Core
        that is already unwell.
        """
        try:
            reaped = await self.api.post(f"{_AGENT_RUNS_PATH}/reap", json={})
        except BiffoAPIError:
            logger.exception("Stale-run sweep failed; will retry on the next schedule")
            return

        count = len(reaped) if isinstance(reaped, list) else 0
        if count:
            logger.warning("Reaped stale agent runs", extra={"count": count})

    async def _claim(self, run_id: str) -> dict[str, Any] | None:
        """Take ownership of the run in Core, or give it up.

        The event carries only a reference (§5), so the definition and input are
        read here. The **claim POST is what makes this safe**: it is a single
        conditional UPDATE in Core, so of N concurrent deliveries of the same
        ``agent.run.requested`` exactly one wins and the rest get 409.

        The read below is a cheap pre-check, not the guard. It skips the obvious
        replay without a write, but it cannot resolve a race — two invocations
        arriving together both see ``pending``. Only the claim decides, and it
        happens before the first model call, so a loser exits having spent
        nothing (issue #371).
        """
        try:
            run = await self.api.get(f"{_AGENT_RUNS_PATH}/{run_id}")
        except BiffoAPIError:
            # Nothing can be reported: completing a run we could not read would
            # be guessing at which run to fail.
            logger.exception("Could not read agent run", extra={"run_id": run_id})
            return None

        if not isinstance(run, dict):
            logger.error("Agent run response was not an object", extra={"run_id": run_id})
            return None

        status = str(run.get("status") or "")
        try:
            state = RunState(run_id, status)
        except RunStateError:
            logger.error(
                "Agent run has an unrecognised status", extra={"run_id": run_id, "status": status}
            )
            return None
        if not state.is_claimable:
            logger.info(
                "Skipping agent run that is not pending",
                extra={"run_id": run_id, "status": status},
            )
            return None

        try:
            claimed = await self.api.post(f"{_AGENT_RUNS_PATH}/{run_id}/claim", json={})
        except BiffoAPIError as exc:
            if exc.status_code == _CLAIM_CONFLICT:
                # Another invocation owns it. Exit silently and, above all,
                # WITHOUT calling the model — this is the whole point.
                logger.info(
                    "Agent run already claimed by another invocation; not executing",
                    extra={"run_id": run_id},
                )
            else:
                # Could not claim for some other reason. Do not execute: an
                # unclaimed run is one a duplicate delivery can still pick up,
                # and running anyway would reinstate the double-spend.
                logger.exception("Could not claim agent run", extra={"run_id": run_id})
            return None

        # Prefer Core's post-claim record — it is the authority on what this run
        # is, and it now carries `running` and `started_at`. Falling back to the
        # pre-claim read keeps a Core that returns something unexpected from
        # stranding a run this invocation legitimately owns.
        return claimed if isinstance(claimed, dict) else run

    async def _execute(self, run: dict[str, Any]) -> RunOutcome:
        """Run the turn loop. Returns an outcome; never raises."""
        snapshot = run.get("definition_snapshot") or {}
        instructions = str(snapshot.get("instructions") or "").strip()
        model = str(snapshot.get("model") or "").strip()
        if not instructions:
            return failure("definition_snapshot carries no instructions for this run.")
        if not model:
            return failure("definition_snapshot names no model for this run.")

        payload = run.get("input_payload") or {}
        limits = RunLimits.from_snapshot(snapshot)
        try:
            return await collect(
                self._loop.stream(
                    model=model,
                    instructions=instructions,
                    input_payload=payload if isinstance(payload, dict) else {"input": payload},
                    limits=limits,
                )
            )
        except Exception as exc:  # noqa: BLE001 — an abandoned run is worse than a failed one
            logger.exception("Agent run raised", extra={"run_id": run.get("id")})
            return failure(f"Agent runtime error: {exc}")

    async def _report(self, run_id: str, outcome: RunOutcome) -> None:
        """POST the terminal report. Core persists it and emits the event (§5)."""
        body = outcome.to_completion_body()
        if body.get("error"):
            body["error"] = str(body["error"])[:_MAX_ERROR_CHARS]
        try:
            await self.api.post(f"{_AGENT_RUNS_PATH}/{run_id}/complete", json=body)
        except BiffoAPIError:
            # ADR-0014 §5's second divergence point: the model work is already
            # paid for and Core holds no result, so the run sits un-terminated.
            # Logged at error level precisely so it can be alarmed on — a
            # completion retry or a stale-run reaper is the real fix.
            logger.exception(
                "Agent run completed but could not be recorded — run is stranded",
                extra={"run_id": run_id, "status": outcome.status},
            )
