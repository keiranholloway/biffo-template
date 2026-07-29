"""Generic-CRUD discovery must see an instance's own declarative base (#890).

`_iter_core_crud_models()` walked `TenantScopedModel.__subclasses__()`, so a
model on any other declarative base was invisible to the permissions registry
and therefore to generic CRUD — **no error, no failing test, the tables just did
not appear**.

That shape is what the ADRs produce, not an edge case. ADR-0022 makes
`domains/` user-owned so an instance owns model code, and ADR-0005 effectively
forces a second base: a DDL-imported schema has native `UUID` primary keys, a
real tenant foreign key and soft-delete, none of which `TenantScopedModel`'s
`String(36)` id and `"default"` tenant seam can express. An instance following
both lands here — tabsii-platform's `ImportedTableModel(Base)` is exactly this
shape, and was the source for the fixture below rather than the issue's prose.

The walk now starts at `Base`, which is a strict superset: `TenantScopedModel`
is itself a `Base` subclass, and the `perms and tablename` filter is unchanged.
"""

from typing import Any

from api.models.base import Base
from api.permissions import _iter_core_crud_models
from sqlalchemy.orm import Mapped, mapped_column


class _ImportedTableModel(Base):
    """Stands in for an instance's ADR-0005 base, modelled on the real one.

    Checked against tabsii-platform's ``models/imported.py`` rather than
    inferred from the issue's wording: it is ``class ImportedTableModel(Base)``
    with ``__abstract__ = True`` — a **second abstract base on the same
    declarative base**, not a separate ``DeclarativeBase``.

    That distinction is the whole fix. A separate ``DeclarativeBase`` carries
    its own registry and metadata, so it would be a separate schema surface and
    walking ``Base`` could not reach it either; the first version of this test
    invented one and failed against the correct fix. What ADR-0005 actually
    produces is this: a sibling of ``TenantScopedModel`` under ``Base``,
    invisible to a walk rooted at ``TenantScopedModel`` and reachable from
    ``Base``.
    """

    __abstract__ = True


class InstanceOwnedWidget(_ImportedTableModel):
    __tablename__ = "test_890_instance_widgets"
    __crud_permissions__ = {"list": {"allowed": True, "required_role": []}}
    id: Mapped[str] = mapped_column(primary_key=True)


class CoreWidget(Base):
    __tablename__ = "test_890_core_widgets"
    __crud_permissions__ = {"list": {"allowed": True, "required_role": []}}
    id: Mapped[str] = mapped_column(primary_key=True)


class OptedOutWidget(Base):
    """No __crud_permissions__ — must stay invisible, as plugin models do."""

    __tablename__ = "test_890_opted_out"
    id: Mapped[str] = mapped_column(primary_key=True)


def _discovered() -> set[str]:
    return {getattr(m, "__tablename__", "") for m in _iter_core_crud_models()}


def test_a_model_on_the_instances_own_base_is_discovered() -> None:
    """The branch that does not exist before this change.

    Under the old walk this table is simply absent — which is why the defect
    could ship: nothing raises, and every existing test only ever declared
    models on TenantScopedModel.
    """
    assert "test_890_instance_widgets" in _discovered()


def test_a_model_on_the_core_base_is_still_discovered() -> None:
    """The superset claim, exercised rather than asserted."""
    assert "test_890_core_widgets" in _discovered()


def test_a_model_without_permissions_stays_invisible() -> None:
    """The filter is unchanged: opting in is still a non-empty permission block.

    This is what keeps dynamically-generated plugin models out — they inherit
    the empty default and take their permissions from the manifest path, so a
    plugin table must never be counted twice.
    """
    assert "test_890_opted_out" not in _discovered()


def test_the_abstract_base_itself_is_not_mistaken_for_a_table() -> None:
    """Walking from Base makes TenantScopedModel a candidate for the first time.

    It is abstract and has no __tablename__, so the existing filter excludes it
    — but nothing asserted that before, and it is the one regression widening
    the walk could plausibly introduce.
    """
    names: set[Any] = {m.__name__ for m in _iter_core_crud_models()}
    assert "TenantScopedModel" not in names
    assert "Base" not in names
