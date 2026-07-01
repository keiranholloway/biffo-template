"""Tests for plugin table definition models."""

import pytest
from pydantic import ValidationError

from api.models.plugin_table import (
    ColumnDefinition,
    IndexDefinition,
    PluginTableDefinition,
)


class TestColumnDefinition:
    """Test ColumnDefinition model."""

    def test_minimal_column(self):
        col = ColumnDefinition(name="id", type="String(36)", primary_key=True)
        assert col.name == "id"
        assert col.type == "String(36)"
        assert col.primary_key is True
        assert col.nullable is False
        assert col.index is False

    def test_column_with_all_fields(self):
        col = ColumnDefinition(
            name="email",
            type="String(255)",
            nullable=False,
            index=True,
            default='"unknown"',
            description="User email address",
        )
        assert col.name == "email"
        assert col.type == "String(255)"
        assert col.nullable is False
        assert col.index is True
        assert col.default == '"unknown"'
        assert col.description == "User email address"

    def test_nullable_defaults_to_false(self):
        col = ColumnDefinition(name="name", type="String(100)")
        assert col.nullable is False

    def test_index_defaults_to_false(self):
        col = ColumnDefinition(name="name", type="String(100)")
        assert col.index is False


class TestIndexDefinition:
    """Test IndexDefinition model."""

    def test_minimal_index(self):
        idx = IndexDefinition(name="idx_users_email", columns=["email"])
        assert idx.name == "idx_users_email"
        assert idx.columns == ["email"]
        assert idx.unique is False

    def test_unique_index(self):
        idx = IndexDefinition(name="idx_users_email", columns=["email"], unique=True)
        assert idx.unique is True

    def test_multi_column_index(self):
        idx = IndexDefinition(
            name="idx_orders_user_date",
            columns=["user_id", "created_at"],
            unique=True,
        )
        assert idx.columns == ["user_id", "created_at"]
        assert idx.unique is True


class TestPluginTableDefinition:
    """Test PluginTableDefinition model."""

    def test_minimal_table(self):
        table = PluginTableDefinition(name="roles")
        assert table.name == "roles"
        # Auto-columns: id, tenant_id, created_at, updated_at
        assert len(table.columns) == 4
        assert table.indexes == []

    def test_table_with_columns(self):
        cols = [
            ColumnDefinition(name="id", type="String(36)", primary_key=True),
            ColumnDefinition(name="name", type="String(100)"),
        ]
        table = PluginTableDefinition(name="roles", columns=cols)
        # User provides 'id', so auto 'id' is deduplicated: 2 user + 3 auto = 5
        assert len(table.columns) == 5
        assert table.columns[0].name == "id"
        assert table.columns[1].name == "name"

    def test_table_with_indexes(self):
        cols = [
            ColumnDefinition(name="id", type="String(36)", primary_key=True),
            ColumnDefinition(name="slug", type="String(100)"),
        ]
        idxs = [IndexDefinition(name="idx_roles_slug", columns=["slug"])]
        table = PluginTableDefinition(name="roles", columns=cols, indexes=idxs)
        # User provides 'id', so auto 'id' is deduplicated: 2 user + 3 auto = 5
        assert len(table.columns) == 5
        assert len(table.indexes) == 1
        assert table.indexes[0].name == "idx_roles_slug"

    def test_auto_generates_primary_key(self):
        table = PluginTableDefinition(name="permissions")
        # 4 auto columns: id, tenant_id, created_at, updated_at
        assert len(table.columns) == 4
        pk = next(c for c in table.columns if c.name == "id")
        assert pk.primary_key is True

    def test_auto_adds_tenant_id_column(self):
        table = PluginTableDefinition(name="permissions")
        col_names = [c.name for c in table.columns]
        assert "tenant_id" in col_names
        tenant_col = next(c for c in table.columns if c.name == "tenant_id")
        assert tenant_col.type == "String(64)"
        assert tenant_col.index is True

    def test_auto_adds_timestamp_columns(self):
        table = PluginTableDefinition(name="permissions")
        col_names = [c.name for c in table.columns]
        assert "created_at" in col_names
        assert "updated_at" in col_names

    def test_duplicate_column_names_raise_error(self):
        cols = [
            ColumnDefinition(name="id", type="String(36)", primary_key=True),
            ColumnDefinition(name="id", type="String(100)"),
        ]
        with pytest.raises(ValidationError):
            PluginTableDefinition(name="bad_table", columns=cols)

    def test_duplicate_index_names_raise_error(self):
        idxs = [
            IndexDefinition(name="idx_dup", columns=["a"]),
            IndexDefinition(name="idx_dup", columns=["b"]),
        ]
        with pytest.raises(ValidationError):
            PluginTableDefinition(name="bad_table", indexes=idxs)

    def test_index_references_valid_columns(self):
        cols = [
            ColumnDefinition(name="id", type="String(36)", primary_key=True),
            ColumnDefinition(name="email", type="String(255)"),
        ]
        idxs = [IndexDefinition(name="idx_bad", columns=["nonexistent"])]
        with pytest.raises(ValueError):
            PluginTableDefinition(name="bad_table", columns=cols, indexes=idxs)

    def test_to_sqlalchemy_model(self):
        cols = [
            ColumnDefinition(name="id", type="String(36)", primary_key=True),
            ColumnDefinition(name="name", type="String(100)"),
        ]
        table = PluginTableDefinition(name="my_table", columns=cols)
        model_class = table.to_sqlalchemy_model()
        assert model_class.__tablename__ == "my_table"
        # Should have id, tenant_id, created_at, updated_at, name
        assert hasattr(model_class, "id")
        assert hasattr(model_class, "tenant_id")
        assert hasattr(model_class, "created_at")
        assert hasattr(model_class, "updated_at")
        assert hasattr(model_class, "name")

    def test_to_sqlalchemy_model_inherits_base(self):
        from api.models.base import Base
        table = PluginTableDefinition(name="test_tbl")
        model_class = table.to_sqlalchemy_model()
        assert issubclass(model_class, Base)