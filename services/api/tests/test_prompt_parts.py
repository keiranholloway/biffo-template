"""Unit tests for the pure prompt-composition primitives (ADR-0015, prompt_parts).

No database: normalisation, variable-declaration validation, value resolution,
substitution and composition. The DB-backed resolution is exercised in
test_prompt_resolution.py.
"""

import pytest
from api.prompt_parts import (
    COMPONENT_KEY,
    INLINE_KEY,
    VALUES_KEY,
    PromptPartsError,
    compose,
    normalize_parts,
    resolve_values,
    substitute,
    validate_variable_declarations,
)

# ── normalize_parts ──────────────────────────────────────────────────────────


def test_a_plain_string_becomes_one_inline_part():
    assert normalize_parts("do the thing", field="instructions") == [
        {INLINE_KEY: "do the thing"}
    ]


def test_none_and_blank_string_normalise_to_no_parts():
    assert normalize_parts(None, field="instructions") == []
    assert normalize_parts("   ", field="instructions") == []


def test_a_list_of_parts_is_validated_and_cleaned():
    parts = normalize_parts(
        [
            {"inline": "bespoke"},
            {"component": "house-style", "values": {"region": "Midlands"}},
            {"component": "no-values"},
        ],
        field="instructions",
    )
    assert parts == [
        {INLINE_KEY: "bespoke"},
        {COMPONENT_KEY: "house-style", VALUES_KEY: {"region": "Midlands"}},
        {COMPONENT_KEY: "no-values", VALUES_KEY: {}},
    ]


def test_a_part_with_neither_inline_nor_component_is_rejected():
    with pytest.raises(PromptPartsError, match="exactly one"):
        normalize_parts([{}], field="instructions")


def test_a_part_with_both_inline_and_component_is_rejected():
    with pytest.raises(PromptPartsError, match="exactly one"):
        normalize_parts([{"inline": "x", "component": "y"}], field="instructions")


def test_a_non_string_inline_is_rejected():
    with pytest.raises(PromptPartsError, match="inline must be a string"):
        normalize_parts([{"inline": 5}], field="instructions")


def test_non_string_values_are_rejected():
    with pytest.raises(PromptPartsError, match="must be a string"):
        normalize_parts([{"component": "c", "values": {"n": 3}}], field="instructions")


def test_an_unexpected_key_on_a_part_is_rejected():
    with pytest.raises(PromptPartsError, match="unexpected keys"):
        normalize_parts([{"inline": "x", "note": "nope"}], field="instructions")


def test_a_non_list_non_string_field_is_rejected():
    with pytest.raises(PromptPartsError, match="string or a list"):
        normalize_parts({"inline": "x"}, field="instructions")


# ── validate_variable_declarations ───────────────────────────────────────────


def test_zero_variables_is_the_house_style_case():
    assert validate_variable_declarations([]) == []
    assert validate_variable_declarations(None) == []


def test_a_full_variable_declaration_is_cleaned():
    declared = validate_variable_declarations(
        [{"name": "region", "description": "the area", "required": True, "default": "UK"}]
    )
    assert declared == [
        {"name": "region", "required": True, "description": "the area", "default": "UK"}
    ]


def test_required_defaults_to_false_when_absent():
    assert validate_variable_declarations([{"name": "tone"}]) == [
        {"name": "tone", "required": False}
    ]


def test_a_non_identifier_variable_name_is_rejected():
    with pytest.raises(PromptPartsError, match="valid identifier"):
        validate_variable_declarations([{"name": "not a name"}])


def test_a_duplicate_variable_name_is_rejected():
    with pytest.raises(PromptPartsError, match="more than once"):
        validate_variable_declarations([{"name": "x"}, {"name": "x"}])


def test_a_non_boolean_required_is_rejected():
    with pytest.raises(PromptPartsError, match="required must be a boolean"):
        validate_variable_declarations([{"name": "x", "required": "yes"}])


# ── resolve_values ───────────────────────────────────────────────────────────


def test_a_supplied_value_wins_over_a_default():
    declared = [{"name": "region", "required": True, "default": "UK"}]
    assert resolve_values(declared, {"region": "Midlands"}, component="c", field="f") == {
        "region": "Midlands"
    }


def test_a_default_fills_an_unsupplied_variable():
    declared = [{"name": "region", "required": True, "default": "UK"}]
    assert resolve_values(declared, {}, component="c", field="f") == {"region": "UK"}


def test_a_required_variable_with_no_value_and_no_default_is_rejected():
    declared = [{"name": "region", "required": True}]
    with pytest.raises(PromptPartsError, match="requires value"):
        resolve_values(declared, {}, component="c", field="f")


def test_an_optional_variable_with_no_value_resolves_to_empty():
    declared = [{"name": "note", "required": False}]
    assert resolve_values(declared, {}, component="c", field="f") == {"note": ""}


def test_an_undeclared_value_key_is_rejected():
    declared = [{"name": "region", "required": True, "default": "UK"}]
    with pytest.raises(PromptPartsError, match="does not declare"):
        resolve_values(declared, {"regoin": "typo"}, component="c", field="f")


# ── substitute ───────────────────────────────────────────────────────────────


def test_substitute_fills_declared_placeholders_only():
    body = "Score leads for {{region}}. Ignore {{undeclared}}."
    assert substitute(body, {"region": "London"}) == (
        "Score leads for London. Ignore {{undeclared}}."
    )


def test_substitute_handles_inner_whitespace_in_the_placeholder():
    assert substitute("hi {{ name }}", {"name": "Sam"}) == "hi Sam"


# ── compose ──────────────────────────────────────────────────────────────────


def test_compose_joins_parts_with_a_blank_line_and_drops_empties():
    assert compose(["first", "", "  ", "second"]) == "first\n\nsecond"
