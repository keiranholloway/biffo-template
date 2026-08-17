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
from dataclasses import dataclass
from typing import Any

from aws_lambda_powertools import Logger
from pydantic import ValidationError

from .identity import DefaultIdentityProvider, get_identity_provider
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
    ``{table: {operation: {allowed, required_role, permission_code,
    allowed_principals}}}`` — for logging/auditing."""
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
        else:
            log_unreachable_permission_codes(_REGISTRY_CACHE)
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


# Providers this function can PROVE something about, by allow-list rather than
# by a check for the one known-undecidable case (#1636). Today that is just
# ``DefaultIdentityProvider``, whose ``resolve_permissions`` unconditionally
# returns an empty set. Anything not on this tuple — a deployment's own
# provider today, or a provider type nobody has written yet — falls to "could
# not check" by construction: the default is unknown, not clean, so the set
# growing (or a brand new provider type showing up) can only ever make the
# answer *more* honest, never silently narrow what gets reported.
_DECIDABLE_PROVIDERS: tuple[type, ...] = (DefaultIdentityProvider,)


@dataclass(frozen=True)
class UnreachablePermissionCodesReport:
    """Three states, not two (#1636).

    A build-time, database-free registry can only PROVE a declared
    ``permission_code`` is unreachable for a provider on
    ``_DECIDABLE_PROVIDERS`` (today, just ``DefaultIdentityProvider``). For
    any other provider it genuinely does not know — and a bare
    ``findings == []`` in that case reads identically to "checked, found
    nothing", which is the exact "looks broken, not denied" failure #1606's
    owner decision named as the reason this diagnostic has to exist at all.
    So ``checked`` carries that fact explicitly, and every caller (``whoami``,
    the cold-start log) must read it before trusting ``findings``:

    - ``checked=True, findings=[]``     — checked, clean.
    - ``checked=True, findings=[...]``  — checked, found unreachable codes.
    - ``checked=False, findings=[]``    — could not check; see ``provider``.

    ``provider`` is always populated (the active ``IdentityProvider`` class
    name) so the "could not check" case names *what* could not be checked,
    not just that it couldn't.
    """

    checked: bool
    findings: list[dict[str, str]]
    provider: str


def unreachable_permission_codes(
    registry: PermissionsRegistry,
) -> UnreachablePermissionCodesReport:
    """Every declared ``permission_code`` this instance can prove it will never
    satisfy for anyone (#1606) — or an honest "could not check" (#1636).

    ADR-0004's second axis is already enforced (``dependencies.py``'s
    ``require_crud_permission`` ANDs ``permission_code`` against the caller's
    ``AuthenticatedUser.permissions``), and that already fails closed the way
    #1606 chose: a code nobody holds denies the operation to every caller
    rather than falling open to "any authenticated caller". What enforcement
    alone does not give you is *knowing* that has happened — a table that is
    permanently 403 for everyone looks identical to a table that is merely
    unused, which is the "looks broken, not denied" failure #1606's owner
    decision named as the reason the diagnostic is a requirement.

    A caller's ``permissions`` come from ``IdentityProvider.resolve_permissions``
    (ADR-0012) — an opaque, instance-registered function this module cannot
    enumerate without a database round trip, which the registry build
    deliberately never makes (see the module docstring). There is exactly one
    case this function can prove **without** touching the database:
    ``DefaultIdentityProvider.resolve_permissions`` unconditionally returns an
    empty set (see its docstring), so on a deployment that has not registered
    its own provider, *every* declared ``permission_code`` is guaranteed
    unreachable — not merely possibly so. That is precisely #1606's own worked
    example (a fresh instance like ``biffo-platform``, no custom RBAC
    registered).

    A deployment running its own ``IdentityProvider`` may grant any code from
    anywhere (a database table, a config file) — Core cannot know what it does
    not own, so this reports "could not check" (``checked=False``) rather than
    a clean bill of health it never earned. That instance's own audit of
    "what my provider grants" vs. "what my plugins declare" is outside what a
    build-time, database-free registry can answer; #1607 (the scope seam) is
    adjacent territory and explicitly not this.
    """
    provider = get_identity_provider()
    provider_name = type(provider).__name__

    if not isinstance(provider, _DECIDABLE_PROVIDERS):
        return UnreachablePermissionCodesReport(checked=False, findings=[], provider=provider_name)

    findings: list[dict[str, str]] = []
    for table, perms in sorted(registry.items()):
        for operation in CRUD_OPERATIONS:
            rule: PermissionRule = getattr(perms, operation)
            if rule.permission_code:
                findings.append(
                    {
                        "table": table,
                        "operation": operation,
                        "permission_code": rule.permission_code,
                    }
                )
    return UnreachablePermissionCodesReport(checked=True, findings=findings, provider=provider_name)


def log_unreachable_permission_codes(
    registry: PermissionsRegistry,
) -> UnreachablePermissionCodesReport:
    """Log :func:`unreachable_permission_codes`'s report — findings by name when
    checked, or the fact (and the provider) that it could NOT be checked.

    Called once at deploy-time registry build (``main._run_db_init``, strict
    mode) and once per cold start (``get_permissions_registry``), so either a
    plugin shipping a ``permission_code`` no one has wired anything for, or a
    custom provider the diagnostic cannot see past, shows up in the logs
    unasked — the "one call, not a debugging session" requirement is
    :func:`unreachable_permission_codes` itself (also surfaced through
    ``GET /api/v1/whoami`` for a platform admin); this is the half that means
    nobody has to go looking for it first.

    A ``checked=False`` report gets its own WARNING naming the provider class
    — not silence, and not folded into the "0 findings" case above it, which
    is exactly the #1636 defect (a skipped check reading as a clean one).

    Returns the full report, so a caller that already has the registry (e.g.
    ``_run_db_init``, which logs its own registry summary alongside) can fold
    it into one log record instead of two, and so callers can distinguish
    "checked, clean" from "could not check" the same way ``whoami`` does.
    """
    report = unreachable_permission_codes(registry)

    if not report.checked:
        logger.warning(
            f"unreachable_permission_codes could not be checked: the active "
            f"IdentityProvider ({report.provider}) is not statically "
            "decidable — it may grant any declared permission_code from "
            "wherever it likes (a database table, a config file), so this "
            "instance's own audit of what it grants vs. what its plugins "
            "declare cannot be answered from a build-time, database-free "
            "registry. This is NOT 'checked, clean' — it is 'not checked'.",
            extra={"unreachable_permission_codes_provider": report.provider},
        )
        return report

    for finding in report.findings:
        logger.warning(
            f"permission_code {finding['permission_code']!r} declared on "
            f"{finding['table']}.{finding['operation']} can never be granted on "
            "this instance (DefaultIdentityProvider.resolve_permissions grants "
            "no permission codes) — that operation is unreachable for every "
            "caller, not 'any authenticated caller'. Register an "
            "IdentityProvider that grants this code, or remove it from the "
            "manifest.",
            extra={"unreachable_permission_code": finding},
        )
    return report
