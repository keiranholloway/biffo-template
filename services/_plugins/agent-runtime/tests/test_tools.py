"""The tool registry: the ceiling, its two rules, and how each failure is loud."""

from __future__ import annotations

import pytest
from agent_runtime.search import WEB_SEARCH_NAME
from agent_runtime.tools import (
    MAX_OUTBOUND_CHARS,
    TOOL_REGISTRY,
    ToolArgumentError,
    ToolDefinition,
    ToolRegistrationError,
    UnknownToolError,
    declared_tools,
    register,
    resolve_tools,
)
from agent_runtime_fakes import RecordingTool


async def _noop(arguments: dict) -> str:
    return "ok"


def _tool(**overrides) -> ToolDefinition:
    defaults = {
        "name": "sample",
        "description": "A sample tool.",
        "parameters": {
            "type": "object",
            "properties": {"text": {"type": "string", "maxLength": 32}},
            "required": ["text"],
        },
        "execute": _noop,
    }
    return ToolDefinition(**{**defaults, **overrides})


# ── The ceiling ──────────────────────────────────────────────────────────────


def test_a_worker_declaring_nothing_gets_nothing():
    # §7: "a worker declares which registered tools it uses, defaulting to none."
    assert declared_tools({}) == []
    assert declared_tools({"tools": None}) == []
    assert declared_tools({"tools": []}) == []
    assert resolve_tools(declared_tools({"instructions": "go"})) == []


def test_web_search_is_the_registered_tool():
    assert sorted(TOOL_REGISTRY) == [WEB_SEARCH_NAME]


def test_declared_names_accept_the_shapes_an_authoring_form_produces():
    assert declared_tools({"tools": "web_search"}) == ["web_search"]
    assert declared_tools({"tools": "web_search, other"}) == ["web_search", "other"]
    assert declared_tools({"tools": ["web_search", " other "]}) == ["web_search", "other"]


def test_an_unregistered_tool_fails_loudly_and_names_what_exists(monkeypatch):
    with pytest.raises(UnknownToolError) as exc:
        resolve_tools(["web_search", "read_database"])

    assert "read_database" in str(exc.value)
    # The message has to say what this build *does* register — the whole point is
    # that the operator can tell a typo from a definition written elsewhere.
    assert "web_search" in str(exc.value)


def test_a_registered_but_unconfigured_tool_is_dropped_not_fatal(monkeypatch):
    unconfigured = RecordingTool("offline", available=False)
    monkeypatch.setitem(TOOL_REGISTRY, "offline", unconfigured.definition)

    # No exception — a missing credential is an operational state, so the run
    # proceeds with one fewer capability rather than failing every time.
    assert resolve_tools(["offline"]) == []


def test_resolution_is_order_preserving_and_deduplicated(monkeypatch):
    first, second = RecordingTool("alpha"), RecordingTool("beta")
    monkeypatch.setitem(TOOL_REGISTRY, "alpha", first.definition)
    monkeypatch.setitem(TOOL_REGISTRY, "beta", second.definition)

    resolved = resolve_tools(["beta", "alpha", "beta"])

    assert [tool.name for tool in resolved] == ["beta", "alpha"]


# ── Rule 2, enforced rather than documented ──────────────────────────────────


def test_a_tool_with_an_unbounded_string_parameter_cannot_be_registered():
    unbounded = _tool(parameters={"type": "object", "properties": {"text": {"type": "string"}}})

    with pytest.raises(ToolRegistrationError, match="maxLength"):
        register(unbounded)


def test_a_tool_cannot_declare_a_string_larger_than_the_registry_ceiling():
    oversized = _tool(
        parameters={
            "type": "object",
            "properties": {"text": {"type": "string", "maxLength": MAX_OUTBOUND_CHARS + 1}},
        }
    )

    with pytest.raises(ToolRegistrationError, match="registry ceiling"):
        register(oversized)


def test_a_tool_cannot_take_an_object_or_array_parameter():
    # A nested field is an unbounded string field wearing a shape — the same
    # exfiltration channel with extra steps.
    nested = _tool(
        parameters={"type": "object", "properties": {"body": {"type": "object"}}},
    )

    with pytest.raises(ToolRegistrationError, match="registry rule 2"):
        register(nested)


def test_registration_also_rejects_bad_names_and_missing_schemas():
    with pytest.raises(ToolRegistrationError, match="lowercase"):
        register(_tool(name="Web Search"))
    with pytest.raises(ToolRegistrationError, match="no description"):
        register(_tool(description="  "))
    with pytest.raises(ToolRegistrationError, match="JSON Schema object"):
        register(_tool(parameters={"type": "string"}))
    with pytest.raises(ToolRegistrationError, match="registered twice"):
        register(_tool(), _tool())


def test_the_shipped_web_search_tool_satisfies_the_contract():
    # The registry is built by `register(...)` at import, so this is really an
    # assertion that importing the module cannot have skipped validation.
    assert register(*TOOL_REGISTRY.values()).keys() == TOOL_REGISTRY.keys()


# ── Arguments are bounded at runtime, not only in the schema ─────────────────


def test_model_text_is_truncated_to_the_declared_bound():
    tool = _tool()

    coerced = tool.coerce_arguments({"text": "x" * 500})

    # The schema is a request to the model; this is the bound. A model that
    # ignores maxLength still cannot push 500 characters outward.
    assert coerced == {"text": "x" * 32}


def test_undeclared_arguments_are_dropped():
    assert _tool().coerce_arguments({"text": "hi", "url": "https://evil.test/x"}) == {"text": "hi"}


def test_missing_required_arguments_are_an_argument_error():
    with pytest.raises(ToolArgumentError, match="missing required"):
        _tool().coerce_arguments({})
    with pytest.raises(ToolArgumentError, match="non-object"):
        _tool().coerce_arguments("just a string")


def test_the_provider_schema_is_the_function_shape_every_provider_accepts():
    schema = _tool().to_provider_schema()

    assert schema["type"] == "function"
    assert schema["function"]["name"] == "sample"
    assert schema["function"]["parameters"]["properties"]["text"]["maxLength"] == 32
