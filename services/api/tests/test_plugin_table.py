"""Tests for plugin table definition models."""

import pytest
from pydantic import ValidationError

from api.models.plugin_table import (
    ColumnDefinition,
    IndexDefinition,
    PluginTableDefinition,
    resolve_type_call,
)


class TestResolveTypeCall:
    """Test the shared, safe type-string parser (issue #28)."""

    def test_bare_type_has_no_args(self):
        assert resolve_type_call("Integer") == ("Integer", [], {})

    def test_single_positional_arg(self):
        assert resolve_type_call("String(36)") == ("String", [36], {})

    def test_multiple_positional_args_stay_typed(self):
        # Regression: precision/scale must stay ints, not become '10'/'2'.
        assert resolve_type_call("Numeric(10, 2)") == ("Numeric", [10, 2], {})

    def test_keyword_arg(self):
        # Regression: timezone=True was previously dropped silently.
        assert resolve_type_call("DateTime(timezone=True)") == (
            "DateTime",
            [],
            {"timezone": True},
        )

    def test_mixed_positional_and_keyword_args(self):
        assert resolve_type_call("Numeric(10, 2, asdecimal=False)") == (
            "Numeric",
            [10, 2],
            {"asdecimal": False},
        )

    def test_non_literal_expression_is_rejected(self):
        # Regression: this used to be spliced verbatim into generated
        # migration source and executed by Alembic.
        with pytest.raises(ValueError):
            resolve_type_call("String(__import__('os').system('id'))")


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
            ColumnDefinition(name="name", type="String(100)"),
        ]
        table = PluginTableDefinition(name="roles", columns=cols)
        # 1 user column + 4 auto columns (id, tenant_id, created_at, updated_at)
        assert len(table.columns) == 5
        assert table.columns[0].name == "name"
        assert any(c.name == "id" for c in table.columns)

    def test_table_with_indexes(self):
        cols = [
            ColumnDefinition(name="slug", type="String(100)"),
        ]
        idxs = [IndexDefinition(name="idx_roles_slug", columns=["slug"])]
        table = PluginTableDefinition(name="roles", columns=cols, indexes=idxs)
        # 1 user column + 4 auto columns
        assert len(table.columns) == 5
        assert len(table.indexes) == 1
        assert table.indexes[0].name == "idx_roles_slug"

    def test_manifest_cannot_redeclare_reserved_auto_column(self):
        """A manifest declaring its own tenant_id must be rejected outright —
        silently accepting it (e.g. as nullable/unindexed) would let a plugin
        weaken the tenant-isolation guarantee ADR-0001 requires (issue #28)."""
        cols = [ColumnDefinition(name="tenant_id", type="String(64)", nullable=True)]
        with pytest.raises(ValidationError):
            PluginTableDefinition(name="bad_table", columns=cols)

    def test_manifest_cannot_redeclare_id_column(self):
        cols = [ColumnDefinition(name="id", type="String(36)", primary_key=True)]
        with pytest.raises(ValidationError):
            PluginTableDefinition(name="bad_table", columns=cols)

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
            ColumnDefinition(name="email", type="String(255)"),
        ]
        idxs = [IndexDefinition(name="idx_bad", columns=["nonexistent"])]
        with pytest.raises(ValueError):
            PluginTableDefinition(name="bad_table", columns=cols, indexes=idxs)

    def test_to_sqlalchemy_model(self):
        cols = [
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

    def test_to_sqlalchemy_model_preserves_tenant_scoped_defaults(self):
        """Regression test for issue #28: auto columns must be inherited from
        TenantScopedModel as-is, not rebuilt as plain Column(...), or their
        Python-side defaults (uuid4 id, "default" tenant_id) are lost and
        inserting a row without explicitly setting them raises IntegrityError.
        """
        from sqlalchemy import create_engine
        from sqlalchemy.orm import Session
        from api.models.base import Base

        cols = [ColumnDefinition(name="label", type="String(100)")]
        table = PluginTableDefinition(name="widgets", columns=cols)
        model_class = table.to_sqlalchemy_model()

        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine, tables=[model_class.__table__])
        with Session(engine) as session:
            row = model_class(label="a widget")
            session.add(row)
            session.commit()
            assert row.id is not None
            assert row.tenant_id == "default"

    def test_to_sqlalchemy_model_resolves_timezone_aware_datetime(self):
        """Regression test for issue #28: DateTime(timezone=True) params were
        silently dropped, producing naive datetimes despite the DB column
        being TIMESTAMP WITH TIME ZONE."""
        table = PluginTableDefinition(name="gizmos")
        model_class = table.to_sqlalchemy_model()
        assert model_class.__table__.columns["created_at"].type.timezone is True

    def test_to_sqlalchemy_model_inherits_base(self):
        from api.models.base import Base

        table = PluginTableDefinition(name="test_tbl")
        model_class = table.to_sqlalchemy_model()
        assert issubclass(model_class, Base)
