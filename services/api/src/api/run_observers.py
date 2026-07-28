"""Observers notified when a workflow run reaches its outcome.

The orchestration engine sends; Core records the outcome to ``ActionLog``. That
audit trail is keyed to a run and scoped to a tenant, which is the right shape
for "what did the engine do" and the wrong one for "what happened to *this*
customer record" — nothing joins a run back to the domain row its trigger was
about, so a product can send a thousand messages and still be unable to show
one of them on the record it concerned.

This is the seam that closes that gap without the template learning any domain
vocabulary. Core already holds everything needed at ``record_result`` time: the
run, its ``trigger_event`` (the whole triggering payload), and the action's
outcome. An instance registers an observer, reads whatever its own events carry,
and writes whatever its own schema calls for::

    # in an instance's own domain package
    async def _record_activity(ctx: RunOutcome, db: AsyncSession) -> None:
        lead_id = ctx.trigger_payload.get("lead_id")
        if lead_id and ctx.action_type in {"email", "whatsapp"}:
            db.add(LeadActivity(lead_id=lead_id, ...))

    register_run_outcome_observer(_record_activity)

Deliberately mirrors ``writeback_targets.register_writeback_target``: the
template owns the mechanism, the instance owns the meaning. The alternative —
an opt-in flag on each action config — was rejected because it makes the record
depend on an author remembering a checkbox, and gives nothing to the automations
already running.

**Observers must not break the request.** A run's outcome has already happened
by the time they are called; an observer that raises would turn a successful
send into a 500 and, worse, invite the engine to retry a message that was
already delivered. Failures are logged and swallowed for that reason. An
observer that needs to guarantee its write should assert on it in its own tests,
not lean on this call site to surface a fault.
"""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from aws_lambda_powertools import Logger

if TYPE_CHECKING:  # pragma: no cover - typing only
    from sqlalchemy.ext.asyncio import AsyncSession

    from .models.orchestration import WorkflowRun

logger = Logger(child=True)


@dataclass(frozen=True)
class RunOutcome:
    """What an observer is told about a finished run.

    ``trigger_payload`` is the ``payload`` of the event that caused the run —
    the part an instance's own event contract defines, already unwrapped from
    the ``BiffoEvent`` envelope so an observer never has to know that shape.
    """

    run: WorkflowRun
    action_type: str
    status: str
    trigger_event: dict[str, Any]
    request: dict[str, Any] | None
    response: dict[str, Any] | None
    error: str | None

    @property
    def trigger_payload(self) -> dict[str, Any]:
        """The triggering event's payload, or ``{}`` when it carries none."""
        payload = self.trigger_event.get("payload")
        return payload if isinstance(payload, dict) else {}

    @property
    def succeeded(self) -> bool:
        return self.status == "succeeded"


#: An observer may be sync or async; both are supported, as with action handlers.
RunOutcomeObserver = Callable[[RunOutcome, "AsyncSession"], Awaitable[None] | None]

_observers: list[RunOutcomeObserver] = []


def register_run_outcome_observer(observer: RunOutcomeObserver) -> RunOutcomeObserver:
    """Declare an observer called after a run's outcome is recorded.

    Returns the observer so it can be used as a decorator. Registration order is
    preserved; observers are independent and one failing does not skip the rest.
    """
    _observers.append(observer)
    return observer


def registered_run_outcome_observers() -> tuple[RunOutcomeObserver, ...]:
    """The observers declared so far (introspection/tests)."""
    return tuple(_observers)


def clear_run_outcome_observers() -> None:
    """Drop every registered observer — test isolation only."""
    _observers.clear()


async def notify_run_outcome(outcome: RunOutcome, db: AsyncSession) -> None:
    """Call every observer, swallowing and logging any failure.

    Runs in the same transaction as the ``ActionLog`` write, so an observer's
    row commits with it — which is what makes "the send is recorded" atomic with
    "the send happened" rather than a second, separately-failing step.
    """
    for observer in _observers:
        try:
            result = observer(outcome, db)
            if inspect.isawaitable(result):
                await result
        except Exception:  # noqa: BLE001 — an observer must never fail the run
            logger.exception(
                "Run-outcome observer failed; the run itself is unaffected.",
                extra={
                    "run_id": outcome.run.id,
                    "action_type": outcome.action_type,
                    "observer": getattr(observer, "__qualname__", repr(observer)),
                },
            )
