"""Plugin table definition models for dynamic schema generation."""

from __future__ import annotations

import ast
from typing import Any

from pydantic import BaseModel, Field, model_validator
from sqlalchemy import Boolean, DateTime, Integer, String, Text, Float

# Module-level constant — built once, not on every _resolve_sa_type call.
_TYPE_MAP: dict[str, type] = {
    "String": String,
    "Integer": Integer,
    "Text": Text,
    "Boolean": Boolean,
    "Float": Float,
    "DateTime": DateTime,
}


def resolve_type_call(type_str: str) -> tuple[str, list[Any], dict[str, Any]]:
    """Parse a type string like 'String(36)' or 'DateTime(timezone=True)' into
    (base_type_name, positional_args, keyword_args).

    Only literal argument values are evaluated (via ast.literal_eval on each
    argument node individually) — arbitrary expressions are rejected rather
    than silently dropped or spliced verbatim into generated code.
    """
    if "(" not in type_str:
        return type_str, [], {}

    base_type, _, rest = type_str.partition("(")
    params = rest[:-1] if rest.endswith(")") else rest

    try:
        call = ast.parse(f"_({params})", mode="eval").body
    except SyntaxError as exc:
        raise ValueError(f"Invalid type parameters in {type_str!r}: {exc}") from exc
    if not isinstance(call, ast.Call):
        raise ValueError(f"Invalid type parameters in {type_str!r}")

    try:
        args = [ast.literal_eval(a) for a in call.args]
        kwargs = {kw.arg: ast.literal_eval(kw.value) for kw in call.keywords if kw.arg}
    except ValueError as exc:
        raise ValueError(f"Invalid type parameters in {type_str!r}: {exc}") from exc

    return base_type, args, kwargs


class ColumnDefinition(BaseModel):
    """Defines a single column on a plugin-created table.

    The Core API translates these into SQLAlchemy mapped columns.
    """

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


# Shared auto-column definitions — kept in sync with TenantScopedModel in base.py.
# If TenantScopedModel gains a new column, update this list too.
_AUTO_COLUMNS: list[ColumnDefinition] = [
    ColumnDefinition(name="id", type="String(36)", primary_key=True),
    ColumnDefinition(name="tenant_id", type="String(64)", nullable=False, index=True),
    ColumnDefinition(
        name="created_at",
        type="DateTime(timezone=True)",
        nullable=False,
    ),
    ColumnDefinition(
        name="updated_at",
        type="DateTime(timezone=True)",
        nullable=False,
    ),
]

# These names are reserved for the auto-columns above and may not be
# redeclared by a manifest — see _ensure_auto_columns.
_AUTO_COLUMN_NAMES: frozenset[str] = frozenset(c.name for c in _AUTO_COLUMNS)


class PluginTableDefinition(BaseModel):
    """Defines a complete table schema for a plugin.

    Automatically adds id, tenant_id, created_at, updated_at columns
    following the TenantScopedModel pattern (ADR-0001).
    """

    name: str = Field(description="Table name in the database.")
    columns: list[ColumnDefinition] = Field(default_factory=list)
    indexes: list[IndexDefinition] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _ensure_auto_columns(cls, data: Any) -> Any:
        """Ensure auto-columns are always present, using their canonical
        definition — a manifest may not redeclare a reserved auto-column
        name, since doing so could silently weaken the tenant-isolation
        guarantee (ADR-0001), e.g. by declaring tenant_id as nullable.
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
    def _validate_uniqueness(self) -> "PluginTableDefinition":
        """Validate no duplicate column or index names."""
        from collections import Counter

        col_counts = Counter(c.name for c in self.columns)
        dupes = [n for n, c in col_counts.items() if c > 1]
        if dupes:
            raise ValueError(f"Duplicate column names: {dupes}")

        idx_counts = Counter(i.name for i in self.indexes)
        idx_dupes = [n for n, c in idx_counts.items() if c > 1]
        if idx_dupes:
            raise ValueError(f"Duplicate index names: {idx_dupes}")

        # Validate index columns reference actual columns
        valid_cols = set(col_counts.keys())
        for idx in self.indexes:
            for col in idx.columns:
                if col not in valid_cols:
                    raise ValueError(
                        f"Index '{idx.name}' references unknown column '{col}'. "
                        f"Valid columns: {valid_cols}"
                    )
        return self

    def to_sqlalchemy_model(self) -> type[Any]:
        """Convert this table definition into a SQLAlchemy model class.

        Returns:
            A new SQLAlchemy model class inheriting from TenantScopedModel.
        """
        from sqlalchemy import Column
        from api.models.base import TenantScopedModel

        kwargs: dict[str, Any] = {"__tablename__": self.name}

        for col in self.columns:
            if col.name in _AUTO_COLUMN_NAMES:
                # Inherited from TenantScopedModel as-is, which is where the
                # Python-side defaults (uuid4 id, "default" tenant_id, server
                # timestamps) live. Rebuilding these as plain Column(...) here
                # would shadow those defaults and break inserts that don't set
                # id/tenant_id explicitly.
                continue

            col_kwargs: dict[str, Any] = {}
            if col.primary_key:
                col_kwargs["primary_key"] = True
            if not col.nullable:
                col_kwargs["nullable"] = False
            if col.default is not None:
                col_kwargs["server_default"] = col.default

            sa_type = self._resolve_sa_type(col.type)
            kwargs[col.name] = Column(sa_type, **col_kwargs)

        return type(self.name.capitalize(), (TenantScopedModel,), kwargs)

    @staticmethod
    def _resolve_sa_type(type_str: str) -> Any:
        """Resolve a type string like 'String(36)' or 'DateTime(timezone=True)' to a SQLAlchemy type instance."""
        base_type, args, kwargs = resolve_type_call(type_str)
        cls = _TYPE_MAP.get(base_type) or String
        return cls(*args, **kwargs)
