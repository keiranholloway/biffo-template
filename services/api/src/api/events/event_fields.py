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

import enum
import types
import typing
from typing import Any

from pydantic import BaseModel
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


def _map_annotation(annotation: Any) -> tuple[str, tuple[str, ...]] | None:
    """Map a Python type annotation to a coarse ``(type, values)`` UI hint.

    Mirrors ``_map_column_type`` for the Pydantic-model source. Returns ``None``
    for anything that is not a scalar filter field (a nested model, a ``dict``/
    ``list``, a ``datetime``, an ambiguous union) so it is skipped rather than
    surfaced as an un-filterable condition. ``Optional[X]`` unwraps to ``X``;
    ``Enum`` subclasses and ``Literal[...]`` become enumerable values.
    """
    origin = typing.get_origin(annotation)
    args = typing.get_args(annotation)
    if origin is typing.Union or origin is types.UnionType:
        non_none = [a for a in args if a is not type(None)]
        return _map_annotation(non_none[0]) if len(non_none) == 1 else None
    if origin is typing.Literal:
        return "enum", tuple(str(a) for a in args)
    if isinstance(annotation, type):
        if issubclass(annotation, enum.Enum):
            return "enum", tuple(str(member.value) for member in annotation)
        if issubclass(annotation, bool):  # bool before int — bool subclasses int
            return "boolean", ()
        if issubclass(annotation, (int, float)):
            return "number", ()
        if issubclass(annotation, str):
            return "string", ()
    return None


def fields_for_payload_model(model: type[BaseModel]) -> list[EventField]:
    """The :class:`EventField`s a declared event's payload exposes (#505).

    The single source of truth for a hand-emitted event's fields: derive them
    from the event's Pydantic payload model exactly as ``fields_for_crud_table``
    derives them from a table's columns. Same exclusions (auto-managed and
    sensitive-substring names) and same graceful degradation — a model field
    whose type is not a scalar (nested object, ``dict``, ``datetime``) is simply
    skipped, and any failure yields ``[]`` (UI falls back to free text) rather
    than breaking the catalog.
    """
    try:
        out: list[EventField] = []
        for name, info in model.model_fields.items():
            if name in AUTO_COLUMN_NAMES or any(s in name.lower() for s in _SENSITIVE_SUBSTRINGS):
                continue
            mapped = _map_annotation(info.annotation)
            if mapped is None:
                continue
            field_type, values = mapped
            out.append(
                EventField(
                    name=name,
                    label=info.title or _humanize(name),
                    type=field_type,
                    values=values,
                )
            )
        return out
    except Exception:  # noqa: BLE001 — advisory metadata must never break the catalog
        return []
