"""Generic CRUD routes for opt-in core tables (ADR-0004).

A core ``TenantScopedModel`` subclass opts into the generic CRUD layer by
declaring a non-empty ``__crud_permissions__`` (see models/base.py). This
router mounts list/read/create/update/delete for each such table under a
conventional ``/data/<table>`` path — main.py includes it at ``/api/v1``, so a
table ``audit_log`` is served at ``/api/v1/data/audit_log`` (collection) and
``/api/v1/data/audit_log/{id}`` (single row).

Unlike a plugin (which declares an explicit ``api_routes`` list), a core table
has no route declaration — so the permissions block itself decides which routes
exist: only operations with ``allowed: true`` are mounted. Each mounted route
still carries the ADR-0004 ``require_crud_permission`` guard, which additionally
enforces ``required_role`` (403) and keeps the not-allowed case a 404. Handlers
and tenant scoping are shared with the plugin router via ``crud_handlers``.

``User`` deliberately does not opt in — ``/users`` and ``/auth/me`` stay
hand-written because they carry auth-linkage semantics a generic layer
shouldn't touch (ADR-0004 §1).
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from aws_lambda_powertools import Logger
from fastapi import APIRouter, Depends

from ..dependencies import require_crud_permission
from ..permissions import (
    PermissionsRegistry,
    _iter_core_crud_models,
    build_permissions_registry,
)
from .crud_handlers import HANDLER_FACTORIES, SUCCESS_STATUS, user_columns_from_model

logger = Logger()

# operation -> (HTTP method, whether it addresses a single row via /{id}).
_OPERATION_ROUTE: dict[str, tuple[str, bool]] = {
    "list": ("GET", False),
    "create": ("POST", False),
    "read": ("GET", True),
    "update": ("PUT", True),
    "delete": ("DELETE", True),
}


def build_core_crud_router(
    models: Iterable[type[Any]] | None = None,
    *,
    permissions_registry: PermissionsRegistry | None = None,
) -> APIRouter:
    """Build one APIRouter exposing generic CRUD for opt-in core tables.

    Args:
        models: Core models declaring ``__crud_permissions__``. Defaults to
            ``_iter_core_crud_models()`` (discovered from the imported model
            classes). Tests pass explicit models.
        permissions_registry: Registry the guards resolve against. Defaults to
            one built from the same ``models``, so routes and permission checks
            never diverge.

    Returns:
        An APIRouter with no prefix of its own — mounted at "/api/v1" by main.py.
        Empty when no core table opts in (the base deployment ships none).
    """
    resolved = list(_iter_core_crud_models() if models is None else models)
    registry = (
        permissions_registry
        if permissions_registry is not None
        else build_permissions_registry([], core_models=resolved)
    )

    router = APIRouter()
    for model in resolved:
        table = model.__tablename__
        block = registry.get(table)
        if block is None:
            continue
        user_columns = user_columns_from_model(model)
        table_router = APIRouter(prefix=f"/data/{table}", tags=[f"data:{table}"])
        for operation, (method, is_row) in _OPERATION_ROUTE.items():
            if not getattr(block, operation).allowed:
                continue
            handler = HANDLER_FACTORIES[operation](model, user_columns)
            table_router.add_api_route(
                "/{id}" if is_row else "",
                handler,
                methods=[method],
                status_code=SUCCESS_STATUS[operation],
                summary=f"{operation} {table}",
                dependencies=[Depends(require_crud_permission(table, operation, registry))],
            )
        router.include_router(table_router)

    return router
