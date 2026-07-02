"""Plugin manifest schema validation and registration helpers.

The shapes in this file (``ColumnDefinition``, ``IndexDefinition``,
``TableDefinition``) are kept in field-for-field sync with
``services/api/src/api/models/plugin_table.py``'s ``ColumnDefinition``/
``IndexDefinition``/``PluginTableDefinition`` in the biffo-template monorepo.
This package can't import that module directly — it's installed by plugin
authors' separate repositories, outside the Core API's own deployment — so
the duplication is unavoidable. If either side changes, update the other.
This SDK deliberately stops at structural validation: it does not resolve
column types into real SQLAlchemy columns (that stays Core-API-only, per
ADR-0002 — no DB client machinery outside services/api/).
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


class ColumnDefinition(BaseModel):
    """Defines a single column on a plugin-created table."""

    name: str = Field(description="Column name.")
    type: str = Field(
        description="SQLAlchemy column type string, e.g. 'String(255)' or 'Integer'."
    )
    primary_key: bool = Field(
        default=False, description="Whether this is the primary key."
    )
    nullable: bool = Field(
        default=False, description="Whether NULL values are allowed."
    )
    index: bool = Field(
        default=False, description="Create a database index on this column."
    )
    default: str | None = Field(
        default=None, description="SQL default value expression."
    )
    description: str = Field(
        default="", description="Human-readable column description."
    )


class IndexDefinition(BaseModel):
    """Defines a database index on a plugin-created table."""

    name: str = Field(description="Index name in the database.")
    columns: list[str] = Field(
        min_length=1, description="Column names included in the index."
    )
    unique: bool = Field(
        default=False, description="Whether the index enforces uniqueness."
    )


# Mirrors _AUTO_COLUMNS in plugin_table.py, which is itself kept in sync with
# TenantScopedModel in base.py. If either changes, update all three.
_AUTO_COLUMNS: list[ColumnDefinition] = [
    ColumnDefinition(name="id", type="String(36)", primary_key=True),
    ColumnDefinition(name="tenant_id", type="String(64)", nullable=False, index=True),
    ColumnDefinition(name="created_at", type="DateTime(timezone=True)", nullable=False),
    ColumnDefinition(name="updated_at", type="DateTime(timezone=True)", nullable=False),
]

_AUTO_COLUMN_NAMES: frozenset[str] = frozenset(c.name for c in _AUTO_COLUMNS)


class TableDefinition(BaseModel):
    """Defines a complete table schema for a plugin.

    Automatically adds id, tenant_id, created_at, updated_at columns
    following the TenantScopedModel pattern (ADR-0001) — the same behavior
    as the Core API's PluginTableDefinition, so a manifest that validates
    here is guaranteed to validate there too.
    """

    name: str = Field(description="Table name in the database.")
    columns: list[ColumnDefinition] = Field(default_factory=list)
    indexes: list[IndexDefinition] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _ensure_auto_columns(cls, data: Any) -> Any:
        """A manifest may not redeclare a reserved auto-column name, since
        doing so could silently weaken the tenant-isolation guarantee
        (ADR-0001), e.g. by declaring tenant_id as nullable.
        """
        if isinstance(data, dict):
            existing_cols = list(data.get("columns", []))
            for col in existing_cols:
                name = col["name"] if isinstance(col, dict) else col.name
                if name in _AUTO_COLUMN_NAMES:
                    raise ValueError(
                        f"Column '{name}' is reserved and added automatically; "
                        "it must not be declared in the manifest."
                    )
            data["columns"] = existing_cols + list(_AUTO_COLUMNS)
        return data

    @model_validator(mode="after")
    def _validate_uniqueness(self) -> "TableDefinition":
        """Validate no duplicate column or index names, and that every
        index only references columns that actually exist on the table.
        """
        col_counts = Counter(c.name for c in self.columns)
        dupes = [n for n, c in col_counts.items() if c > 1]
        if dupes:
            raise ValueError(f"Duplicate column names: {dupes}")

        idx_counts = Counter(i.name for i in self.indexes)
        idx_dupes = [n for n, c in idx_counts.items() if c > 1]
        if idx_dupes:
            raise ValueError(f"Duplicate index names: {idx_dupes}")

        valid_cols = set(col_counts.keys())
        for idx in self.indexes:
            for col in idx.columns:
                if col not in valid_cols:
                    raise ValueError(
                        f"Index '{idx.name}' references unknown column '{col}'. "
                        f"Valid columns: {valid_cols}"
                    )
        return self


# Operation -> the HTTP method(s) it's allowed to use. Deliberately reuses
# ADR-0004's list/read/create/update/delete vocabulary for its permissions
# registry, so a future permissions block on a route/table can be expressed
# in the same terms without a renaming migration.
_OPERATION_METHODS: dict[str, frozenset[str]] = {
    "list": frozenset({"GET"}),
    "read": frozenset({"GET"}),
    "create": frozenset({"POST"}),
    "update": frozenset({"PUT", "PATCH"}),
    "delete": frozenset({"DELETE"}),
}

# Operations that address a single row need an {id} path parameter; the
# collection-level operations (list, create) must not have one.
_SINGLE_ROW_OPERATIONS: frozenset[str] = frozenset({"read", "update", "delete"})


class RouteDef(BaseModel):
    """Definition of an API route for plugin manifests.

    Mirrors ``services/api/src/api/models/plugin_route.py``'s
    ``RouteDefinition`` in the biffo-template monorepo (same duplication
    rationale as ``ColumnDefinition``/``TableDefinition`` above).

    Per ADR-0002, a plugin cannot ship executable route-handler code that the
    Core API imports and runs inside its own process — plugins talk to the
    Core API over HTTP, they are not linked into it. So a route's "handler"
    is not code: it is a declaration of which of the plugin's own tables
    (declared in this same manifest's ``tables``) the route exposes, and
    which generic CRUD ``operation`` the Core API should synthesize for it,
    scoped to the caller's tenant_id (ADR-0001). This is why this model has
    ``table``/``operation`` fields instead of a free-form ``handler: str``
    naming a Python function.
    """

    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE"]
    path: str = Field(
        description="Path relative to the plugin's mount point "
        "(/api/v1/plugins/<name>), e.g. '/widgets' or '/widgets/{id}'. "
        "Must start with '/'."
    )
    table: str = Field(
        description="Name of a table declared in this manifest's `tables`."
    )
    operation: Literal["list", "read", "create", "update", "delete"] = Field(
        description="Generic CRUD operation the Core API synthesizes for "
        "this route against `table`."
    )
    description: str = ""

    @model_validator(mode="after")
    def _validate_method_and_path(self) -> "RouteDef":
        if not self.path.startswith("/"):
            raise ValueError(f"path must start with '/': {self.path!r}")

        allowed_methods = _OPERATION_METHODS[self.operation]
        if self.method not in allowed_methods:
            raise ValueError(
                f"operation '{self.operation}' requires method in "
                f"{sorted(allowed_methods)}, got {self.method!r}"
            )

        has_id = "{id}" in self.path
        needs_id = self.operation in _SINGLE_ROW_OPERATIONS
        if needs_id and not has_id:
            raise ValueError(
                f"operation '{self.operation}' addresses a single row and "
                f"requires an '{{id}}' path parameter: {self.path!r}"
            )
        if not needs_id and has_id:
            raise ValueError(
                f"operation '{self.operation}' is collection-level and must "
                f"not have an '{{id}}' path parameter: {self.path!r}"
            )
        return self


class PluginManifest(BaseModel):
    """Validated manifest for a Biffo plugin.

    Required fields: ``name``, ``version``.
    Optional fields carry sensible defaults so plugins can be minimal.
    """

    name: str
    version: str
    description: str = ""
    author: str = "Biffo Team"
    tags: list[str] = []
    tables: list[TableDefinition] = []
    api_routes: list[RouteDef] = []
    required_core_version: str = ">=0.0.0"

    @model_validator(mode="after")
    def _validate_routes_reference_declared_tables(self) -> "PluginManifest":
        """A route can only expose a table this same manifest declares — it
        can't reference another plugin's table, and can't be declared
        without the table it serves."""
        table_names = {t.name for t in self.tables}
        for route in self.api_routes:
            if route.table not in table_names:
                raise ValueError(
                    f"Route {route.method} {route.path} references table "
                    f"{route.table!r}, which is not declared in this "
                    f"manifest's 'tables' ({sorted(table_names)})."
                )
        return self

    def model_dump_serializable(self) -> dict[str, Any]:
        """Return a JSON-serialisable dict (no Pydantic internals)."""
        return self.model_dump(mode="json")


def load_manifest(path: str | Path) -> PluginManifest:
    """Load and validate a plugin manifest from a JSON file.

    Raises:
        FileNotFoundError: If *path* does not exist.
        ValueError: If the file contains invalid JSON or fails schema validation.
    """
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"Manifest not found: {p}")

    try:
        raw = p.read_text(encoding="utf-8")
    except OSError as exc:
        raise ValueError(f"Cannot read manifest: {exc}") from exc

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON in manifest {p}: {exc}") from exc

    try:
        return PluginManifest(**data)
    except Exception as exc:
        raise ValueError(f"Schema validation failed for {p}: {exc}") from exc


def register_plugin(manifest: PluginManifest) -> dict[str, Any]:
    """Return a serialisable registration dict for the given manifest.

    This is what the CLI sends to the registry during ``biffo plugin install``.
    """
    return {
        "name": manifest.name,
        "version": manifest.version,
        "description": manifest.description,
        "author": manifest.author,
        "tags": manifest.tags,
        "required_core_version": manifest.required_core_version,
        "tables": [t.model_dump(mode="json") for t in manifest.tables],
        "api_routes": [r.model_dump(mode="json") for r in manifest.api_routes],
    }
