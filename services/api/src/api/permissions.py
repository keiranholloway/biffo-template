"""ADR-0004 permissions registry — the sole source of truth for which
``(table, operation)`` combinations the generic CRUD layer exposes and under
what role.

Discovery is declarative, not runtime introspection (ADR-0004 §2). The registry
is built from two static, build-time declarations:

- **plugin tables** — each installed plugin's ``biffo.plugin.json`` ``tables[]``
  ``permissions`` block (parsed via ``PluginTableDefinition``), and
- **core tables** — ``TenantScopedModel`` subclasses that opt in with a
  non-empty ``__crud_permissions__`` ClassVar (``User`` deliberately does not).

It never queries ``information_schema`` or iterates ``Base.metadata`` to decide
what to expose — doing so would silently expose every new table the moment its
migration lands, with nowhere to hang a permission rule.

**Where the "baked artifact" lives.** ADR-0004 §2 frames the registry as a
build-time artifact loaded once at cold start "the same way
``BIFFO_COGNITO_JWKS_JSON`` is baked in." A Lambda's filesystem is read-only
(except an ephemeral ``/tmp`` that isn't shared across execution environments),
so rather than pre-serialising a JSON file into the zip, the registry is
derived **deterministically at cold start from the manifests that are already
baked into the package** (``/var/task/services/*/biffo.plugin.json`` — see
``api.plugins``) plus the imported core models, then memoised for the
container's lifetime. That reads only static declarations, never the database,
which is the property the ADR actually requires.

**Fail-closed.** ``get_permissions_registry`` catches any build error and
returns an empty registry, so a malformed declaration denies everything (404)
rather than falling back to any default-allow behaviour. ``_run_db_init`` builds
it in ``strict=True`` mode at deploy time so a malformed core
``__crud_permissions__`` or a plugin/core table-name collision fails the deploy
loudly instead of silently disappearing from the registry at runtime.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Any

from aws_lambda_powertools import Logger
from pydantic import ValidationError

from .migrations.plugin_migrations import parse_plugin_tables_from_manifest
from .models.plugin_table import CRUD_OPERATIONS, PermissionRule, TablePermissions
from .plugins import discover_plugin_manifests

logger = Logger()

# table name -> the table's per-operation permission block.
PermissionsRegistry = dict[str, TablePermissions]


def _iter_core_crud_models() -> list[type[Any]]:
    """Every mapped model that opts into the generic CRUD layer via a non-empty
    ``__crud_permissions__``.

    Walks the subclass tree so a model defined anywhere that's been imported is
    found. Dynamically-generated plugin models (``to_sqlalchemy_model``) are
    also mapped models, but they inherit the empty default
    ``__crud_permissions__`` (their permissions come from the manifest path),
    so filtering on a *non-empty* block excludes them here — a plugin table is
    never counted twice.

    ## Why this walks ``Base`` and not ``TenantScopedModel`` (#890)

    It used to start at ``TenantScopedModel.__subclasses__()``, so **any
    declarative base an instance defines was invisible to the permissions
    registry** — and therefore to generic CRUD. The tables simply did not
    appear, with no error and no failing test.

    That is not a hypothetical shape. ADR-0022 makes ``domains/`` user-owned so
    an instance owns model code, and ADR-0005 effectively forces a second base:
    a DDL-imported schema has its own column conventions — native ``UUID``
    primary keys, soft-delete, a real tenant foreign key — that
    ``TenantScopedModel``'s ``String(36)`` id and ``"default"`` tenant seam
    cannot express. An instance following both ADRs lands exactly here.

    Walking from ``Base`` is a **strict superset that is behaviourally
    identical today**: ``TenantScopedModel`` is itself a ``Base`` subclass so
    nothing is lost, the ``perms and tablename`` filter is unchanged, and
    ``TenantScopedModel`` itself is abstract with no ``__tablename__`` so it
    filters out rather than being mistaken for a table.
    """
    from .models.base import Base

    seen: set[type[Any]] = set()
    out: list[type[Any]] = []
    stack: list[type[Any]] = list(Base.__subclasses__())
    while stack:
        cls = stack.pop()
        if cls in seen:
            continue
        seen.add(cls)
        stack.extend(cls.__subclasses__())
        perms = getattr(cls, "__crud_permissions__", {}) or {}
        tablename = getattr(cls, "__tablename__", None)
        if perms and tablename:
            out.append(cls)
    return out


def iter_core_crud_models() -> list[type[Any]]:
    """Public accessor for the core models that opt into the generic CRUD layer
    (via a non-empty ``__crud_permissions__``)."""
    return _iter_core_crud_models()


def _add(
    registry: PermissionsRegistry,
    table: str,
    perms: TablePermissions,
    *,
    source: str,
    strict: bool,
) -> None:
    if table in registry:
        msg = (
            f"Duplicate CRUD permissions for table {table!r} (from {source}); "
            "keeping the first declaration and ignoring this one."
        )
        if strict:
            raise ValueError(msg)
        logger.warning(msg)
        return
    registry[table] = perms


def build_permissions_registry(
    manifests: Sequence[dict[str, Any]] | None = None,
    *,
    core_models: Iterable[type[Any]] | None = None,
    strict: bool = False,
) -> PermissionsRegistry:
    """Build the permissions registry from plugin manifests and core models.

    Args:
        manifests: Plugin manifest dicts. Defaults to
            ``discover_plugin_manifests()`` (every installed plugin on disk).
        core_models: Core models declaring ``__crud_permissions__``. Defaults to
            ``_iter_core_crud_models()``. Tests pass explicit stand-ins to avoid
            registering real tables on ``Base.metadata``.
        strict: When true, a malformed declaration or a duplicate table name
            raises instead of being logged-and-skipped. Used at db-init so a bad
            declaration fails the deploy rather than silently denying at runtime.

    Returns:
        A mapping of table name to its ``TablePermissions`` block.
    """
    manifests = discover_plugin_manifests() if manifests is None else manifests
    core = _iter_core_crud_models() if core_models is None else list(core_models)

    registry: PermissionsRegistry = {}

    for manifest in manifests:
        name = manifest.get("name")
        try:
            tables = parse_plugin_tables_from_manifest(manifest)
        except (ValueError, TypeError) as exc:
            if strict:
                raise
            logger.warning(
                f"Skipping CRUD permissions for plugin {name!r}: invalid manifest: {exc}"
            )
            continue
        for table in tables:
            _add(
                registry,
                table.name,
                table.permissions,
                source=f"plugin:{name}",
                strict=strict,
            )

    for model in core:
        raw = getattr(model, "__crud_permissions__", {}) or {}
        try:
            perms = TablePermissions.model_validate(raw)
        except ValidationError as exc:
            if strict:
                raise
            logger.warning(
                f"Ignoring invalid __crud_permissions__ on core model "
                f"{getattr(model, '__name__', model)!r}: {exc}"
            )
            continue
        _add(
            registry,
            model.__tablename__,
            perms,
            source=f"core:{getattr(model, '__name__', model)}",
            strict=strict,
        )

    return registry


def serialize_registry(registry: PermissionsRegistry) -> dict[str, Any]:
    """Render the registry as a plain JSON-able dict:
    ``{table: {operation: {allowed, required_role, allowed_principals}}}`` — for
    logging/auditing."""
    return {name: perms.model_dump(mode="json") for name, perms in registry.items()}


_REGISTRY_CACHE: PermissionsRegistry | None = None


def get_permissions_registry(*, force_rebuild: bool = False) -> PermissionsRegistry:
    """Return the process-wide registry, built once and memoised for the
    container's lifetime (cold-start cost model, ADR-0004 §2).

    Fails closed: if the registry can't be built, logs and returns an empty
    registry so every ``(table, operation)`` resolves to "not exposed" (404)
    rather than any default-allow behaviour.
    """
    global _REGISTRY_CACHE
    if _REGISTRY_CACHE is None or force_rebuild:
        try:
            _REGISTRY_CACHE = build_permissions_registry()
        except Exception:  # noqa: BLE001 — fail closed on *any* build error
            logger.exception(
                "Failed to build permissions registry; failing closed (all generic CRUD denied)."
            )
            _REGISTRY_CACHE = {}
    return _REGISTRY_CACHE


def lookup_permission(
    table: str,
    operation: str,
    registry: PermissionsRegistry | None = None,
) -> PermissionRule | None:
    """Resolve the permission rule for ``(table, operation)``.

    Returns ``None`` when the table isn't in the registry at all (not exposed)
    or ``operation`` isn't a known CRUD operation — the caller (enforcement,
    A4) treats ``None`` as 404. When the table is present, returns its rule for
    that operation; the caller then checks ``rule.allowed`` (404 if false) and
    ``rule.required_role`` against the caller's roles.
    """
    registry = get_permissions_registry() if registry is None else registry
    block = registry.get(table)
    if block is None or operation not in CRUD_OPERATIONS:
        return None
    return getattr(block, operation)
