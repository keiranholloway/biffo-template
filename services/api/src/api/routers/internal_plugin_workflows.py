"""Internal, SigV4-only self-service workflow declaration for plugins (issue #1593).

POST /api/v1/internal/plugins/me/workflows/seed — a plugin declares its own
``WorkflowDefinition`` rows, scoped to its own verified identity
(``ServicePrincipal.logical_names``), not a caller-supplied plugin name — the
same shape and the same reason as ``internal_plugin_config.py``, whose
docstring names the threat: a caller-supplied plugin name *"would let any
allowlisted service read another plugin's config."* Here it would let one
plugin overwrite another's orchestration.

This is deliberately **not** ``internal_plugin_config``'s insert-if-absent
seed. That route exists to guarantee a config row exists without ever
clobbering an admin's live edit — the right contract for a human-editable
business setting. A ``WorkflowDefinition`` a plugin declares here is not
that: it is the plugin's own internal machinery (e.g. an agent fan-in
synthesis workflow), and the entire point of this route is that the plugin's
own declaration is the current truth on every cold start, so a stale
snapshot frozen at first write — the failure this issue closes — cannot
persist past the next deploy. So this route **upserts**: a re-declared
``definition_key`` overwrites the stored row's fields every time, not only
the first time.

That is safe specifically because plugin-declared rows and admin-authored
rows can never collide. Every row this route touches carries
``owner_plugin`` set to the caller's own resolved identity; every row
``orchestration.py``'s human CRUD creates leaves ``owner_plugin`` NULL and is
therefore invisible to this route's pre-read (``_existing_by_key`` filters on
``owner_plugin == plugin_name``). An admin's hand-authored automation is
never at risk of being silently overwritten by a plugin's cold-start seed,
and a plugin's own declared workflow is never visible to — or editable by —
the admin CRUD surface, which has no ``owner_plugin`` concept at all.

Deliberately deferred, and named here rather than left silent:

- **No emitted ``WORKFLOW_DEFINITION_CREATED``/``UPDATED`` events.** Those
  events exist for the admin-facing audit/history surface (#432); a
  plugin re-declaring its own internal machinery on every cold start is not
  an event an operator needs to see, any more than ``internal_plugin_config
  .seed_config`` writes a ``PluginChatAgentHistory`` row for a seed.
- **No scope-authorization check.** ``WorkflowDefinitionBody`` still validates
  ``scope``'s *shape* (mirrored from the human CRUD, unchanged), but
  ``_require_scope_access`` — "may THIS caller act at this scope" — is a
  concept for a human whose own reach can be exceeded; there is no analogous
  notion for a service principal, whose isolation boundary is
  ``owner_plugin``, not scope. A plugin may declare a scoped definition; it
  simply is not authorized *against* anything beyond owning its own rows.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..middleware.service_auth import ServicePrincipal, require_service_principal
from ..models.orchestration import WorkflowDefinition
from ..orchestration import is_known_trigger
from ..prompt_library import validate_agent_prompts
from ..prompt_parts import PromptPartsError
from ..schemas.orchestration import SeedWorkflowDefinitionRequest, SeedWorkflowDefinitionResponse

router = APIRouter(prefix="/internal/plugins/me/workflows", tags=["internal:plugins"])


def _own_plugin_name(principal: ServicePrincipal) -> str:
    """The caller's own plugin identity, or 403.

    Copied from ``internal_plugin_config._own_plugin_name`` rather than
    generalised — ``internal_plugin_storage._own_plugin`` made the same
    choice, for the same reason: the two will diverge if one ever needs to
    admit a non-plugin caller, and a shared helper would make that a silent
    change to every route that imports it.

    Requires exactly one logical name. A principal resolving to several is not
    a plugin acting as itself, and picking one would be a guess about
    identity — the one thing this must not guess.
    """
    names = principal.logical_names
    if len(names) != 1:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Could not resolve a single plugin identity for this caller.",
        )
    (name,) = names
    return name.removeprefix("system:")


async def _existing_by_key(
    db: AsyncSession, *, tenant_id: str, plugin_name: str
) -> dict[str, WorkflowDefinition]:
    """Every row this plugin already owns, keyed by its own ``definition_key``.

    Scoped to ``owner_plugin == plugin_name`` — an admin-authored row (which
    never sets ``owner_plugin``) can never appear here, so it can never be
    found, matched or overwritten by a seed call. A fast path only, same
    caveat as ``internal_plugin_config._existing_agent_keys``: it cannot see a
    row a concurrent cold start has not committed yet. ``_apply_fields``'s
    caller handles that race by retrying as an update on conflict.
    """
    rows = await db.scalars(
        select(WorkflowDefinition).where(
            WorkflowDefinition.tenant_id == tenant_id,
            WorkflowDefinition.owner_plugin == plugin_name,
        )
    )
    return {row.definition_key: row for row in rows if row.definition_key is not None}


def _apply_fields(row: WorkflowDefinition, definition: SeedWorkflowDefinitionRequest) -> None:
    """Write ``definition``'s declared values onto ``row`` — every mutable field.

    Unconditional, unlike ``internal_plugin_config.seed_config``: this route's
    whole point is that the plugin's declaration always wins, so there is no
    "existing value wins" branch to preserve. ``run_as_user_id``/``run_as_kind``
    are deliberately never touched — they stay at the model's own defaults
    (``None`` / ``"system"``), the same state every write-back-incapable
    definition is already in (ADR-0027 §2): nobody vouched for this row as a
    person, so it can never carry a write-back, which is the correct,
    fail-closed outcome for a machine-declared definition.
    """
    row.name = definition.name
    row.trigger_source = definition.trigger_source
    row.trigger_detail_type = definition.trigger_detail_type
    row.trigger_filter = definition.trigger_filter
    row.action_type = definition.action_type
    row.action_config = definition.action_config
    row.enabled = definition.enabled
    row.schedule_config = definition.schedule_config
    row.scope = definition.scope


async def _require_known_trigger(
    db: AsyncSession, *, tenant_id: str, source: str, detail_type: str
) -> None:
    """422 unless the trigger is a declared or already-observed event.

    Copied from ``routers.orchestration._require_known_trigger`` (same
    reasoning, same function signature) rather than imported — that function
    is private to the human CRUD router and this route has no other coupling
    to it.
    """
    if not await is_known_trigger(db, tenant_id=tenant_id, source=source, detail_type=detail_type):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"Unknown trigger: {source}/{detail_type}",
        )


async def _require_resolvable_agent_prompts(
    db: AsyncSession, *, tenant_id: str, action_type: str, action_config: dict
) -> None:
    """422 unless an agent action's prompt parts resolve against the library.

    Copied from ``routers.orchestration._require_resolvable_agent_prompts``
    for the same reason as ``_require_known_trigger`` above. A no-op for every
    non-agent action.
    """
    if action_type != "agent":
        return
    try:
        await validate_agent_prompts(db, tenant_id=tenant_id, action_config=action_config)
    except PromptPartsError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)
        ) from exc


@router.post("/seed", response_model=list[SeedWorkflowDefinitionResponse])
async def seed_workflows(
    definitions: list[SeedWorkflowDefinitionRequest],
    principal: ServicePrincipal = Depends(require_service_principal),
    db: AsyncSession = Depends(get_db),
) -> list[SeedWorkflowDefinitionResponse]:
    """Upsert the caller's own workflow definitions, keyed by ``definition_key``.

    Runs on every plugin cold start (that is the point — see the module
    docstring). Idempotent in the sense that matters here: calling it twice
    with the *same* definitions leaves the stored rows unchanged in effect,
    and calling it with *changed* values updates the stored rows to match —
    unlike ``internal_plugin_config.seed_config``, which is idempotent by
    refusing the second write outright.

    Concurrency: a burst of simultaneous cold starts (a fresh deploy replaces
    every warm Lambda at once, #924) can race two requests past the pre-read
    for the same brand-new ``definition_key``. Both attempt an INSERT inside a
    SAVEPOINT; the loser's SAVEPOINT rolls back on the unique-index conflict,
    and — because this route upserts rather than merely reports "already
    existed" — the loser then re-fetches the winner's row and applies its own
    declared values to it too. Whichever request's write lands last wins, but
    since every concurrent caller in this scenario is the *same* build
    declaring the *same* values, that is a no-op in practice.

    Args:
        definitions: Definitions to declare. Each must include all required
            fields plus ``definition_key``. Empty list is valid and changes
            nothing.
        principal: Verified service identity (resolved from ARN; never
            caller-supplied).
        db: Database session.

    Returns:
        One result per input definition, reporting whether it was created or
        updated in place.
    """
    if not definitions:
        return []

    plugin_name = _own_plugin_name(principal)

    existing = await _existing_by_key(db, tenant_id=principal.tenant_id, plugin_name=plugin_name)

    results: list[SeedWorkflowDefinitionResponse] = []

    for definition in definitions:
        await _require_known_trigger(
            db,
            tenant_id=principal.tenant_id,
            source=definition.trigger_source,
            detail_type=definition.trigger_detail_type,
        )
        await _require_resolvable_agent_prompts(
            db,
            tenant_id=principal.tenant_id,
            action_type=definition.action_type,
            action_config=definition.action_config,
        )

        row = existing.get(definition.definition_key)
        created = row is None

        if row is None:
            row = WorkflowDefinition(
                tenant_id=principal.tenant_id,
                owner_plugin=plugin_name,
                definition_key=definition.definition_key,
            )
            _apply_fields(row, definition)
            try:
                # SAVEPOINT: a concurrent seed that committed this exact key
                # between the pre-read and here rolls back this insert only,
                # rather than poisoning the whole batch's transaction. Same
                # idiom as internal_plugin_config.seed_config — object added
                # inside the nested block so a rollback also detaches it from
                # the session's pending state.
                async with db.begin_nested():
                    db.add(row)
                    await db.flush()
            except IntegrityError:
                # Somebody else created it first. Unlike seed_config, that is
                # not "done" here — fetch the winner's row and write our own
                # declared values onto it too, so the upsert contract holds
                # regardless of who created the row.
                existing_row = await db.scalar(
                    select(WorkflowDefinition).where(
                        WorkflowDefinition.tenant_id == principal.tenant_id,
                        WorkflowDefinition.owner_plugin == plugin_name,
                        WorkflowDefinition.definition_key == definition.definition_key,
                    )
                )
                if existing_row is None:  # pragma: no cover — defensive only
                    raise
                _apply_fields(existing_row, definition)
                await db.flush()
                row = existing_row
                created = False
        else:
            _apply_fields(row, definition)
            await db.flush()

        existing[definition.definition_key] = row
        results.append(
            SeedWorkflowDefinitionResponse(
                definition_key=definition.definition_key,
                definition_id=row.id,
                created=created,
            )
        )

    return results
