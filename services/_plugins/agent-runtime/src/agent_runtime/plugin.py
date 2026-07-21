"""AgentRuntimePlugin — the execution half of the agent framework (ADR-0014 §1).

The framework is first-party platform capability split across three homes:
definitions and runs live in Core, the authoring UI in the portal, and *this* —
"the execution runtime (LLM loop, tool calls)" — in ``services/_plugins/``,
template-owned and distributed by ``biffo core upgrade``.

One flow, entirely event-driven (§4: "There is no synchronous invocation path"):

    agent.run.requested (EventBridge)
      -> claim the run     GET  /api/v1/internal/agent-runs/{id}
      -> one turn loop     OpenRouter, model from the run's definition_snapshot
      -> report            POST /api/v1/internal/agent-runs/{id}/complete
                           Core persists and emits agent.run.completed

This plugin owns **no data** (ADR-0002): no tables, no API routes, no database
client. Every piece of run state is Core's, reached over the IAM-signed internal
API (ADR-0009) via ``SignedCoreClient``.

**Nothing terminal is silent.** Every path out of ``process_event`` that has
claimed a run ends in a completion POST — a bad definition, a provider outage, a
blown limit, an unexpected exception. §5 requires a subscriber to tell "failed"
from "still running", and ADR-0014 records a silently abandoned run as an open
stranding gap; this does not add to it. The one case that remains uncovered is
the POST itself failing (§5's "second divergence point"), which is logged at
error level so it can be alarmed on rather than lost.
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
_AGENT_RUNS_PATH = "/api/v1/internal/agent-runs"

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

    async def _claim(self, run_id: str) -> dict[str, Any] | None:
        """Fetch the run and check it is ours to execute.

        The event carries only a reference (§5), so the definition and input are
        read here. A run that is not ``pending`` — a replayed delivery, or one
        another invocation already finished — is skipped rather than re-executed:
        every re-execution is a second invoice for the same work.
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
        return run

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
