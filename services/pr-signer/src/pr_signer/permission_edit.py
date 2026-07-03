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
    return json.dumps(data, indent=2) + "\n"
