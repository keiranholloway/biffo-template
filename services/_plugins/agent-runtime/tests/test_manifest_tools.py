"""The same-service drift guard: the manifest's declared `tools` must be exactly
the registered ones.

This is the one coupling ADR-0014 §7's design deliberately keeps. Core surfaces
the runtime's declared tools in the live orchestration catalog by reading this
manifest (it never imports the runtime's Python), so the manifest is the wire
format. Because that declaration and the executable :data:`TOOL_REGISTRY` live in
the *same* service, the drift between them is cheap to guard here — and this test
is that guard. It has to actually bite: a tool added to the registry but not the
manifest (or vice-versa) must fail, because otherwise Core would offer a tool the
runtime cannot run, or hide one it can.
"""

from __future__ import annotations

import json
from typing import Any

from agent_runtime.manifest import MANIFEST_PATH
from agent_runtime.tools import TOOL_REGISTRY


def _declared_tools() -> list[dict[str, Any]]:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    return manifest.get("tools", [])


def _symmetric_difference(declared_names: set[str], registry_names: set[str]) -> set[str]:
    """Names present on exactly one side — empty iff the two agree.

    Factored out so the guard's own logic can be exercised against a doctored
    registry below, proving the check fails on a mismatch rather than only
    passing on a match.
    """
    return declared_names ^ registry_names


def test_manifest_tools_are_exactly_the_registered_tools():
    declared_names = {tool["name"] for tool in _declared_tools()}
    assert _symmetric_difference(declared_names, set(TOOL_REGISTRY)) == set(), (
        "The manifest's declared `tools` must match TOOL_REGISTRY exactly. Add the "
        "new tool to biffo.plugin.json (name/description/parameters), or remove the "
        "stale declaration — Core surfaces this manifest in the workflow catalog."
    )


def test_the_guard_bites_when_the_registry_gains_a_tool_the_manifest_lacks():
    # Negative control: a tool registered but not declared must be caught. If it
    # were not, Core would offer a picker option for a tool that isn't on the wire.
    declared_names = {tool["name"] for tool in _declared_tools()}
    registry_with_new_tool = set(TOOL_REGISTRY) | {"read_database"}

    diff = _symmetric_difference(declared_names, registry_with_new_tool)

    assert diff == {"read_database"}, "the drift guard must flag a registry-only tool"


def test_the_guard_bites_when_the_manifest_declares_a_tool_the_registry_lacks():
    # The other direction: a stale manifest entry with no executor behind it.
    declared_with_phantom = {tool["name"] for tool in _declared_tools()} | {"phantom_tool"}

    diff = _symmetric_difference(declared_with_phantom, set(TOOL_REGISTRY))

    assert diff == {"phantom_tool"}, "the drift guard must flag a manifest-only tool"


def test_each_declared_tool_mirrors_its_registry_definition():
    # Names matching is the contract; description and parameters matching is the
    # fidelity Part B's picker relies on. Cheap to check in-service, so we do.
    by_name = {tool["name"]: tool for tool in _declared_tools()}
    for name, definition in TOOL_REGISTRY.items():
        declared = by_name[name]
        assert declared["description"] == definition.description
        assert declared["parameters"] == definition.parameters
