"""Captured fixtures and manifest-derived schema enforcement for plugin tests.

Two halves of one idea -- a test can only check what its author already thought
of (biffo-template#1514), so neither the inputs nor the fake's idea of "valid"
should be authored by hand:

* :class:`FixtureRecorder` records one real payload (an agent output, a Core
  response) per named *shape* and replays it from the committed file. Record
  mode is explicit (``BIFFO_RECORD_FIXTURES=1`` or ``record=True``) so a normal
  test run can never silently overwrite a fixture.
* :class:`ManifestSchema` derives, from the manifest's own ``tables``
  declarations, what the real database would reject -- ``String(n)`` length,
  basic types and NOT NULL -- so a fake Core API built on it rejects what
  production rejects, without a hand-written (and so drift-prone) bound.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from .plugin import PluginManifest, TableDefinition

RECORD_ENV_VAR = "BIFFO_RECORD_FIXTURES"

# Columns the Core API assigns itself (plugin.py's _AUTO_COLUMNS); a client
# payload need not supply them, so NOT NULL is not enforced on them.
_SERVER_ASSIGNED = frozenset({"id", "tenant_id", "created_at", "updated_at"})


class SchemaViolation(ValueError):  # noqa: N818 - named for the concept, not an Error
    """A row the declared schema (and therefore production) would reject."""

    def __init__(self, table: str, problems: list[str]) -> None:
        self.table = table
        self.problems = problems
        super().__init__(f"{table}: " + "; ".join(problems))


class FixtureNotRecordedError(FileNotFoundError):
    """Replay was requested for a shape that was never captured."""


class FixtureRecorder:
    """Record a real payload once, replay the committed copy thereafter."""

    def __init__(self, directory: str | Path, *, record: bool | None = None) -> None:
        self.directory = Path(directory)
        self.record = (
            os.environ.get(RECORD_ENV_VAR, "") not in ("", "0", "false")
            if record is None
            else record
        )

    def path_for(self, shape: str) -> Path:
        if not shape or "/" in shape or "\\" in shape or shape.startswith("."):
            raise ValueError(f"invalid fixture shape name: {shape!r}")
        return self.directory / f"{shape}.json"

    def save(self, shape: str, payload: Any) -> Path:
        path = self.path_for(shape)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return path

    def load(self, shape: str) -> Any:
        path = self.path_for(shape)
        if not path.is_file():
            raise FixtureNotRecordedError(
                f"no captured fixture for shape {shape!r} at {path}; capture one from the "
                f"real system with {RECORD_ENV_VAR}=1 rather than writing it by hand"
            )
        return json.loads(path.read_text(encoding="utf-8"))

    def capture(self, shape: str, fetch: Callable[[], Any]) -> Any:
        """Record mode: call ``fetch`` (the real system), store and return its
        result. Replay mode: return the committed fixture; ``fetch`` is not called."""
        if not self.record:
            return self.load(shape)
        payload = fetch()
        self.save(shape, payload)
        return payload


def _parse_type(type_str: str) -> tuple[str, list[Any]]:
    from ast import literal_eval

    base, _, rest = type_str.partition("(")
    args: list[Any] = []
    if rest:
        for part in rest.rstrip(")").split(","):
            part = part.strip()
            if part and "=" not in part:
                try:
                    args.append(literal_eval(part))
                except (ValueError, SyntaxError):
                    pass
    return base.strip(), args


class ManifestSchema:
    """Row validation generated from a manifest's table declarations."""

    def __init__(self, tables: Mapping[str, TableDefinition]) -> None:
        self._tables = dict(tables)

    @classmethod
    def from_manifest(cls, manifest: PluginManifest) -> ManifestSchema:
        return cls({t.name: t for t in manifest.tables})

    def table_for_route(self, manifest: PluginManifest, path: str) -> str | None:
        """Table a route path (e.g. ``/widgets`` or ``widgets``) exposes."""
        want = "/" + path.strip("/")
        for route in manifest.api_routes:
            if route.path.rstrip("/").split("/:")[0].split("/{")[0] == want:
                return route.table
        return None

    def problems(self, table: str, row: Mapping[str, Any], *, partial: bool = False) -> list[str]:
        definition = self._tables[table]
        found: list[str] = []
        known = {c.name: c for c in definition.columns}
        for key in row:
            if key not in known:
                found.append(f"unknown column {key!r}")
        for col in definition.columns:
            if col.name not in row:
                if (
                    not partial
                    and not col.nullable
                    and not col.primary_key
                    and col.default is None
                    and col.name not in _SERVER_ASSIGNED
                ):
                    found.append(f"{col.name} is NOT NULL but missing")
                continue
            value = row[col.name]
            if value is None:
                if not col.nullable and col.name not in _SERVER_ASSIGNED:
                    found.append(f"{col.name} is NOT NULL but got null")
                continue
            base, args = _parse_type(col.type)
            if base == "String":
                if not isinstance(value, str):
                    found.append(f"{col.name} must be a string, got {type(value).__name__}")
                elif args and isinstance(args[0], int) and len(value) > args[0]:
                    found.append(
                        f"{col.name} is {len(value)} characters, exceeds declared {col.type}"
                    )
            elif base == "Text":
                if not isinstance(value, str):
                    found.append(f"{col.name} must be a string, got {type(value).__name__}")
            elif base == "Boolean":
                if not isinstance(value, bool):
                    found.append(f"{col.name} must be a boolean, got {type(value).__name__}")
            elif base == "Integer":
                if isinstance(value, bool) or not isinstance(value, int):
                    found.append(f"{col.name} must be an integer, got {type(value).__name__}")
            elif base == "Float":
                if isinstance(value, bool) or not isinstance(value, (int, float)):
                    found.append(f"{col.name} must be a number, got {type(value).__name__}")
            elif base == "DateTime" and not isinstance(value, str):
                found.append(f"{col.name} must be an ISO-8601 string, got {type(value).__name__}")
        return found

    def validate(self, table: str, row: Mapping[str, Any], *, partial: bool = False) -> None:
        """Raise :class:`SchemaViolation` if the real database would reject ``row``."""
        found = self.problems(table, row, partial=partial)
        if found:
            raise SchemaViolation(table, found)
