"""Pure permission-block editing for the endpoint control plane (ADR-0008).

Given a plugin manifest's JSON text, set one table/operation's permission and
return the new JSON, re-validated against the same ``TablePermissions`` model
the Core API uses. No I/O, no GitHub, no secrets — this is the safe, testable
core the PR-signer wraps.
"""

from __future__ import annotations

import json
from typing import Any

from biffo_plugin_sdk import TablePermissions

# The five operations, taken from the model so this can't drift from it.
OPERATIONS: tuple[str, ...] = tuple(TablePermissions.model_fields)

# --- Prettier-compatible JSON serialization --------------------------------
#
# Plugin manifests are prettier-formatted (printWidth 100) and every instance's
# CI runs `prettier --check` over JSON. Re-dumping with json.dumps(indent=2)
# would expand every short array onto its own lines — so a one-line permission
# change would (a) add pointless diff noise across the whole file and (b) *fail*
# the instance's prettier check, turning the signer's own PRs red.
#
# This serializer reproduces prettier's JSON output for these manifests:
# non-empty objects always break (one entry per line — how the manifests are
# generated, and what prettier preserves for a `{` followed by a newline),
# while arrays of primitives collapse onto one line when they fit within the
# print width and break one-per-line otherwise. The result is byte-identical to
# prettier for a manifest, so an edited manifest diffs only where it changed.

_PRINT_WIDTH = 100
_INDENT = 2


def _is_primitive(value: Any) -> bool:
    return value is None or isinstance(value, (bool, int, float, str))


def _render(value: Any, line_indent: int, prefix_len: int) -> str:
    """Render ``value`` as prettier-compatible JSON.

    ``line_indent`` is the indentation of the line this value sits on; nested
    entries indent one level deeper. ``prefix_len`` is how many characters
    already precede the value on its line (indent + ``"key": ``) — used only to
    decide whether an inline array fits within the print width.
    """
    if isinstance(value, dict):
        if not value:
            return "{}"
        inner = line_indent + _INDENT
        pad = " " * inner
        entries = []
        for key, val in value.items():
            rendered_key = json.dumps(key, ensure_ascii=False)
            rendered = _render(val, inner, inner + len(rendered_key) + 2)
            entries.append(f"{pad}{rendered_key}: {rendered}")
        return "{\n" + ",\n".join(entries) + "\n" + " " * line_indent + "}"

    if isinstance(value, list):
        if not value:
            return "[]"
        if all(_is_primitive(item) for item in value):
            inline = (
                "[" + ", ".join(json.dumps(i, ensure_ascii=False) for i in value) + "]"
            )
            if prefix_len + len(inline) <= _PRINT_WIDTH:
                return inline
        inner = line_indent + _INDENT
        pad = " " * inner
        items = [pad + _render(item, inner, inner) for item in value]
        return "[\n" + ",\n".join(items) + "\n" + " " * line_indent + "]"

    return json.dumps(value, ensure_ascii=False)


def _format_manifest(data: Any) -> str:
    """Serialize ``data`` to prettier-compatible JSON with a trailing newline."""
    return _render(data, 0, 0) + "\n"


def apply_permission_change(
    manifest_json: str,
    *,
    table: str,
    operation: str,
    allowed: bool,
    required_role: list[str],
) -> str:
    """Return ``manifest_json`` with ``table``'s ``permissions[operation]`` set to
    ``{allowed, required_role}``, re-validated.

    Raises ``ValueError`` if the manifest isn't valid JSON, has no ``tables``
    array, doesn't declare ``table``, if ``operation`` isn't a known CRUD
    operation, or if the resulting permissions block fails validation. Only the
    one table's permissions block is touched; everything else is preserved.
    """
    if operation not in OPERATIONS:
        raise ValueError(
            f"unknown operation {operation!r}; expected one of {list(OPERATIONS)}"
        )

    try:
        data: Any = json.loads(manifest_json)
    except json.JSONDecodeError as exc:
        raise ValueError(f"manifest is not valid JSON: {exc}") from exc

    tables = data.get("tables") if isinstance(data, dict) else None
    if not isinstance(tables, list):
        raise ValueError("manifest has no 'tables' array")

    target = next(
        (t for t in tables if isinstance(t, dict) and t.get("name") == table),
        None,
    )
    if target is None:
        raise ValueError(f"table {table!r} is not declared in this manifest")

    permissions = dict(target.get("permissions") or {})
    permissions[operation] = {"allowed": allowed, "required_role": list(required_role)}

    # Re-validate the whole block against the canonical model. This rejects any
    # pre-existing typo'd key/operation too (extra="forbid"), so we never commit
    # a block the Core API would refuse at deploy.
    TablePermissions.model_validate(permissions)

    target["permissions"] = permissions
    return _format_manifest(data)
