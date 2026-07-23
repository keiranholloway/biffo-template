"""Prompt library domain logic — component CRUD and run-creation resolution (ADR-0015).

Transport-agnostic async functions over an ``AsyncSession``, the same shape as
``agent_runs.py``/``orchestration.py``. All queries are tenant-scoped (ADR-0001).

Two responsibilities:

1. **Component CRUD** — create/read/list/update/delete of ``PromptComponent``,
   the authoring surface (the admin router exposes it; Phase 2 adds a UI).
2. **Resolution** — turning a definition's ordered prompt parts into the final
   ``instructions``/``goals`` strings. This is the heart of the ADR (§3/§4): it
   runs **Core-side at run-creation**, fetches each referenced component's
   *current* text, substitutes author-time values, composes the parts in order,
   and writes the *resolved* strings into the run's ``definition_snapshot``. The
   runtime then reads plain strings from the snapshot exactly as before — it
   never learns components exist.

The same resolution powers author-time validation: ``validate_agent_prompts``
attempts a resolution against the current library and discards the result, so a
definition that references a missing component or supplies values that don't
match a component's declared variables is rejected at save time (§6). At
run-creation the *same* checks abort the run loudly rather than emit a
half-substituted prompt — the depth-ceiling posture (ADR-0014 §8).

**The trust boundary (§5) holds by construction.** Resolution reads values only
from the definition's own parts (``VALUES_KEY``) and the component's declared
defaults. There is no parameter, and no code path, feeding the triggering event
payload, a tool result, or any other runtime source into ``values``. Adding one
would reopen the injection vector ADR-0014 §5/§7 closes, and must not be done
without revisiting them.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models.prompt_component import PromptComponent
from .prompt_parts import (
    COMPONENT_KEY,
    INLINE_KEY,
    VALUES_KEY,
    PromptPartsError,
    compose,
    normalize_parts,
    resolve_values,
    substitute,
)

# The two agent-action prompt fields that carry ordered parts. Everything else
# in a definition snapshot (model, tools, max_turns, …) is left untouched.
PROMPT_FIELDS = ("instructions", "goals")


class PromptComponentMissingError(PromptPartsError):
    """A part references a component that does not exist in this tenant.

    A ``PromptPartsError`` (so the routers' single ``except`` maps it to 422),
    but named distinctly because it is the §6 run-creation failure mode: a
    component referenced by a live definition was since deleted, so the run must
    abort loudly rather than run a broken prompt.
    """


class DuplicateComponentNameError(Exception):
    """A component with this name already exists in the tenant (unique per §1)."""

    def __init__(self, name: str) -> None:
        self.name = name
        super().__init__(f"A prompt component named {name!r} already exists in this tenant.")


# ── Component CRUD (tenant-scoped, ADR-0001) ─────────────────────────────────


async def list_components(db: AsyncSession, *, tenant_id: str) -> list[PromptComponent]:
    """Every component in the tenant, oldest first (stable authoring order)."""
    result = await db.execute(
        select(PromptComponent)
        .where(PromptComponent.tenant_id == tenant_id)
        .order_by(PromptComponent.created_at, PromptComponent.id)
    )
    return list(result.scalars().all())


async def get_component(
    db: AsyncSession, *, tenant_id: str, component_id: str
) -> PromptComponent | None:
    """One component by id, tenant-scoped."""
    result = await db.execute(
        select(PromptComponent).where(
            PromptComponent.tenant_id == tenant_id,
            PromptComponent.id == component_id,
        )
    )
    return result.scalar_one_or_none()


async def get_component_by_name(
    db: AsyncSession, *, tenant_id: str, name: str
) -> PromptComponent | None:
    """One component by its referenceable ``name``, tenant-scoped.

    This is how resolution follows a ``{component: <name>}`` reference — the name
    is the contract between a definition and the library.
    """
    result = await db.execute(
        select(PromptComponent).where(
            PromptComponent.tenant_id == tenant_id,
            PromptComponent.name == name,
        )
    )
    return result.scalar_one_or_none()


async def create_component(
    db: AsyncSession,
    *,
    tenant_id: str,
    name: str,
    description: str | None,
    body: str,
    variables: list[dict[str, Any]],
) -> PromptComponent:
    """Create a component, refusing a name already used in the tenant.

    Raises:
        DuplicateComponentNameError: the name is taken (mapped to 409). The
            unique constraint is the backstop; this pre-check gives a clean
            verdict without an IntegrityError poisoning the session.
    """
    if await get_component_by_name(db, tenant_id=tenant_id, name=name) is not None:
        raise DuplicateComponentNameError(name)
    component = PromptComponent(
        tenant_id=tenant_id,
        name=name,
        description=description,
        body=body,
        variables=variables,
    )
    db.add(component)
    await db.flush()
    await db.refresh(component)
    return component


async def update_component(
    db: AsyncSession,
    *,
    tenant_id: str,
    component_id: str,
    name: str,
    description: str | None,
    body: str,
    variables: list[dict[str, Any]],
) -> PromptComponent | None:
    """Update a component in place (§3). Returns ``None`` if it doesn't exist.

    Raises:
        DuplicateComponentNameError: renaming onto a name another component in
            the tenant already holds (mapped to 409).
    """
    component = await get_component(db, tenant_id=tenant_id, component_id=component_id)
    if component is None:
        return None
    if name != component.name:
        clash = await get_component_by_name(db, tenant_id=tenant_id, name=name)
        if clash is not None:
            raise DuplicateComponentNameError(name)
    component.name = name
    component.description = description
    component.body = body
    component.variables = variables
    await db.flush()
    await db.refresh(component)
    return component


async def delete_component(
    db: AsyncSession, *, tenant_id: str, component_id: str
) -> PromptComponent | None:
    """Delete a component, returning the (now-deleted) row, or ``None`` if absent.

    A definition still referencing the deleted component keeps saving fine (the
    reference is by name), but its *next run* aborts loudly at resolution (§6) —
    that is the intended fail-loud, not a silent broken prompt.
    """
    component = await get_component(db, tenant_id=tenant_id, component_id=component_id)
    if component is None:
        return None
    await db.delete(component)
    await db.flush()
    return component


# ── Resolution (Core-side, run-creation — ADR-0015 §3/§4) ────────────────────


async def resolve_prompt_field(db: AsyncSession, *, tenant_id: str, raw: Any, field: str) -> str:
    """Resolve one prompt field (``instructions``/``goals``) to its final string.

    Normalises the ordered parts, and for each part either takes its inline text
    or fetches the referenced component, substitutes its author-time values into
    the body, then composes the parts in order.

    A plain string (the pre-library / inline-only shape) round-trips to itself,
    so nothing that never touches a component changes.

    Raises:
        PromptComponentMissingError: a referenced component doesn't exist.
        PromptPartsError: a part is malformed, an undeclared value key is
            supplied, or a required variable has no value.
    """
    parts = normalize_parts(raw, field=field)
    texts: list[str] = []
    for part in parts:
        if INLINE_KEY in part:
            texts.append(part[INLINE_KEY])
            continue
        name = part[COMPONENT_KEY]
        component = await get_component_by_name(db, tenant_id=tenant_id, name=name)
        if component is None:
            raise PromptComponentMissingError(
                f"{field} references prompt component {name!r}, which does not exist in this tenant"
            )
        resolved = resolve_values(
            component.variables or [],
            part.get(VALUES_KEY, {}),
            component=name,
            field=field,
        )
        texts.append(substitute(component.body, resolved))
    return compose(texts)


async def resolve_definition_snapshot(
    db: AsyncSession, *, tenant_id: str, snapshot: dict[str, Any]
) -> dict[str, Any]:
    """Return a copy of the snapshot with its prompt fields resolved to strings.

    Only ``instructions``/``goals`` are touched, and only when present, so every
    other snapshot field is preserved byte-for-byte. The resolved strings are
    what lands on the run and what the runtime consumes unchanged (§4).

    Raises:
        PromptPartsError / PromptComponentMissingError: as ``resolve_prompt_field``.
    """
    resolved = dict(snapshot)
    for field in PROMPT_FIELDS:
        if field in snapshot:
            resolved[field] = await resolve_prompt_field(
                db, tenant_id=tenant_id, raw=snapshot[field], field=field
            )
    return resolved


async def validate_agent_prompts(
    db: AsyncSession, *, tenant_id: str, action_config: dict[str, Any]
) -> None:
    """Author-time validation of an agent action's prompt parts (§6).

    Attempts the *same* resolution run-creation will perform and discards the
    result, so a definition referencing a missing component, or supplying values
    that don't match a component's declared variables, is rejected at save time.

    Raises:
        PromptPartsError / PromptComponentMissingError: the definition would not
            resolve against the current library.
    """
    for field in PROMPT_FIELDS:
        if field in action_config:
            await resolve_prompt_field(
                db, tenant_id=tenant_id, raw=action_config[field], field=field
            )
