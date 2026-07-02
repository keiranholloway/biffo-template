"""Dynamic FastAPI route registration for plugin-declared routes (ADR-0003
chunk 6 / issue #19).

Builds one ``APIRouter`` covering every installed plugin's declared routes
(``api_routes`` in ``biffo.plugin.json``), mounted under
``/plugins/<plugin-name>/<path>`` — ``main.py`` includes this router with
``prefix="/api/v1"``, giving the full path
``/api/v1/plugins/<plugin-name>/<path>``.

Design: a plugin route is not linked-in code (see
``api.models.plugin_route`` for the fuller rationale, grounded in ADR-0002).
It is a declaration of ``(method, path, table, operation)``, and this module
synthesizes a generic CRUD handler for each one against the plugin's own
SQLAlchemy model (``PluginTableDefinition.to_sqlalchemy_model()``, from
issue #18), scoped to the caller's ``tenant_id`` via
``require_plugin_tenant_context`` — the same tenant-scoping every
hand-written route uses (CLAUDE.md invariant #2). This is the HTTP surface
ADR-0004 identified as a follow-up to its permissions/discovery model; it
does not implement ADR-0004's declarative per-table permissions registry
(that ADR is still Proposed and unimplemented) — every route a plugin
declares here is reachable by any authenticated caller in the plugin's own
tenant, with the manifest's route list itself acting as the allow-list (a
plugin author only exposes the routes they declare).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from typing import Any

from aws_lambda_powertools import Logger
from fastapi import APIRouter, Body, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..dependencies import require_plugin_tenant_context
from ..migrations.plugin_migrations import parse_plugin_tables_from_manifest
from ..models.plugin_route import RouteDefinition, parse_plugin_routes_from_manifest
from ..models.plugin_table import PluginTableDefinition
from ..plugins import discover_plugin_manifests

logger = Logger()

_AUTO_COLUMN_NAMES: frozenset[str] = frozenset(
    {"id", "tenant_id", "created_at", "updated_at"}
)

# SQLAlchemy model classes, keyed by table name.
# PluginTableDefinition.to_sqlalchemy_model() creates a brand-new mapped
# class (and registers its Table with the shared Base.metadata) on every
# call; calling it twice for the same table name raises "Table already
# defined for this MetaData instance". build_plugin_router() can legitimately
# be called more than once in the same process (e.g. once per test, or if a
# future hot-reload path calls it again), so model classes are memoized here
# rather than rebuilt on every call.
_model_cache: dict[str, type[Any]] = {}


def _get_model(table_def: PluginTableDefinition) -> type[Any]:
    model = _model_cache.get(table_def.name)
    if model is None:
        model = table_def.to_sqlalchemy_model()
        _model_cache[table_def.name] = model
    return model


def _serialize(row: Any) -> dict[str, Any]:
    """Convert a mapped row into a plain JSON-able dict of its own columns."""
    return {col.name: getattr(row, col.name) for col in row.__table__.columns}


def _user_columns(table_def: PluginTableDefinition) -> frozenset[str]:
    """Column names a caller may set via the request body — everything
    except the auto-managed id/tenant_id/created_at/updated_at columns.
    tenant_id in particular must never be settable from the request body: it
    always comes from require_plugin_tenant_context, never the caller
    (ADR-0001)."""
    return frozenset(
        c.name for c in table_def.columns if c.name not in _AUTO_COLUMN_NAMES
    )


def _make_list_handler(model: type[Any]) -> Callable[..., Awaitable[Any]]:
    async def handler(
        tenant_id: str = Depends(require_plugin_tenant_context),
        db: AsyncSession = Depends(get_db),
    ) -> list[dict[str, Any]]:
        result = await db.execute(select(model).where(model.tenant_id == tenant_id))
        return [_serialize(row) for row in result.scalars().all()]

    return handler


def _make_read_handler(model: type[Any]) -> Callable[..., Awaitable[Any]]:
    async def handler(
        id: str,
        tenant_id: str = Depends(require_plugin_tenant_context),
        db: AsyncSession = Depends(get_db),
    ) -> dict[str, Any]:
        result = await db.execute(
            select(model).where(model.id == id, model.tenant_id == tenant_id)
        )
        row = result.scalar_one_or_none()
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Not found"
            )
        return _serialize(row)

    return handler


def _make_create_handler(
    model: type[Any], user_columns: frozenset[str]
) -> Callable[..., Awaitable[Any]]:
    async def handler(
        payload: dict[str, Any] = Body(default_factory=dict),
        tenant_id: str = Depends(require_plugin_tenant_context),
        db: AsyncSession = Depends(get_db),
    ) -> dict[str, Any]:
        fields = {k: v for k, v in payload.items() if k in user_columns}
        row = model(tenant_id=tenant_id, **fields)
        db.add(row)
        try:
            await db.flush()
        except IntegrityError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Could not create {model.__tablename__} row: {exc.orig}",
            ) from exc
        await db.refresh(row)
        return _serialize(row)

    return handler


def _make_update_handler(
    model: type[Any], user_columns: frozenset[str]
) -> Callable[..., Awaitable[Any]]:
    async def handler(
        id: str,
        payload: dict[str, Any] = Body(default_factory=dict),
        tenant_id: str = Depends(require_plugin_tenant_context),
        db: AsyncSession = Depends(get_db),
    ) -> dict[str, Any]:
        result = await db.execute(
            select(model).where(model.id == id, model.tenant_id == tenant_id)
        )
        row = result.scalar_one_or_none()
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Not found"
            )
        for key, value in payload.items():
            if key in user_columns:
                setattr(row, key, value)
        try:
            await db.flush()
        except IntegrityError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Could not update {model.__tablename__} row: {exc.orig}",
            ) from exc
        await db.refresh(row)
        return _serialize(row)

    return handler


def _make_delete_handler(model: type[Any]) -> Callable[..., Awaitable[Any]]:
    async def handler(
        id: str,
        tenant_id: str = Depends(require_plugin_tenant_context),
        db: AsyncSession = Depends(get_db),
    ) -> dict[str, Any]:
        result = await db.execute(
            select(model).where(model.id == id, model.tenant_id == tenant_id)
        )
        row = result.scalar_one_or_none()
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Not found"
            )
        await db.delete(row)
        await db.flush()
        return {"deleted": True, "id": id}

    return handler


_HANDLER_FACTORIES: dict[
    str, Callable[[type[Any], frozenset[str]], Callable[..., Awaitable[Any]]]
] = {
    "list": lambda model, _cols: _make_list_handler(model),
    "read": lambda model, _cols: _make_read_handler(model),
    "create": _make_create_handler,
    "update": _make_update_handler,
    "delete": lambda model, _cols: _make_delete_handler(model),
}

_SUCCESS_STATUS: dict[str, int] = {
    "list": status.HTTP_200_OK,
    "read": status.HTTP_200_OK,
    "create": status.HTTP_201_CREATED,
    "update": status.HTTP_200_OK,
    "delete": status.HTTP_200_OK,
}


def build_plugin_router(
    manifests: Sequence[dict[str, Any]] | None = None,
) -> APIRouter:
    """Build one APIRouter covering every installed plugin's declared routes.

    Args:
        manifests: Manifest dicts to build routes from. Defaults to
            ``discover_plugin_manifests()`` (every installed plugin found on
            disk). Tests pass an explicit list so they don't depend on real
            ``services/*/biffo.plugin.json`` files existing.

    Returns:
        An APIRouter with no prefix of its own — the caller (main.py)
        mounts it at "/api/v1", so a route declared with path "/widgets" in
        plugin "gizmos" ends up at "/api/v1/plugins/gizmos/widgets".

    A plugin whose manifest fails route/table parsing (an invalid
    RouteDefinition, or a route referencing a table the manifest doesn't
    declare) has its routes skipped entirely, with a warning logged — this
    matches discover_plugin_manifests' policy that one broken plugin must
    not prevent every other plugin (or the Core API itself) from starting.
    """
    router = APIRouter()
    discovered = discover_plugin_manifests() if manifests is None else manifests

    for manifest in discovered:
        name = manifest.get("name")
        if not name:
            logger.warning(
                "Skipping plugin manifest with no 'name'; cannot mount routes."
            )
            continue

        try:
            tables = {t.name: t for t in parse_plugin_tables_from_manifest(manifest)}
            routes: list[RouteDefinition] = parse_plugin_routes_from_manifest(manifest)
        except (ValueError, TypeError) as exc:
            logger.warning(
                f"Skipping routes for plugin {name!r}: invalid manifest: {exc}"
            )
            continue

        if not routes:
            continue

        plugin_router = APIRouter(prefix=f"/plugins/{name}", tags=[f"plugin:{name}"])
        for route in routes:
            table_def = tables[route.table]
            model = _get_model(table_def)
            user_columns = _user_columns(table_def)
            handler = _HANDLER_FACTORIES[route.operation](model, user_columns)
            plugin_router.add_api_route(
                route.path,
                handler,
                methods=[route.method],
                status_code=_SUCCESS_STATUS[route.operation],
                summary=route.description or f"{route.operation} {route.table}",
            )
        router.include_router(plugin_router)

    return router
