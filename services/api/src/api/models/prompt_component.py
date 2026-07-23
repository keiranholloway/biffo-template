"""Prompt library — the reusable, optionally-parameterised prompt component (ADR-0015).

A ``PromptComponent`` is a named, reusable block of prompt text (``body``) that a
workflow definition's agent action references by ``name`` instead of duplicating
inline. It may declare ``variables`` — author-time slots interpolated into the
body — so one component serves a whole parameterised family (one definition per
region/brand, each supplying different ``values``). Zero variables is the
house-style case (ADR-0015 §1).

**Mutable in place, no version table** (ADR-0015 §3). Editing a component
propagates to every referencing agent on its next run — that is the entire point,
since a copy would leave the duplication this table exists to remove. Propagation
is made safe by *live resolution + the run snapshot*: Core resolves references at
run-creation and freezes the composed result into the ADR-0014 §10
``definition_snapshot``, so a run records exactly what it ran. The snapshot *is*
the history; no per-component revision is kept.

Like ``WorkflowDefinition`` and ``AgentRun``, this deliberately does **not**
declare ``__crud_permissions__``: it is not exposed through the generic-CRUD
layer (ADR-0004). Its ``variables`` need structural validation and its ``name``
needs a clean per-tenant uniqueness verdict — the same reasons the workflow
builder's CRUD is hand-written — so it gets an explicit, admin-gated router
(``routers/admin/prompt_components.py``).
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .base import TenantScopedModel


class PromptComponent(TenantScopedModel):
    """A reusable, optionally-parameterised prompt component (ADR-0015 §1)."""

    __tablename__ = "prompt_components"
    __table_args__ = (
        # ``name`` is the referenceable identifier, so it is unique per tenant
        # (ADR-0001): a definition references a component by name, and two
        # components sharing a name in one tenant would make the reference
        # ambiguous. Different tenants may reuse the same name.
        UniqueConstraint("tenant_id", "name", name="uq_prompt_component_name"),
    )

    # The referenceable identifier a definition names in a `{component: ...}` part.
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    # What the component is for — drives the authoring picker (Phase 2).
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # The prompt text, which may contain `{{variable}}` placeholders.
    body: Mapped[str] = mapped_column(Text, nullable=False)
    # Declared variable slots: a list of {name, description?, required, default?}.
    # Validated by prompt_parts.validate_variable_declarations before it lands.
    variables: Mapped[list[Any]] = mapped_column(JSON, nullable=False, default=list)
