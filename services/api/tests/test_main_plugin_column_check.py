"""Dispatch test: `lambda_handler` routes `biffo:plugin-column-check` to
`plugin_column_check.assert_plugin_columns_exist` (biffo-template#1556), the
same shape `test_main_plugin_baseline_check.py` proves for its sibling event.

Not a re-test of the check's own logic (`test_plugin_column_check.py` and
`test_plugin_column_check_pg.py` cover that) — just that the event source
string reaches the right function, that a failure propagates as a Lambda
`FunctionError` (which is what the deploy step's `grep -q FunctionError`
actually keys on), and that the two sibling checks have not been crossed.
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


def test_dispatches_to_assert_plugin_columns_exist(monkeypatch: pytest.MonkeyPatch) -> None:
    import src.api.plugin_column_check as plugin_column_check
    from src.api import main

    calls: list[bool] = []

    def fake_assert() -> dict:
        calls.append(True)
        return {"environment": "dev", "tables_checked": 0, "gaps": []}

    monkeypatch.setattr(plugin_column_check, "assert_plugin_columns_exist", fake_assert)

    result = main.lambda_handler({"source": "biffo:plugin-column-check"}, _fake_context())  # type: ignore[arg-type]

    assert calls == [True]
    assert result["gaps"] == []


def test_a_failure_propagates_rather_than_being_swallowed(monkeypatch: pytest.MonkeyPatch) -> None:
    """A raised RuntimeError must reach the Lambda invoker as a FunctionError —
    that is what makes the deploy workflow's step actually fail the deploy
    rather than printing a red-looking message and carrying on."""
    import src.api.plugin_column_check as plugin_column_check
    from src.api import main

    def fake_assert() -> dict:
        raise RuntimeError("[prod] 1 plugin table(s) are missing column(s)...")

    monkeypatch.setattr(plugin_column_check, "assert_plugin_columns_exist", fake_assert)

    with pytest.raises(RuntimeError, match="missing column"):
        main.lambda_handler({"source": "biffo:plugin-column-check"}, _fake_context())  # type: ignore[arg-type]


def test_the_two_sibling_checks_are_not_crossed(monkeypatch: pytest.MonkeyPatch) -> None:
    """`biffo:plugin-column-check` and `biffo:plugin-baseline-check` are
    adjacent branches on the same dispatcher and adjacent steps in the same
    deploy job; a copy-paste that pointed both at one function would make the
    workflow look fully wired while asserting one thing twice."""
    import src.api.plugin_baseline_check as plugin_baseline_check
    import src.api.plugin_column_check as plugin_column_check
    from src.api import main

    called: list[str] = []
    monkeypatch.setattr(
        plugin_column_check,
        "assert_plugin_columns_exist",
        lambda: called.append("column") or {"gaps": []},
    )
    monkeypatch.setattr(
        plugin_baseline_check,
        "assert_plugin_baselines_populated",
        lambda: called.append("baseline") or {"failures": []},
    )

    main.lambda_handler({"source": "biffo:plugin-column-check"}, _fake_context())  # type: ignore[arg-type]
    main.lambda_handler({"source": "biffo:plugin-baseline-check"}, _fake_context())  # type: ignore[arg-type]

    assert called == ["column", "baseline"]


def test_does_not_dispatch_for_an_unrelated_event_source(monkeypatch: pytest.MonkeyPatch) -> None:
    import src.api.plugin_column_check as plugin_column_check
    from src.api import main

    calls: list[bool] = []
    monkeypatch.setattr(
        plugin_column_check,
        "assert_plugin_columns_exist",
        lambda: calls.append(True) or {"gaps": []},
    )

    def fake_handler(event: dict, context: Any) -> dict:
        return {"statusCode": 200}

    monkeypatch.setattr(main, "handler", fake_handler)

    result = main.lambda_handler({"rawPath": "/api/v1/health"}, _fake_context())  # type: ignore[arg-type]

    assert calls == []
    assert result == {"statusCode": 200}
