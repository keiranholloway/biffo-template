"""The run state machine (ADR-0014 §6): pending -> running -> completed|failed."""

from __future__ import annotations

import pytest
from agent_runtime.state import COMPLETED, FAILED, PENDING, RUNNING, RunState, RunStateError


def test_a_pending_run_is_claimable_and_nothing_else_is():
    assert RunState("r", PENDING).is_claimable
    assert not RunState("r", RUNNING).is_claimable
    assert not RunState("r", COMPLETED).is_claimable
    assert not RunState("r", FAILED).is_claimable


def test_the_happy_path_transitions():
    state = RunState("r", PENDING)
    state.transition_to(RUNNING)
    state.transition_to(COMPLETED)

    assert state.is_terminal


def test_a_run_may_fail_from_either_non_terminal_state():
    RunState("r", PENDING).transition_to(FAILED)
    RunState("r", RUNNING).transition_to(FAILED)


def test_terminal_states_have_no_exits():
    for terminal in (COMPLETED, FAILED):
        with pytest.raises(RunStateError):
            RunState("r", terminal).transition_to(RUNNING)


def test_skipping_running_is_refused():
    with pytest.raises(RunStateError, match="cannot move from 'pending' to 'completed'"):
        RunState("r", PENDING).transition_to(COMPLETED)


def test_an_unknown_status_is_refused_at_construction():
    with pytest.raises(RunStateError):
        RunState("r", "half-done")
