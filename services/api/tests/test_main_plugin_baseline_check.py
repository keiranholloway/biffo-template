"""Dispatch test: lambda_handler routes `biffo:plugin-baseline-check` to
plugin_baseline_check.assert_plugin_baselines_populated (biffo-template#1554),
the same shape test_lambda_runtime.py already proves for the ordinary HTTP
path. Not a re-test of the check's own logic (test_plugin_baseline_check.py
and test_plugin_baseline_check_pg.py cover that) -- just that the event
source string actually reaches the right function.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest


def _fake_context() -> Any:
    return SimpleNamespace(
        function_name="api",
        memory_limit_in_mb=512,
        invoked_function_arn="arn:aws:lambda:eu-west-2:123456789012:function:api",
        aws_request_id="req-1",
    )


def test_dispatches_to_assert_plugin_baselines_populated(monkeypatch: pytest.MonkeyPatch) -> None:
    import src.api.plugin_baseline_check as plugin_baseline_check
    from src.api import main

    calls: list[bool] = []

    def fake_assert() -> dict:
        calls.append(True)
        return {"checked": 0, "failures": []}

    monkeypatch.setattr(plugin_baseline_check, "assert_plugin_baselines_populated", fake_assert)

    result = main.lambda_handler({"source": "biffo:plugin-baseline-check"}, _fake_context())  # type: ignore[arg-type]

    assert calls == [True]
    assert result == {"checked": 0, "failures": []}


def test_a_failure_propagates_rather_than_being_swallowed(monkeypatch: pytest.MonkeyPatch) -> None:
    """The whole point: a raised RuntimeError must reach the Lambda invoker as
    a FunctionError, which is what makes the deploy workflow's `grep -q
    FunctionError` step actually fail the deploy."""
    import src.api.plugin_baseline_check as plugin_baseline_check
    from src.api import main

    def fake_assert() -> dict:
        raise RuntimeError("1 plugin baseline table(s) have no rows for a tenant...")

    monkeypatch.setattr(plugin_baseline_check, "assert_plugin_baselines_populated", fake_assert)

    with pytest.raises(RuntimeError, match="no rows for a tenant"):
        main.lambda_handler({"source": "biffo:plugin-baseline-check"}, _fake_context())  # type: ignore[arg-type]


def test_does_not_dispatch_for_an_unrelated_event_source(monkeypatch: pytest.MonkeyPatch) -> None:
    import src.api.plugin_baseline_check as plugin_baseline_check
    from src.api import main

    calls: list[bool] = []
    monkeypatch.setattr(
        plugin_baseline_check,
        "assert_plugin_baselines_populated",
        lambda: calls.append(True) or {"checked": 0, "failures": []},
    )

    def fake_handler(event: dict, context: Any) -> dict:
        return {"statusCode": 200}

    monkeypatch.setattr(main, "handler", fake_handler)

    result = main.lambda_handler({"rawPath": "/api/v1/health"}, _fake_context())  # type: ignore[arg-type]

    assert calls == []
    assert result == {"statusCode": 200}
