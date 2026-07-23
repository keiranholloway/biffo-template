"""Owner-scoped data routes for plugin tables that opt in (ADR-0017 §5).

For every installed plugin table declaring ``owner_scoped_service``, mounts a small
CRUD surface under ``/api/v1/internal/owner-data/<table>`` that the owning module's
Lambda uses to manage its own rows — dual-authenticated and owner-scoped
(``owner_data_handlers``). A table that does not opt in gets no routes here, so this
never widens the tenant-facing generic CRUD layer (which stays closed for these
tables per their ``permissions``).

Built from the same discovered manifests as the plugin router, and reusing its
model cache so a table's dynamically-built SQLAlchemy model is created exactly once
(a second ``to_sqlalchemy_model`` for the same table would clash on Base.metadata).
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from aws_lambda_powertools import Logger
from fastapi import APIRouter, status

from ..migrations.plugin_migrations import parse_plugin_tables_from_manifest
from ..plugins import discover_plugin_manifests
from .crud_handlers import user_columns_from_model
from .owner_data_handlers import (
    make_owner_create_handler,
    make_owner_list_handler,
    make_owner_read_handler,
    make_owner_update_handler,
)
from .plugin_router import _get_model

logger = Logger()


def build_owner_data_router(manifests: Sequence[dict[str, Any]] | None = None) -> APIRouter:
    """Build one APIRouter covering every opted-in table's owner-scoped data routes.

    Args:
        manifests: Manifest dicts to build from. Defaults to
            ``discover_plugin_manifests()``; tests pass an explicit list.

    Returns an APIRouter with no prefix of its own — ``main.py`` mounts it at
    ``/api/v1``. A plugin whose manifest fails table parsing is skipped with a
    warning, matching the plugin router's policy.
    """
    router = APIRouter()
    discovered = discover_plugin_manifests() if manifests is None else manifests

    for manifest in discovered:
        name = manifest.get("name")
        if not name:
            logger.warning("Skipping plugin manifest with no 'name'; cannot mount owner-data.")
            continue
        try:
            tables = parse_plugin_tables_from_manifest(manifest)
        except (ValueError, TypeError) as exc:
            logger.warning(f"Skipping owner-data for plugin {name!r}: invalid manifest: {exc}")
            continue

        for table_def in tables:
            access = table_def.owner_scoped_service
            if access is None:
                continue
            model = _get_model(table_def)
            user_columns = user_columns_from_model(model)
            allowed = frozenset(access.allowed_principals)
            owner_column = access.owner_column

            table_router = APIRouter(
                prefix=f"/internal/owner-data/{table_def.name}",
                tags=[f"internal:owner-data:{table_def.name}"],
            )
            table_router.add_api_route(
                "",
                make_owner_create_handler(model, owner_column, user_columns, allowed),
                methods=["POST"],
                status_code=status.HTTP_201_CREATED,
                summary=f"create {table_def.name} (owner-scoped)",
            )
            table_router.add_api_route(
                "",
                make_owner_list_handler(model, owner_column, user_columns, allowed),
                methods=["GET"],
                summary=f"list {table_def.name} (owner-scoped)",
            )
            table_router.add_api_route(
                "/{id}",
                make_owner_read_handler(model, owner_column, allowed),
                methods=["GET"],
                summary=f"read {table_def.name} (owner-scoped)",
            )
            table_router.add_api_route(
                "/{id}",
                make_owner_update_handler(model, owner_column, user_columns, allowed),
                methods=["PATCH"],
                summary=f"update {table_def.name} (owner-scoped)",
            )
            router.include_router(table_router)

    return router
