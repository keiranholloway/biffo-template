"""Unit tests for CRUD trigger field derivation (events/event_fields.py, #505).

The builder's "Only when…" conditions become trigger-aware by describing a
trigger's payload fields. For a generic-CRUD ``<table>.<op>`` event the payload
is the mutated row, so the fields are the table's columns — introspected from
the SQLAlchemy model, with enum members surfaced as selectable values and plain
columns degrading to a bare type (free text in the UI).
"""

import enum
from typing import Literal

from api.events.event_fields import fields_for_crud_table, fields_for_payload_model
from api.models.base import TenantScopedModel
from pydantic import BaseModel
from sqlalchemy import Boolean, Integer, String
from sqlalchemy import Enum as SqlEnum
from sqlalchemy.orm import Mapped, mapped_column


class _Priority(enum.Enum):
    low = "low"
    high = "high"


class _WidgetForFields(TenantScopedModel):
    """A throwaway model exercising every branch of the type mapping."""

    __tablename__ = "widgets_for_field_test"
    # A column the model explicitly keeps off the bus — must not become a field.
    __event_exclude__ = ("internal_note",)

    name: Mapped[str] = mapped_column(String(100))
    quantity: Mapped[int] = mapped_column(Integer)
    active: Mapped[bool] = mapped_column(Boolean)
    # A Python-enum-backed column — the enumerable case that drives a value dropdown.
    priority: Mapped[str] = mapped_column(SqlEnum(_Priority))
    # A plain-list SQLAlchemy Enum — also enumerable.
    stage: Mapped[str] = mapped_column(SqlEnum("draft", "shipped", name="stage_enum"))
    internal_note: Mapped[str] = mapped_column(String(100))
    # A sensitive-substring column stripped from every payload — never a field.
    api_key: Mapped[str] = mapped_column(String(100))


def _by_name(table: str) -> dict:
    return {f.name: f for f in fields_for_crud_table(table)}


def test_derives_a_field_per_column_excluding_auto_and_excluded():
    fields = _by_name("widgets_for_field_test")
    # User columns are present.
    assert {"name", "quantity", "active", "priority", "stage"} <= set(fields)
    # Auto-managed columns (ADR-0001) are never offered as filter fields.
    for auto in ("id", "tenant_id", "created_at", "updated_at"):
        assert auto not in fields
    # __event_exclude__ and sensitive-substring columns are off the bus, so off the picker.
    assert "internal_note" not in fields
    assert "api_key" not in fields


def test_maps_column_types_to_coarse_ui_hints():
    fields = _by_name("widgets_for_field_test")
    assert fields["name"].type == "string"
    assert fields["quantity"].type == "number"
    assert fields["active"].type == "boolean"


def test_enum_columns_surface_their_members_as_values():
    fields = _by_name("widgets_for_field_test")
    assert fields["priority"].type == "enum"
    assert fields["priority"].values == ("low", "high")
    assert fields["stage"].type == "enum"
    assert fields["stage"].values == ("draft", "shipped")


def test_plain_column_has_empty_values():
    # A plain column degrades to a type with no values → free-text in the UI.
    fields = _by_name("widgets_for_field_test")
    assert fields["name"].values == ()


def test_labels_are_humanized():
    fields = _by_name("widgets_for_field_test")
    assert fields["name"].label == "Name"


def test_unknown_table_yields_no_fields():
    # No locatable model → skip fields for it rather than crash the catalog.
    assert fields_for_crud_table("no_such_table_anywhere") == []


# ── fields_for_payload_model: the declared-event source (mirrors CRUD above) ──


class _NestedThing(BaseModel):
    x: int


class _Colour(enum.Enum):
    red = "red"
    green = "green"


class _PayloadForFields(BaseModel):
    """Exercises every branch of the annotation → field mapping."""

    name: str
    quantity: int
    ratio: float
    active: bool
    colour: _Colour  # Python enum → enumerable
    stage: Literal["draft", "shipped"]  # Literal → enumerable
    note: str | None  # Optional[str] unwraps to string
    # Skipped: auto-managed names, nested models, and containers.
    id: str
    tenant_id: str
    created_at: str
    payload_token: str  # sensitive substring ("token") → stripped
    nested: _NestedThing
    tags: list[str]
    meta: dict[str, str]


def _payload_by_name() -> dict:
    return {f.name: f for f in fields_for_payload_model(_PayloadForFields)}


def test_payload_model_derives_a_field_per_scalar_column():
    fields = _payload_by_name()
    assert {"name", "quantity", "ratio", "active", "colour", "stage", "note"} == set(fields)
    # Auto-managed, sensitive, nested and container fields are all excluded.
    for absent in ("id", "tenant_id", "created_at", "payload_token", "nested", "tags", "meta"):
        assert absent not in fields


def test_payload_model_maps_types_to_coarse_hints():
    fields = _payload_by_name()
    assert fields["name"].type == "string"
    assert fields["quantity"].type == "number"
    assert fields["ratio"].type == "number"
    assert fields["active"].type == "boolean"
    assert fields["note"].type == "string"  # Optional[str] unwrapped


def test_payload_model_enum_and_literal_surface_values():
    fields = _payload_by_name()
    assert fields["colour"].type == "enum"
    assert fields["colour"].values == ("red", "green")
    assert fields["stage"].type == "enum"
    assert fields["stage"].values == ("draft", "shipped")


def test_payload_model_labels_are_humanized():
    assert _payload_by_name()["name"].label == "Name"
