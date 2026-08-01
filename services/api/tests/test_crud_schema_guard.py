"""The generic-CRUD schema guard (#1018).

The bug: a model declares ``tenant_id`` (usually inherited from a base class),
generic CRUD filters every query by it unconditionally, and the table's real
hand-written DDL never had the column. Nothing compared the two, so it surfaced
as a 500 on a live click-through.

These tests exercise the comparison itself, which is deliberately pure — the
API's own lane builds its schema from ORM metadata, so it is structurally
incapable of testing the real-database half. That half runs at deploy.
"""

from api.crud_schema_guard import (
    ColumnDrift,
    declared_columns,
    find_column_drift,
    format_drift_error,
)
from api.models.base import Base
from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column


class _ImportedBase(Base):
    """Stands in for an instance's own declarative base (ADR-0005/ADR-0022).

    The real one is ``tabsii-platform``'s ``ImportedTableModel``; the point is
    that ``tenant_id`` arrives by INHERITANCE, which is why reading a class body
    would miss it.
    """

    __abstract__ = True

    tenant_id: Mapped[str] = mapped_column(String(36), nullable=False)


class _GuardWidget(_ImportedBase):
    __tablename__ = "guard_widgets"
    __crud_permissions__ = {"read": {"allowed": True}}

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(80))


class TestDeclaredColumns:
    def test_includes_columns_inherited_from_a_base_class(self):
        """The bug's whole shape: ``tenant_id`` is never written in the model's
        own class body, so anything reading the class source would miss it.

        Note it IS in ``__dict__`` after mapping — SQLAlchemy's declarative
        machinery copies inherited columns onto the subclass — which is exactly
        why the source-level fact is asserted via ``__annotations__`` instead.
        Reading ``__table__.columns`` is the only reliable answer.
        """
        assert "tenant_id" not in _GuardWidget.__annotations__
        assert declared_columns(_GuardWidget) == {"id", "name", "tenant_id"}

    def test_model_without_a_table_yields_nothing(self):
        class NotMapped:
            pass

        assert declared_columns(NotMapped) == set()


class TestFindColumnDrift:
    def test_matching_schema_is_not_drift(self):
        drift = find_column_drift(
            {"guard_widgets": {"id", "name", "tenant_id"}},
            {"guard_widgets": {"id", "name", "tenant_id"}},
        )
        assert drift == []

    def test_missing_tenant_id_is_drift(self):
        """The exact production failure: model says tenant_id, DDL does not."""
        drift = find_column_drift(
            {"guard_widgets": {"id", "name", "tenant_id"}},
            {"guard_widgets": {"id", "name"}},
        )
        assert drift == [
            ColumnDrift(table="guard_widgets", missing=("tenant_id",), table_exists=True)
        ]

    def test_extra_columns_in_the_database_are_fine(self):
        """An imported table may carry columns the ORM has no opinion about —
        flagging those would make the guard unusable on any real instance."""
        drift = find_column_drift(
            {"guard_widgets": {"id", "tenant_id"}},
            {"guard_widgets": {"id", "tenant_id", "legacy_code", "imported_at"}},
        )
        assert drift == []

    def test_absent_table_is_reported_as_absent_not_as_empty(self):
        """Distinct failures deserve distinct messages: a missing table is not
        a table that happens to have no columns."""
        drift = find_column_drift({"guard_widgets": {"id", "tenant_id"}}, {})
        assert len(drift) == 1
        assert drift[0].table_exists is False
        assert drift[0].missing == ("id", "tenant_id")
        assert "does not exist" in drift[0].describe()

    def test_reports_every_offending_table_not_just_the_first(self):
        """One deploy failure should name all of them, or fixing them is a
        sequence of deploys rather than one."""
        drift = find_column_drift(
            {"a": {"tenant_id"}, "b": {"tenant_id"}, "c": {"tenant_id"}},
            {"a": {"tenant_id"}, "b": set(), "c": set()},
        )
        assert [d.table for d in drift] == ["b", "c"]

    def test_nothing_declared_is_not_drift(self):
        assert find_column_drift({}, {"guard_widgets": {"id"}}) == []


class TestFormatDriftError:
    def test_names_the_table_and_the_column_and_says_what_to_do(self):
        msg = format_drift_error(
            [ColumnDrift(table="guard_widgets", missing=("tenant_id",), table_exists=True)]
        )
        assert "guard_widgets" in msg
        assert "tenant_id" in msg
        # The fix must be obvious from the deploy log without reproducing it.
        assert "__crud_permissions__" in msg
