"""The agent run state machine (ADR-0014 §6).

A run's ``status`` is an explicit state machine — ``pending -> running ->
completed | failed`` — not an incidental string. §6 keeps it explicit from the
first commit because it is also what makes a multi-turn loop resumable across
Lambda invocations (§8): a runtime that can say which state a run is in can pick
one up again; one that cannot must restart it and pay for the tokens twice.

This module is the transition table plus the claim guard. Two rules:

- A run is executable only from ``pending``. Anything else — a duplicate
  EventBridge delivery, a replay, a completion that already landed — is refused
  rather than re-executed, because re-execution has an invoice attached.
- ``completed`` and ``failed`` are terminal. Core enforces the same thing on the
  completion route (``RunAlreadyTerminalError``); this is the local half, which
  stops the runtime doing the model work before Core ever refuses to record it.

**This module is the local half only.** The transition table below validates a
run's lifecycle *within one invocation*; it cannot arbitrate between two. The
authority is Core's ``POST /agent-runs/{id}/claim`` — a single conditional
UPDATE — which the runtime calls before the first model call. Of N concurrent
deliveries exactly one gets a 200; the rest get 409 and exit having spent
nothing (issue #371).

That ordering is the point. The check here runs against a *read*, so two
invocations arriving together both see ``pending`` and both would proceed; only
the claim resolves it, and only because it happens before any tokens are bought.

A runtime killed *after* claiming leaves the row ``running`` with a
``started_at`` rather than stranded in ``pending``, which is what makes it
findable: "running for longer than the ceiling" is a query, where "pending for
ever" is indistinguishable from "never picked up". Core'''s scheduled sweep
(``POST /agent-runs/reap``, issue #402) fails those runs and emits their
completion, so nothing waits on them for ever. What it cannot recover is the
run'''s *result* or its token spend — both died with the invocation.
"""

from __future__ import annotations

PENDING = "pending"
RUNNING = "running"
COMPLETED = "completed"
FAILED = "failed"

STATUSES: tuple[str, ...] = (PENDING, RUNNING, COMPLETED, FAILED)
TERMINAL_STATUSES: tuple[str, ...] = (COMPLETED, FAILED)

# The whole transition table. Terminal states have no outgoing edges.
ALLOWED_TRANSITIONS: dict[str, frozenset[str]] = {
    PENDING: frozenset({RUNNING, FAILED}),
    RUNNING: frozenset({COMPLETED, FAILED}),
    COMPLETED: frozenset(),
    FAILED: frozenset(),
}


class RunStateError(Exception):
    """An illegal state transition was attempted for a run."""

    def __init__(self, run_id: str, current: str, target: str) -> None:
        self.run_id = run_id
        self.current = current
        self.target = target
        super().__init__(
            f"Agent run {run_id} cannot move from {current!r} to {target!r} "
            f"(allowed: {sorted(ALLOWED_TRANSITIONS.get(current, frozenset()))})."
        )


class RunState:
    """One run's position in the lifecycle, with transitions validated."""

    def __init__(self, run_id: str, status: str) -> None:
        if status not in STATUSES:
            raise RunStateError(run_id, status, RUNNING)
        self.run_id = run_id
        self.status = status

    @property
    def is_terminal(self) -> bool:
        return self.status in TERMINAL_STATUSES

    @property
    def is_claimable(self) -> bool:
        """Whether this run may be picked up for execution — ``pending`` only."""
        return self.status == PENDING

    def transition_to(self, target: str) -> None:
        """Move to *target*, raising :class:`RunStateError` if that edge is absent."""
        if target not in ALLOWED_TRANSITIONS.get(self.status, frozenset()):
            raise RunStateError(self.run_id, self.status, target)
        self.status = target
