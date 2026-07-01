"""Plugin table definition models for dynamic schema generation."""

from __future__ import annotations

import ast
import threading
from typing import Any, ClassVar

from pydantic import BaseModel, Field, model_validator
from sqlalchemy import Boolean, DateTime, Integer, String, Text, Float


class ColumnDefinition(BaseModel):
    """Defines a single column on a plugin-created table.

    The Core API translates these into SQLAlchemy mapped columns.
    """

    name: str = Field(description="Column name.")
    type: str = Field(description="SQLAlchemy column type string, e.g. 'String(255)' or 'Integer'.")
    primary_key: bool = Field(default=False, description="Whether this is the primary key.")
    nullable: bool = Field(default=False, description="Whether NULL values are allowed.")
    index: bool = Field(default=False, description="Create a database index on this column.")
    default: str | None = Field(default=None, description="SQL default value expression.")
    description: str = Field(default="", description="Human-readable column description.")


class IndexDefinition(BaseModel):
    """Defines a database index on a plugin-created table."""

    name: str = Field(description="Index name in the database.")
    columns: list[str] = Field(min_length=1, description="Column names included in the index.")
    unique: bool = Field(default=False, description="Whether the index enforces uniqueness.")


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
        """Ensure auto-columns are always present without mutating caller input."""
        if isinstance(data, dict):
            existing_cols = list(data.get("columns", []))
            existing_names = {c["name"] if isinstance(c, dict) else c.name for c in existing_cols}
            for auto_col in _AUTO_COLUMNS:
                if auto_col.name not in existing_names:
                    existing_cols.append(auto_col)
            data["columns"] = existing_cols
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

    _model_counter: ClassVar[int] = 0
    _counter_lock: ClassVar[threading.Lock] = threading.Lock()

    def to_sqlalchemy_model(self) -> type[Any]:
        """Convert this table definition into a SQLAlchemy model class.

        Returns:
            A new SQLAlchemy model class inheriting from TenantScopedModel.
        """
        from sqlalchemy import Column, func
        from api.models.base import TenantScopedModel

        # Unique module name prevents SQLAlchemy registry collision
        with PluginTableDefinition._counter_lock:
            PluginTableDefinition._model_counter += 1

        kwargs: dict[str, Any] = {"__tablename__": self.name}

        for col in self.columns:
            col_kwargs: dict[str, Any] = {}
            if col.primary_key:
                col_kwargs["primary_key"] = True
            if not col.nullable:
                col_kwargs["nullable"] = False
            if col.default is not None:
                col_kwargs["server_default"] = col.default
            if col.name == "created_at":
                col_kwargs["server_default"] = func.now()
            if col.name == "updated_at":
                col_kwargs["server_default"] = func.now()
                col_kwargs["onupdate"] = func.now()

            sa_type = self._resolve_sa_type(col.type)
            kwargs[col.name] = Column(sa_type, **col_kwargs)

        return type(self.name.capitalize(), (TenantScopedModel,), kwargs)

    @staticmethod
    def _resolve_sa_type(type_str: str) -> Any:
        """Resolve a type string like 'String(36)' or 'DateTime(timezone=True)' to a SQLAlchemy type instance."""
        # Module-level constant avoids reallocating on every call
        type_map: dict[str, type] = {
            "String": String,
            "Integer": Integer,
            "Text": Text,
            "Boolean": Boolean,
            "Float": Float,
            "DateTime": DateTime,
        }

        if "(" in type_str:
            base_type, params = type_str.split("(", 1)
            params = params.rstrip(")")
            cls = type_map.get(base_type) or String
            # Safely evaluate simple parameter expressions like "36" or "timezone=True"
            try:
                parsed = ast.literal_eval(f"({params})")
                if isinstance(parsed, tuple):
                    return cls(*parsed)
                return cls(parsed)
            except (ValueError, SyntaxError):
                # Fallback: pass raw string to constructor (may fail gracefully)
                return cls(params)
        else:
            cls = type_map.get(type_str) or String
            return cls()