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

**Known gap, recorded rather than papered over.** Core exposes no route to
persist the ``pending -> running`` transition (its internal agent-run API is
create / read / complete), so the transition below is *runtime-local*: the row
stays ``pending`` in Core until the run terminates. The consequence is that
``claim`` cannot deduplicate across invocations — two concurrent deliveries of
the same ``agent.run.requested`` would both see ``pending`` — and a runtime
killed mid-run leaves the row ``pending`` for ever rather than ``running``. This
is the same stranding class ADR-0014 §5 records under "a second divergence
point", and closing it needs a Core-side claim route plus the stale-run reaper
§5 already calls for. Nothing here silently pretends otherwise.
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
