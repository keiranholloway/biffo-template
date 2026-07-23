"""Output tools: inline, terminal result-collectors (ADR-0017 §5 / Phase 4).

These are deliberately NOT bound by the registry's rule 2 — an output tool has no
executor and no outbound channel, so it may carry an arbitrary (nested) JSON
Schema, which is the structured result it exists to collect. The parsing is still
strict about *shape*: a malformed one fails the run before any spend.
"""

from __future__ import annotations

import pytest
from agent_runtime.tools import OutputTool, OutputToolError, output_tools

# A realistic, deeply nested schema — exactly what rule 2 forbids for an executable
# tool, and exactly what an output tool exists to accept (a plugin's report).
_REPORT_SCHEMA = {
    "type": "function",
    "function": {
        "name": "submit_ideation_report",
        "description": "Submit the completed ideation report (PRD + scorecard).",
        "parameters": {
            "type": "object",
            "properties": {
                "prd": {
                    "type": "object",
                    "properties": {"problem": {"type": "string"}},
                },
                "competitors": {
                    "type": "array",
                    "items": {"type": "object"},
                },
            },
            "required": ["prd"],
        },
    },
}


def test_absent_or_empty_is_none_declared():
    assert output_tools({}) == []
    assert output_tools({"output_tools": []}) == []
    assert output_tools({"output_tools": None}) == []


def test_parses_a_nested_schema_that_rule_2_would_forbid():
    [tool] = output_tools({"output_tools": [_REPORT_SCHEMA]})
    assert isinstance(tool, OutputTool)
    assert tool.name == "submit_ideation_report"
    # nested object + array parameters survive — the whole point of an output tool
    assert tool.parameters["properties"]["prd"]["type"] == "object"
    assert tool.parameters["properties"]["competitors"]["type"] == "array"
    # round-trips to the provider shape
    assert tool.to_provider_schema()["function"]["name"] == "submit_ideation_report"


def test_accepts_a_single_schema_or_the_inner_function_object():
    # a bare dict (not a list)
    [from_dict] = output_tools({"output_tools": _REPORT_SCHEMA})
    assert from_dict.name == "submit_ideation_report"
    # the inner `function` object directly, without the provider wrapper
    inner = _REPORT_SCHEMA["function"]
    [from_inner] = output_tools({"output_tools": [inner]})
    assert from_inner.name == "submit_ideation_report"


def test_a_non_list_is_an_error():
    with pytest.raises(OutputToolError):
        output_tools({"output_tools": "submit_ideation_report"})


@pytest.mark.parametrize(
    "broken",
    [
        {"function": {"name": "", "description": "d", "parameters": {"type": "object"}}},
        {"function": {"name": "Bad-Name", "description": "d", "parameters": {"type": "object"}}},
        {"function": {"name": "ok", "description": "", "parameters": {"type": "object"}}},
        {"function": {"name": "ok", "description": "d", "parameters": {"type": "array"}}},
        {"function": {"name": "ok", "description": "d"}},  # no parameters
        "not-an-object",
    ],
)
def test_malformed_output_tools_fail(broken):
    with pytest.raises(OutputToolError):
        output_tools({"output_tools": [broken]})


def test_duplicate_names_fail():
    with pytest.raises(OutputToolError):
        output_tools({"output_tools": [_REPORT_SCHEMA, _REPORT_SCHEMA]})
