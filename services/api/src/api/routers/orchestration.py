"""User-facing orchestration API: workflow-definition CRUD + run history.

Cognito-authenticated, tenant-scoped (ADR-0001/ADR-0004). This is the editing
surface the orchestration domain deferred — distinct from the engine's
IAM-signed internal API (``routers/internal_orchestration.py``, ADR-0009) and
from the generic-CRUD layer: ``action_config`` needs shape validation per
``action_type``, and "toggle enabled" is a bespoke verb, so it is hand-written.

Authorization on the workflow CRUD (not the catalog or run history) is a
platform admin OR the registered scope authorizer (``orchestration_authz.py``,
docs/implementation/0003-hierarchy-scoped-workflows Phase 3): a caller who
genuinely owns a definition's target scope (e.g. a brand manager, via an
instance's own role-assignment model) may act on it without being a full
admin. The default authorizer is fail-closed, so a base deployment (nothing
registered) keeps today's exact all-or-nothing admin gate.

Two routers are exported, both mounted in main.py and both covered by the JWT
``$default`` API Gateway route (no Terraform change needed):

- ``router`` at ``/api/v1/orchestration/workflows`` — the builder's CRUD.
- ``runs_router`` at ``/api/v1/orchestration/runs`` — read-only run history. A
  sibling prefix rather than ``workflows/runs`` so it can never be shadowed by
  the ``workflows/{definition_id}`` path parameter.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..dependencies import ADMIN_GROUP, require_admin
from ..events import emit_event
from ..events.event_fields import fields_for_crud_table, trigger_excluded_ops
from ..events.registry import (
    WORKFLOW_DEFINITION_CREATED,
    WORKFLOW_DEFINITION_DELETED,
    WORKFLOW_DEFINITION_UPDATED,
    EventField,
    find_event,
    registered_events,
)
from ..middleware.auth import AuthenticatedUser, require_auth
from ..models.orchestration import RUN_STATUSES, WorkflowDefinition
from ..orchestration import (
    RunWithLogs,
    create_definition,
    delete_definition,
    get_definition,
    is_known_trigger,
    list_definitions,
    list_observed_triggers,
    list_runs,
    set_definition_enabled,
    update_definition,
)
from ..orchestration_authz import authorize_workflow_scope
from ..permissions import get_permissions_registry
from ..plugins import discover_plugin_manifests
from ..prompt_library import validate_agent_prompts
from ..prompt_parts import PromptPartsError
from ..schemas.orchestration import (
    WORKFLOW_ACTIONS,
    ActionLogEntry,
    CreateWorkflowDefinitionRequest,
    SetEnabledRequest,
    UpdateWorkflowDefinitionRequest,
    WorkflowCatalog,
    WorkflowDefinitionResponse,
    WorkflowRunSummary,
    redact_secrets,
    resolve_write_secrets,
)
from ..scope_resolvers import registered_scope_levels, trigger_reachable_levels
from ..writeback_targets import (
    WriteBackTarget,
    registered_writeback_targets,
    resolve_writeback_target,
)

router = APIRouter(prefix="/orchestration/workflows", tags=["orchestration"])
runs_router = APIRouter(prefix="/orchestration/runs", tags=["orchestration"])

# The first-party runtime whose declared tools drive the agent action's picker.
# Its manifest carries the tool declarations (ADR-0014 §7); Core reads them off
# the manifest — it never imports the runtime's Python (ADR-0002).
_AGENT_RUNTIME_PLUGIN = "agent-runtime"


def _serialize_fields(fields: tuple[EventField, ...] | list[EventField]) -> list[dict[str, Any]]:
    """A trigger's payload fields as JSON dicts for the catalog (#505).

    ``{name, label, type, values}`` per field; ``values`` is the list of choices
    for an enumerable field and empty otherwise. Advisory metadata — it drives
    the builder's condition dropdowns, never ``trigger_filter`` validation.
    """
    return [
        {"name": f.name, "label": f.label, "type": f.type, "values": list(f.values)} for f in fields
    ]


def _trigger_field_names(source: str, detail_type: str) -> list[str]:
    """The declared payload field names for a (source, detail_type) trigger.

    The shared lookup behind both the catalog's per-trigger ``reachable_levels``
    and the create/update scope-reachability check (Phase 4, docs/implementation/
    0003-hierarchy-scoped-workflows), so the two can never disagree.

    Declared business events (events/registry.py) first; else a generic-CRUD
    ``<table>.<op>`` trigger, resolved back to its table via the permissions
    registry. Empty for an observed-but-undeclared trigger — its payload shape
    isn't known, so it is only ever reachable at the broadest scope level.
    """
    event = find_event(source, detail_type)
    if event is not None:
        return [f.name for f in event.payload_fields()]
    if source == "biffo.core":
        for table, block in get_permissions_registry().items():
            for op, verb in (("create", "created"), ("update", "updated"), ("delete", "deleted")):
                if getattr(block, op).allowed and detail_type == f"{table}.{verb}":
                    return [f.name for f in fields_for_crud_table(table)]
    return []


def _agent_runtime_tools() -> list[dict[str, Any]]:
    """The agent runtime's declared tools, read live from its discovered manifest.

    Pure declaration — ``{name, description, parameters}`` per tool — surfaced so
    the workflow builder (a later change) can offer a tool picker whose options
    come from the runtime's own registry, with no cross-service drift. Returns an
    empty list if the runtime is not installed. This is deliberately **not** a
    ``config_field`` on the agent action: the builder renders ``config_fields`` by
    type and does not yet understand a tool picker, so the tools ride as separate
    data the current builder ignores.
    """
    for manifest in discover_plugin_manifests():
        if manifest.get("name") != _AGENT_RUNTIME_PLUGIN:
            continue
        return [
            {
                "name": tool.get("name"),
                "description": tool.get("description"),
                "parameters": tool.get("parameters", {}),
            }
            for tool in manifest.get("tools", [])
        ]
    return []


def _actions_with_available_tools() -> list[dict[str, Any]]:
    """``WORKFLOW_ACTIONS`` with the agent action carrying its ``available_tools``.

    Copies each action shallowly and attaches ``available_tools`` to the ``agent``
    action only, so the module-level ``WORKFLOW_ACTIONS`` (which also drives
    request validation) is never mutated and every action's ``config_fields`` are
    left byte-for-byte unchanged.
    """
    actions: list[dict[str, Any]] = []
    for action in WORKFLOW_ACTIONS:
        if action["type"] == "agent":
            actions.append({**action, "available_tools": _agent_runtime_tools()})
        else:
            actions.append(action)
    return actions


@router.get("/catalog", response_model=WorkflowCatalog)
async def get_catalog(
    caller: AuthenticatedUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
) -> WorkflowCatalog:
    """The triggers and actions the builder offers (drives the UI dropdowns).

    Open to any authenticated caller, not just an admin — Phase 3 (docs/
    implementation/0003-hierarchy-scoped-workflows) lets a scoped, non-admin
    caller build workflows too, and the catalog carries no tenant-specific
    secrets, only what triggers/actions/scope-levels exist to pick from.

    Triggers are every **declared** event (defined in code — a registered
    ``EventType`` or a generic-CRUD ``<table>.<op>`` from the permissions registry,
    ADR-0002/#222), unioned with any event this tenant has been **observed**
    dispatching that isn't declared (a compliance anomaly, ADR-0010). Actions are
    the engine's action registry.
    """
    triggers: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    # Declared business events (events/registry.py).
    for e in registered_events():
        fields = e.payload_fields()
        triggers.append(
            {
                "source": e.source,
                "detail_type": e.detail_type,
                "label": e.label,
                "description": e.description,
                "origin": "declared",
                # Advisory field metadata for the "Only when…" editor (#505); an
                # event that declares none serialises as [] (UI → free text).
                "fields": _serialize_fields(fields),
                # Which registered scope levels this trigger's payload could ever
                # match (Phase 4, #0003-hierarchy-scoped-workflows) — lets the
                # builder warn/filter rather than let an author build a scoped
                # workflow that can never fire (e.g. a brand-scoped rule on a
                # tenant-only trigger like demo.requested).
                "reachable_levels": trigger_reachable_levels(f.name for f in fields),
            }
        )
        seen.add((e.source, e.detail_type))

    # Declared generic-CRUD events: <table>.<op> for every table+operation the
    # CRUD layer exposes (declared implicitly by __crud_permissions__). Every such
    # mutation emits (ADR-0002), so each is a valid trigger even before it fires.
    for table, block in get_permissions_registry().items():
        # A model may decline to be *offered* as a trigger (``__trigger_exclude__``)
        # when a purpose-built event describes the same change better — e.g. a
        # stage move, rather than an `updated` that fires on every edit. The event
        # itself is untouched and still reaches its subscribers; only the picker
        # changes.
        excluded_ops = trigger_excluded_ops(table)
        for op, verb in (
            ("create", "created"),
            ("update", "updated"),
            ("delete", "deleted"),
        ):
            if not getattr(block, op).allowed or op in excluded_ops:
                continue
            key = ("biffo.core", f"{table}.{verb}")
            if key in seen:
                continue
            crud_fields = fields_for_crud_table(table)
            triggers.append(
                {
                    "source": "biffo.core",
                    "detail_type": f"{table}.{verb}",
                    "label": f"{table} {verb}",
                    "description": f"A {table} row was {verb}.",
                    "origin": "declared",
                    # A CRUD event's payload is the mutated row, so its fields are
                    # the table's columns, introspected from the model (#505).
                    # Empty when the table has no locatable model.
                    "fields": _serialize_fields(crud_fields),
                    "reachable_levels": trigger_reachable_levels(f.name for f in crud_fields),
                }
            )
            seen.add(key)

    # Observed-but-undeclared events (should be empty under the compliance gate;
    # surfaced so an anomaly is visible rather than hidden).
    for observed in await list_observed_triggers(db, tenant_id=caller.tenant_id):
        key = (observed.source, observed.detail_type)
        if key in seen:
            continue
        triggers.append(
            {
                "source": observed.source,
                "detail_type": observed.detail_type,
                "label": observed.detail_type,
                "description": "Seen on the event bus.",
                "origin": "observed",
                # An undeclared, observed event has no described payload — the UI
                # falls back to free-text conditions (#505).
                "fields": [],
                # No declared fields -> only the broadest scope level is reachable.
                "reachable_levels": trigger_reachable_levels([]),
            }
        )
        seen.add(key)

    # Only the targets this caller may actually write (ADR-0027): the picker must
    # never offer a table they could not save against, and must not disclose what
    # else this deployment lets other people write.
    writeback_targets = [
        _writeback_target_summary(target)
        for target in registered_writeback_targets()
        if _may_write_target(caller, target)
    ]

    return WorkflowCatalog(
        triggers=triggers,
        actions=_actions_with_available_tools(),
        scope_levels=list(registered_scope_levels()),
        writeback_targets=writeback_targets,
    )


async def _require_scope_access(
    caller: AuthenticatedUser, db: AsyncSession, scope: dict[str, Any] | None
) -> None:
    """403 unless ``caller`` is a platform admin or the registered authorizer
    says they may act on a definition carrying ``scope`` (Phase 3). Checked
    against the *submitted* scope on create/update — not just an existing
    row's stored one — so a scoped caller can never move a definition to a
    scope wider than their own reach (e.g. a brand manager setting `scope:
    null` to make a rule tenant-wide): the registered authorizer is the same
    check either way, and a caller who cannot act on that scope is refused it
    regardless of which direction the change goes.
    """
    if ADMIN_GROUP in caller.roles:
        return
    if await authorize_workflow_scope(caller, db, scope):
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN, detail="Not authorized for this scope"
    )


def _may_write_target(caller: AuthenticatedUser, target: WriteBackTarget) -> bool:
    """Whether ``caller`` personally holds the authority ``target`` requires.

    The third term of ADR-0027 §3, checked at authoring time so a workflow that
    could never write is refused on save rather than hours later on a completion.

    Platform admins and the Cognito ``admin`` group pass, consistent with every
    other gate in this router: a platform admin short-circuits every
    authorization check this deployment defines — and harmlessly, because this
    is only the *authoring* check: the write itself still runs under the
    instance's row policies as the stored author, so an admin gets exactly
    what an admin would get by hand.
    """
    if caller.is_platform_admin or ADMIN_GROUP in caller.roles:
        return True
    return target.permission_code in caller.permissions


def _writeback_target_summary(target: WriteBackTarget) -> dict[str, Any]:
    """The builder's view of a target: what may be written, and how."""
    return {
        "table": target.table,
        "label": target.label,
        "operations": list(target.operations),
        "scope_levels": list(target.scope_levels),
        "row_selector": (
            target.row_selector.payload_field if target.row_selector is not None else None
        ),
        "columns": [
            {
                "name": column.name,
                "label": column.label,
                "type": column.type,
                "required": column.required,
                "values": list(column.values),
                "overwrite": column.overwrite,
            }
            for column in target.columns
        ],
    }


async def _require_writeback_authority(
    caller: AuthenticatedUser,
    db: AsyncSession,
    *,
    action_config: dict[str, Any],
    scope: dict[str, Any] | None,
) -> None:
    """Gate a definition that declares a write-back (ADR-0027 §3, term 3).

    Shape and column-allowlist validation already happened in the schema; what is
    left is the part only a request can answer — whether *this caller* may write
    here, at *this scope*, and whether the definition can carry a principal at all.

    Order matters. The unregistered-table case is a 404 (ADR-0004 §4: an
    ungranted table is indistinguishable from one that does not exist, so a
    workflow cannot be used to probe what else this deployment can write),
    while a caller who simply lacks the permission gets a 403.
    """
    declared = action_config.get("writeback")
    if not declared:
        return

    target = resolve_writeback_target(str(declared.get("table") or ""))
    if target is None:
        raise _not_found()

    if not _may_write_target(caller, target):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                f"You do not have permission to write to {target.label} "
                f"({target.permission_code}), so you cannot build a workflow that does."
            ),
        )

    # A write-back is only ever as good as the principal it will run as. Without
    # one there is nobody to bind the write to, so it could never be authorized
    # — refuse now rather than store a rule that is guaranteed to fail.
    if not caller.user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "This workflow cannot record a result because your identity resolves "
                "to no user, so the write would have no authority to run under."
            ),
        )

    # A target that derives a column from the hierarchy has nothing to derive
    # from on an unscoped rule. Left alone this fails at the policy much later,
    # with no hint of the cause.
    if target.scope_levels and scope is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                f"Writing to {target.label} needs the workflow to be scoped to a "
                f"{' or '.join(target.scope_levels)}, so the record can be filed there."
            ),
        )
    if target.scope_levels and scope is not None and scope.get("level") not in target.scope_levels:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                f"Writing to {target.label} needs a "
                f"{' or '.join(target.scope_levels)}-scoped workflow; this one is scoped "
                f"to {scope.get('level')!r}."
            ),
        )

    # Belt and braces: the caller must also be authorized for the scope itself.
    # `_require_scope_access` has already run on the same scope by the time this
    # is called, so this is a second, cheap assertion rather than the primary
    # gate — kept because the write-back path is the one place where getting
    # scope wrong writes real business data.
    await _require_scope_access(caller, db, scope)


async def _require_row_access(
    caller: AuthenticatedUser, db: AsyncSession, definition: WorkflowDefinition | None
) -> WorkflowDefinition:
    """404 unless ``definition`` exists AND ``caller`` may act on its stored
    scope — a scoped caller sees an out-of-reach row exactly as "not found",
    never a 403 that would confirm it exists.
    """
    if definition is None:
        raise _not_found()
    if ADMIN_GROUP in caller.roles:
        return definition
    if await authorize_workflow_scope(caller, db, definition.scope):
        return definition
    raise _not_found()


def _redacted(definition: WorkflowDefinition) -> WorkflowDefinitionResponse:
    """A response for ``definition`` with secret config values masked (#432).

    The single read funnel. Every path that turns a definition into a response or
    an event payload goes through here, so a secret (a Google Chat webhook token
    today) never leaves the admin boundary in clear — not on an HTTP response, and
    not on the ``WORKFLOW_DEFINITION_*`` events, which carry the whole row onto the
    bus. Routing all reads through one function is the point: the bug class is a
    *new* read path forgetting to redact.
    """
    response = WorkflowDefinitionResponse.model_validate(definition)
    return response.model_copy(
        update={"action_config": redact_secrets(definition.action_type, response.action_config)}
    )


def _definition_payload(definition: WorkflowDefinition) -> dict[str, Any]:
    """Full-row, JSON-safe, secret-redacted payload for a state-change event (#432)."""
    return _redacted(definition).model_dump(mode="json")


def _write_secrets(
    action_type: str, submitted: dict[str, Any], stored: dict[str, Any]
) -> dict[str, Any]:
    """Resolve secret fields for a write, mapping the refusal to 422 (#432)."""
    try:
        return resolve_write_secrets(action_type, submitted, stored)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)
        ) from exc


async def _require_known_trigger(
    db: AsyncSession, *, tenant_id: str, source: str, detail_type: str
) -> None:
    """422 unless the trigger is a declared or already-observed event."""
    if not await is_known_trigger(db, tenant_id=tenant_id, source=source, detail_type=detail_type):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"Unknown trigger: {source}/{detail_type}",
        )


def _require_scope_reachable(
    scope: dict[str, Any] | None, *, source: str, detail_type: str
) -> None:
    """422 if ``scope`` is set but this trigger's payload could never carry an
    id at that level (Phase 4, docs/implementation/0003-hierarchy-scoped-
    workflows).

    Phase 3's ``_require_scope_access`` checks *who* may author at a scope;
    this checks whether the resulting workflow could ever actually fire. A
    Brand-scoped workflow bound to a tenant-only trigger (e.g.
    ``demo.requested``, whose payload carries no ``brand_id``) would create
    successfully but silently never match in ``dispatch_event`` — this catches
    that dead combination at authoring time instead. A no-op when no resolver
    is registered (nothing to reason about reachability against, mirroring
    ``_validate_scope``'s own leniency in that case).
    """
    if scope is None or not registered_scope_levels():
        return
    reachable = trigger_reachable_levels(_trigger_field_names(source, detail_type))
    if scope["level"] not in reachable:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                f"scope.level {scope['level']!r} can never match trigger "
                f"{source}/{detail_type} — its payload only ever reaches: {reachable}"
            ),
        )


async def _require_resolvable_agent_prompts(
    db: AsyncSession, *, tenant_id: str, action_type: str, action_config: dict[str, Any]
) -> None:
    """422 unless an agent action's prompt parts resolve against the library (§6).

    The parts' *shape* was already validated by the body schema; this is the
    DB-backed half: every referenced component exists and its supplied values
    match its declared variables. Non-agent actions carry no prompt parts, so
    this is a no-op for them.
    """
    if action_type != "agent":
        return
    try:
        await validate_agent_prompts(db, tenant_id=tenant_id, action_config=action_config)
    except PromptPartsError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)
        ) from exc


@router.get("", response_model=list[WorkflowDefinitionResponse])
async def list_workflows(
    caller: AuthenticatedUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
) -> list[WorkflowDefinitionResponse]:
    """Every definition an admin sees; a scoped caller sees only the ones
    they're authorized for (Phase 3) — silently filtered, not an error."""
    definitions = await list_definitions(db, tenant_id=caller.tenant_id)
    if ADMIN_GROUP not in caller.roles:
        definitions = [
            d for d in definitions if await authorize_workflow_scope(caller, db, d.scope)
        ]
    return [_redacted(d) for d in definitions]


@router.post("", response_model=WorkflowDefinitionResponse, status_code=status.HTTP_201_CREATED)
async def create_workflow(
    body: CreateWorkflowDefinitionRequest,
    caller: AuthenticatedUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
) -> WorkflowDefinitionResponse:
    await _require_scope_access(caller, db, body.scope)
    await _require_known_trigger(
        db,
        tenant_id=caller.tenant_id,
        source=body.trigger_source,
        detail_type=body.trigger_detail_type,
    )
    _require_scope_reachable(
        body.scope, source=body.trigger_source, detail_type=body.trigger_detail_type
    )
    # No stored config to merge against on a create, so the sentinel has nothing to
    # keep and is refused rather than persisted as a "secret" (#432).
    action_config = _write_secrets(body.action_type, body.action_config, stored={})
    await _require_writeback_authority(caller, db, action_config=action_config, scope=body.scope)
    await _require_resolvable_agent_prompts(
        db, tenant_id=caller.tenant_id, action_type=body.action_type, action_config=action_config
    )
    definition = await create_definition(
        db,
        tenant_id=caller.tenant_id,
        name=body.name,
        trigger_source=body.trigger_source,
        trigger_detail_type=body.trigger_detail_type,
        trigger_filter=body.trigger_filter,
        action_type=body.action_type,
        action_config=action_config,
        enabled=body.enabled,
        schedule_config=body.schedule_config,
        scope=body.scope,
        run_as_user_id=caller.user_id,
    )
    emit_event(
        db,
        WORKFLOW_DEFINITION_CREATED,
        _definition_payload(definition),
        tenant_id=caller.tenant_id,
    )
    return _redacted(definition)


@router.get("/{definition_id}", response_model=WorkflowDefinitionResponse)
async def get_workflow(
    definition_id: str,
    caller: AuthenticatedUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
) -> WorkflowDefinitionResponse:
    definition = await get_definition(db, tenant_id=caller.tenant_id, definition_id=definition_id)
    definition = await _require_row_access(caller, db, definition)
    return _redacted(definition)


@router.put("/{definition_id}", response_model=WorkflowDefinitionResponse)
async def update_workflow(
    definition_id: str,
    body: UpdateWorkflowDefinitionRequest,
    caller: AuthenticatedUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
) -> WorkflowDefinitionResponse:
    await _require_known_trigger(
        db,
        tenant_id=caller.tenant_id,
        source=body.trigger_source,
        detail_type=body.trigger_detail_type,
    )
    _require_scope_reachable(
        body.scope, source=body.trigger_source, detail_type=body.trigger_detail_type
    )
    # Fetch first, to merge secrets against what is stored: a PUT replaces the whole
    # action_config, and the portal round-trips the redacted sentinel, so an
    # unchanged save must keep the real secret rather than write the placeholder
    # over it (#432). Merge keys on the *submitted* action_type — changing the
    # action legitimately drops the old action's secrets.
    existing = await get_definition(db, tenant_id=caller.tenant_id, definition_id=definition_id)
    # Must be authorized for BOTH the row's current scope (can they touch this
    # at all) AND the newly submitted one (can they move it there) — a scoped
    # caller can edit within their reach but never re-scope a definition wider
    # than it (e.g. a brand manager setting `scope: null` to go tenant-wide).
    existing = await _require_row_access(caller, db, existing)
    await _require_scope_access(caller, db, body.scope)
    action_config = _write_secrets(body.action_type, body.action_config, existing.action_config)
    await _require_writeback_authority(caller, db, action_config=action_config, scope=body.scope)
    await _require_resolvable_agent_prompts(
        db, tenant_id=caller.tenant_id, action_type=body.action_type, action_config=action_config
    )
    definition = await update_definition(
        db,
        tenant_id=caller.tenant_id,
        definition_id=definition_id,
        name=body.name,
        trigger_source=body.trigger_source,
        trigger_detail_type=body.trigger_detail_type,
        trigger_filter=body.trigger_filter,
        action_type=body.action_type,
        action_config=action_config,
        enabled=body.enabled,
        schedule_config=body.schedule_config,
        scope=body.scope,
        run_as_user_id=caller.user_id,
    )
    if definition is None:
        raise _not_found()
    emit_event(
        db,
        WORKFLOW_DEFINITION_UPDATED,
        _definition_payload(definition),
        tenant_id=caller.tenant_id,
    )
    return _redacted(definition)


@router.post("/{definition_id}/enabled", response_model=WorkflowDefinitionResponse)
async def set_workflow_enabled(
    definition_id: str,
    body: SetEnabledRequest,
    caller: AuthenticatedUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
) -> WorkflowDefinitionResponse:
    existing = await get_definition(db, tenant_id=caller.tenant_id, definition_id=definition_id)
    await _require_row_access(caller, db, existing)
    definition = await set_definition_enabled(
        db,
        tenant_id=caller.tenant_id,
        definition_id=definition_id,
        enabled=body.enabled,
        run_as_user_id=caller.user_id,
    )
    if definition is None:
        raise _not_found()
    # A toggle is a row update; the payload's ``enabled`` carries the new state.
    emit_event(
        db,
        WORKFLOW_DEFINITION_UPDATED,
        _definition_payload(definition),
        tenant_id=caller.tenant_id,
    )
    return _redacted(definition)


@router.delete("/{definition_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_workflow(
    definition_id: str,
    caller: AuthenticatedUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
) -> None:
    existing = await get_definition(db, tenant_id=caller.tenant_id, definition_id=definition_id)
    await _require_row_access(caller, db, existing)
    deleted = await delete_definition(db, tenant_id=caller.tenant_id, definition_id=definition_id)
    if deleted is None:
        raise _not_found()
    emit_event(
        db,
        WORKFLOW_DEFINITION_DELETED,
        _definition_payload(deleted),
        tenant_id=caller.tenant_id,
    )


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workflow not found")


# ── Run history ──────────────────────────────────────────────────────────────


def _run_summary(item: RunWithLogs) -> WorkflowRunSummary:
    run = item.run
    return WorkflowRunSummary(
        id=run.id,
        tenant_id=run.tenant_id,
        created_at=run.created_at,
        updated_at=run.updated_at,
        definition_id=run.definition_id,
        definition_name=item.definition_name,
        status=run.status,
        trigger_event=run.trigger_event,
        logs=[ActionLogEntry.model_validate(log) for log in item.logs],
    )


@runs_router.get("", response_model=list[WorkflowRunSummary])
async def list_workflow_runs(
    definition_id: str | None = Query(None, description="Only runs of this workflow definition."),
    run_status: str | None = Query(
        None, alias="status", description=f"One of: {', '.join(RUN_STATUSES)}."
    ),
    limit: int = Query(50, ge=1, le=200),
    caller: AuthenticatedUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[WorkflowRunSummary]:
    """Most-recent-first history of what fired, when, and how it turned out.

    Read-only: runs are written by the engine through the internal API, never
    from here. Deliberately still platform-admin-only — Phase 3's scoped
    authorization (docs/implementation/0003-hierarchy-scoped-workflows)
    covers the workflow-definition CRUD only; scoping run *history* to a
    definition's owner is an explicitly deferred follow-up, not an oversight.
    """
    if run_status is not None and run_status not in RUN_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"Unknown status: {run_status}",
        )
    runs = await list_runs(
        db,
        tenant_id=caller.tenant_id,
        definition_id=definition_id,
        status=run_status,
        limit=limit,
    )
    return [_run_summary(item) for item in runs]
