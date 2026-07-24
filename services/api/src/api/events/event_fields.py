"""Derive an event's payload fields for the workflow-builder catalog (#505).

Two sources feed the builder's "Only when…" condition editor:

- **Declared events** describe their own payload with ``EventType.fields`` (see
  ``registry.EventField``) — used verbatim.
- **Generic-CRUD events** (``<table>.<op>``, ADR-0002/#222) carry the mutated
  row, so their fields *are the table's columns*. This module introspects the
  SQLAlchemy model for a table and emits one :class:`EventField` per column that
  actually reaches the bus.

The metadata is **advisory UI only** — it never tightens ``trigger_filter``
validation. It degrades gracefully: a table with no locatable model yields no
fields (the UI falls back to free text), and a plain column gets its coarse type
with empty ``values``.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import Boolean, Float, Integer, Numeric
from sqlalchemy import Enum as SqlEnum

from ..routing.crud_handlers import _SENSITIVE_SUBSTRINGS, AUTO_COLUMN_NAMES
from .registry import EventField


def _humanize(name: str) -> str:
    """A column name as a UI label: ``agent_name`` -> ``Agent name``."""
    return name.replace("_", " ").strip().capitalize() or name


def _map_column_type(sa_type: Any) -> tuple[str, tuple[str, ...]]:
    """Map a SQLAlchemy column type to a coarse ``(type, values)`` UI hint.

    ``Enum`` is checked first because SQLAlchemy's ``Enum`` subclasses ``String``;
    its ``.enums`` are the string members (whether declared as a plain list or
    backed by a Python ``enum.Enum``). Everything numeric collapses to
    ``"number"``, booleans to ``"boolean"``, and anything else to ``"string"``.
    """
    if isinstance(sa_type, SqlEnum):
        return "enum", tuple(sa_type.enums or ())
    if isinstance(sa_type, Boolean):
        return "boolean", ()
    if isinstance(sa_type, (Integer, Numeric, Float)):
        return "number", ()
    return "string", ()


def _model_for_table(table: str) -> type[Any] | None:
    """The mapped model whose ``__tablename__`` is ``table``, or ``None``.

    Walks SQLAlchemy's declarative mapper registry (``Base.registry``), which
    holds both hand-written core models and the models built dynamically from
    plugin manifests (``PluginTableDefinition.to_sqlalchemy_model``). Returns
    ``None`` for a table with no locatable model rather than raising, so the
    catalog never crashes on an unknown table.
    """
    from ..models.base import Base

    for mapper in Base.registry.mappers:
        cls = mapper.class_
        if getattr(cls, "__tablename__", None) == table:
            return cls
    return None


def fields_for_crud_table(table: str) -> list[EventField]:
    """The :class:`EventField`s a ``<table>.<op>`` CRUD event exposes (#505).

    The fields are exactly the columns that reach the bus: every column of the
    table's model minus the auto-managed ones (``id``/``tenant_id``/timestamps),
    the model's ``__event_exclude__``, and any sensitive-substring column the
    payload builder strips (``_event_payload``). Returns ``[]`` when the table
    has no locatable model or anything about the introspection fails — the UI
    then falls back to free text for that trigger.
    """
    try:
        model = _model_for_table(table)
        if model is None:
            return []
        exclude = set(AUTO_COLUMN_NAMES) | set(getattr(model, "__event_exclude__", ()) or ())
        out: list[EventField] = []
        for col in model.__table__.columns:
            name = col.name
            if name in exclude or any(s in name.lower() for s in _SENSITIVE_SUBSTRINGS):
                continue
            field_type, values = _map_column_type(col.type)
            out.append(EventField(name=name, label=_humanize(name), type=field_type, values=values))
        return out
    except Exception:  # noqa: BLE001 — advisory metadata must never break the catalog
        return []
