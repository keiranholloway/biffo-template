"""Prompt composition primitives — pure, no database (ADR-0015).

The ordered-parts model, the variable declaration shape, and ``{{name}}``
substitution, with **no I/O**, so both callers share one definition of what a
part is and how it resolves:

- the author-time catalog validator (``schemas/orchestration.py``) — shape only,
  since it has no database access, and
- the run-creation resolver (``prompt_library.py``) — which fetches components
  and interpolates.

A prompt field (``instructions``/``goals``) is an **ordered list of parts**, each
either:

- ``{"inline": "<text>"}`` — bespoke text authored on the definition, or
- ``{"component": "<name>", "values": {<var>: <value>, …}}`` — a reference to a
  library component with author-time values for its declared variables.

A plain string is accepted as sugar for a single inline part, so a definition
authored before the library existed (or one that never needs a component) still
validates and resolves byte-for-byte unchanged (ADR-0015 §2, Phase-1
coexistence).

**Placeholder syntax is ``{{name}}``** (double braces, optional inner
whitespace). Only *declared* variables are substituted; any other ``{{…}}`` in a
body is left verbatim (ADR-0015 §5 — substitute only declared variables).

**Variables interpolate author-time values only** (ADR-0015 §5). A value comes
from the part's static ``values`` or the component's declared ``default`` —
never from runtime/event data. This module cannot reach runtime data by
construction: it is handed ``values`` dicts and nothing else, closing the
untrusted-interpolation vector ADR-0014 §5/§7 depends on.
"""

from __future__ import annotations

import re
from typing import Any

INLINE_KEY = "inline"
COMPONENT_KEY = "component"
VALUES_KEY = "values"

# A variable name must be a placeholder-safe identifier: it is what appears
# inside ``{{ }}`` in a body, so the two regexes agree on the grammar.
_NAME_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")
PLACEHOLDER_RE = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")

# Parts compose top-to-bottom, one blank line between blocks — the house-style
# clause then the bespoke task read as distinct paragraphs (ADR-0015 worked
# scenarios), and an empty part contributes nothing rather than a blank line.
_PART_SEPARATOR = "\n\n"


class PromptPartsError(ValueError):
    """A prompt field, a part, a variable declaration, or a supplied value is
    malformed or inconsistent (ADR-0015 §6).

    A ``ValueError`` so a Pydantic ``model_validator`` surfaces it as a 422 at
    author time; the routers also map it to 422 explicitly on the DB-backed
    paths.
    """


def normalize_parts(raw: Any, *, field: str) -> list[dict[str, Any]]:
    """Validate a prompt field into a clean ordered list of parts.

    ``None`` and blank/whitespace-only strings normalise to ``[]`` (nothing to
    compose). A non-blank string becomes a single ``inline`` part. A list is
    validated part-by-part. Anything else is rejected.

    Raises:
        PromptPartsError: the field, or one of its parts, is malformed.
    """
    if raw is None:
        return []
    if isinstance(raw, str):
        return [{INLINE_KEY: raw}] if raw.strip() else []
    if not isinstance(raw, list):
        raise PromptPartsError(
            f"{field} must be a string or a list of parts, got {type(raw).__name__}"
        )
    return [_validate_part(part, field=field, index=index) for index, part in enumerate(raw)]


def _validate_part(part: Any, *, field: str, index: int) -> dict[str, Any]:
    """Validate one part is a well-formed inline or component reference."""
    where = f"{field}[{index}]"
    if not isinstance(part, dict):
        raise PromptPartsError(f"{where} must be an object")

    has_inline = INLINE_KEY in part
    has_component = COMPONENT_KEY in part
    if has_inline == has_component:
        raise PromptPartsError(
            f"{where} must have exactly one of {INLINE_KEY!r} or {COMPONENT_KEY!r}"
        )

    if has_inline:
        text = part[INLINE_KEY]
        if not isinstance(text, str):
            raise PromptPartsError(f"{where}.{INLINE_KEY} must be a string")
        extra = set(part) - {INLINE_KEY}
        if extra:
            raise PromptPartsError(f"{where} (inline) has unexpected keys: {sorted(extra)}")
        return {INLINE_KEY: text}

    name = part[COMPONENT_KEY]
    if not isinstance(name, str) or not name.strip():
        raise PromptPartsError(f"{where}.{COMPONENT_KEY} must be a non-empty string")
    values = part.get(VALUES_KEY, {})
    if not isinstance(values, dict):
        raise PromptPartsError(f"{where}.{VALUES_KEY} must be an object")
    cleaned: dict[str, str] = {}
    for key, value in values.items():
        if not isinstance(key, str):
            raise PromptPartsError(f"{where}.{VALUES_KEY} keys must be strings")
        # Values are trusted author-time config, but they must be plain strings:
        # the substitution target is text, and refusing non-strings keeps the
        # trust boundary (§5) simple — no coercion of arbitrary JSON into a prompt.
        if not isinstance(value, str):
            raise PromptPartsError(f"{where}.{VALUES_KEY}[{key!r}] must be a string")
        cleaned[key] = value
    extra = set(part) - {COMPONENT_KEY, VALUES_KEY}
    if extra:
        raise PromptPartsError(f"{where} (component) has unexpected keys: {sorted(extra)}")
    return {COMPONENT_KEY: name.strip(), VALUES_KEY: cleaned}


def validate_variable_declarations(raw: Any) -> list[dict[str, Any]]:
    """Validate a component's ``variables`` declaration into a clean list.

    Each declared variable is ``{name, required, description?, default?}``.
    ``name`` must be a placeholder-safe identifier and unique. Zero variables is
    the house-style case (ADR-0015 §1).

    Raises:
        PromptPartsError: the declaration is malformed.
    """
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise PromptPartsError("variables must be a list")

    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise PromptPartsError(f"variables[{index}] must be an object")
        name = item.get("name")
        if not isinstance(name, str) or not _NAME_RE.match(name):
            raise PromptPartsError(
                f"variables[{index}].name must be a valid identifier "
                "(a-z, 0-9, _; not starting with a digit) usable as a {{name}} placeholder"
            )
        if name in seen:
            raise PromptPartsError(f"variables[{index}].name {name!r} is declared more than once")
        seen.add(name)

        description = item.get("description")
        if description is not None and not isinstance(description, str):
            raise PromptPartsError(f"variables[{index}].description must be a string")
        required = item.get("required", False)
        if not isinstance(required, bool):
            raise PromptPartsError(f"variables[{index}].required must be a boolean")
        default = item.get("default")
        if default is not None and not isinstance(default, str):
            raise PromptPartsError(f"variables[{index}].default must be a string")
        extra = set(item) - {"name", "description", "required", "default"}
        if extra:
            raise PromptPartsError(f"variables[{index}] has unexpected keys: {sorted(extra)}")

        cleaned: dict[str, Any] = {"name": name, "required": required}
        if description is not None:
            cleaned["description"] = description
        if default is not None:
            cleaned["default"] = default
        out.append(cleaned)
    return out


def resolve_values(
    declared: list[dict[str, Any]],
    provided: dict[str, str],
    *,
    component: str,
    field: str,
) -> dict[str, str]:
    """Resolve the value for each declared variable, author-time only (§5).

    A value comes from ``provided`` (the part's static ``values``), else the
    variable's declared ``default``. A required variable with neither is a
    fail-loud error. A ``provided`` key that no variable declares is rejected —
    it is almost always a typo, and silently ignoring it would let a definition
    drift from the component it references.

    Raises:
        PromptPartsError: an undeclared key was supplied, or a required variable
            has no value.
    """
    declared_by_name = {decl["name"]: decl for decl in declared}

    undeclared = sorted(set(provided) - set(declared_by_name))
    if undeclared:
        raise PromptPartsError(
            f"{field}: component {component!r} does not declare variable(s) {undeclared}"
        )

    resolved: dict[str, str] = {}
    missing: list[str] = []
    for name, decl in declared_by_name.items():
        supplied = provided.get(name)
        if isinstance(supplied, str) and supplied.strip():
            resolved[name] = supplied
        elif isinstance(decl.get("default"), str):
            resolved[name] = decl["default"]
        elif decl.get("required"):
            missing.append(name)
        else:
            resolved[name] = ""
    if missing:
        raise PromptPartsError(
            f"{field}: component {component!r} requires value(s) for {sorted(missing)}"
        )
    return resolved


def substitute(body: str, values: dict[str, str]) -> str:
    """Replace ``{{name}}`` with its resolved value for every declared variable.

    A placeholder whose name is not in ``values`` is left verbatim — only
    declared variables are substituted (ADR-0015 §5).
    """
    return PLACEHOLDER_RE.sub(
        lambda match: values.get(match.group(1), match.group(0)),
        body,
    )


def compose(texts: list[str]) -> str:
    """Join resolved part texts top-to-bottom, dropping empties (§2)."""
    return _PART_SEPARATOR.join(stripped for text in texts if (stripped := text.strip()))
