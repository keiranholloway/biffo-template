"""Tests for orchestrator agent action with optional instructions (biffo-template#910)."""

import pytest
from orchestrator.actions import ActionError, request_agent_run
from orchestrator_fakes import FakeCore


async def test_agent_action_works_without_instructions():
    """The agent action should work when instructions are omitted from config."""
    core = FakeCore([])

    config = {
        "agent_name": "demo-enricher",
        # instructions intentionally omitted
        "model": "anthropic/claude-opus-4-8",
    }

    result = await request_agent_run(
        config,
        {"demo_request_id": "d1", "company": "Acme"},
        core_client=core.client(),
    )

    # The action should succeed and return a run reference
    assert result == {"run_id": "agent-run-1", "status": "requested", "depth": 0}
    posted = core.agent_run_posts()
    assert len(posted) == 1
    # The config without instructions should still be snapshotted
    assert "agent_name" in posted[0]["definition_snapshot"]
    assert "model" in posted[0]["definition_snapshot"]


async def test_fan_in_agent_action_works_without_instructions():
    """The fan-in agent action should work when instructions are omitted."""
    from orchestrator.actions import fan_in_agent_runs

    chain_id = "chain-root-1"

    # Helper functions to build the core state
    def _summary(run_id: str, agent_name: str, status: str = "completed") -> dict:
        return {"id": run_id, "agent_name": agent_name, "status": status, "causation_id": chain_id}

    def _record(output: str) -> dict:
        return {"id": f"run-{output}", "output": output}

    core = FakeCore(
        [],
        chain_runs=[_summary("ra", "research-a"), _summary("rb", "research-b")],
        agent_run_records={
            "ra": _record("findings A"),
            "rb": _record("findings B"),
        },
        agent_run_id="synthesis-run-1",
    )

    config = {
        "expect_agents": "research-a,research-b",
        "agent_name": "synthesis",
        # instructions intentionally omitted
    }

    result = await fan_in_agent_runs(config, _completion(chain_id), core_client=core.client())

    # Should succeed without instructions
    assert result["status"] == "requested"
    assert result["run_id"] == "synthesis-run-1"


def _completion(causation_id: str = "chain-root-1", depth: int = 1) -> dict:
    """The completion event for a chained agent."""
    return {
        "run_id": "research-a",
        "agent": "research-a",
        "status": "completed",
        "causation_id": causation_id,
        "depth": depth,
    }


async def test_agent_action_requires_agent_name():
    """agent_name is still required."""
    core = FakeCore([])

    with pytest.raises(ActionError, match="missing required key"):
        await request_agent_run(
            {"instructions": "Do something"},
            {},
            core_client=core.client(),
        )


async def test_fan_in_requires_expect_agents_and_agent_name():
    """fan-in still requires expect_agents and agent_name."""
    core = FakeCore([])

    from orchestrator.actions import fan_in_agent_runs

    with pytest.raises(ActionError, match="missing required key"):
        await fan_in_agent_runs(
            {"instructions": "Reconcile"},
            _completion("chain-root-1"),
            core_client=core.client(),
        )


async def test_agent_action_omits_model_from_snapshot_when_not_in_config():
    """When model is omitted from config, the snapshot sent to Core has no model key."""
    core = FakeCore([])

    config = {
        "agent_name": "demo-enricher",
        "instructions": "Do the task",
        # model intentionally omitted
    }

    result = await request_agent_run(
        config,
        {"demo_request_id": "d1"},
        core_client=core.client(),
    )

    assert result["status"] == "requested"
    # Check the actual JSON body posted to Core
    posted = core.agent_run_posts()
    assert len(posted) == 1
    snapshot = posted[0]["definition_snapshot"]
    # The snapshot should NOT have a model key when it was omitted from config
    assert "model" not in snapshot
    assert snapshot["agent_name"] == "demo-enricher"
    assert snapshot["instructions"] == "Do the task"


async def test_agent_action_preserves_model_when_in_config():
    """When model is in config, the snapshot sent to Core preserves it."""
    core = FakeCore([])

    config = {
        "agent_name": "demo-enricher",
        "instructions": "Do the task",
        "model": "anthropic/claude-opus-4-8",
    }

    result = await request_agent_run(
        config,
        {"demo_request_id": "d1"},
        core_client=core.client(),
    )

    assert result["status"] == "requested"
    posted = core.agent_run_posts()
    assert len(posted) == 1
    snapshot = posted[0]["definition_snapshot"]
    # The snapshot should have the model from config
    assert snapshot["model"] == "anthropic/claude-opus-4-8"


async def test_fan_in_action_omits_model_from_snapshot_when_not_in_config():
    """When model is omitted from config, the fan-in snapshot has no model key."""
    from orchestrator.actions import fan_in_agent_runs

    _CHAIN = "chain-root-1"  # noqa: F841,N806 — used in _summary closure

    def _summary(run_id: str, agent_name: str, status: str = "completed") -> dict:
        return {"id": run_id, "agent_name": agent_name, "status": status, "causation_id": _CHAIN}

    def _record(output: str) -> dict:
        return {"id": f"run-{output}", "output": output}

    core = FakeCore(
        [],
        chain_runs=[_summary("ra", "research-a"), _summary("rb", "research-b")],
        agent_run_records={
            "ra": _record("findings A"),
            "rb": _record("findings B"),
        },
        agent_run_id="synthesis-run-1",
    )

    config = {
        "expect_agents": "research-a,research-b",
        "agent_name": "synthesis",
        "instructions": "Synthesize the findings",
        # model intentionally omitted
    }

    result = await fan_in_agent_runs(config, _completion(_CHAIN), core_client=core.client())

    assert result["status"] == "requested"
    # Find the actual POST (not GET) request with agent_name in the body
    posted = [body for body in core.agent_run_posts() if body.get("agent_name")]
    assert len(posted) == 1
    snapshot = posted[0]["definition_snapshot"]
    # The snapshot should NOT have a model key when omitted from config
    assert "model" not in snapshot
    assert snapshot["agent_name"] == "synthesis"
    assert snapshot["instructions"] == "Synthesize the findings"


async def test_fan_in_action_preserves_model_when_in_config():
    """When model is in config, the fan-in snapshot preserves it."""
    from orchestrator.actions import fan_in_agent_runs

    _CHAIN = "chain-root-1"  # noqa: F841,N806 — used in _summary closure

    def _summary(run_id: str, agent_name: str, status: str = "completed") -> dict:
        return {"id": run_id, "agent_name": agent_name, "status": status, "causation_id": _CHAIN}

    def _record(output: str) -> dict:
        return {"id": f"run-{output}", "output": output}

    core = FakeCore(
        [],
        chain_runs=[_summary("ra", "research-a"), _summary("rb", "research-b")],
        agent_run_records={
            "ra": _record("findings A"),
            "rb": _record("findings B"),
        },
        agent_run_id="synthesis-run-1",
    )

    config = {
        "expect_agents": "research-a,research-b",
        "agent_name": "synthesis",
        "instructions": "Synthesize the findings",
        "model": "anthropic/claude-opus-4-8",
    }

    result = await fan_in_agent_runs(config, _completion(_CHAIN), core_client=core.client())

    assert result["status"] == "requested"
    # Find the actual POST (not GET) request with agent_name in the body
    posted = [body for body in core.agent_run_posts() if body.get("agent_name")]
    assert len(posted) == 1
    snapshot = posted[0]["definition_snapshot"]
    # The snapshot should have the model from config
    assert snapshot["model"] == "anthropic/claude-opus-4-8"
