from collections.abc import Awaitable, Callable

from fastapi import Depends, HTTPException, status

from .cognito import CognitoAdmin
from .events.base import EventPublisher
from .middleware.auth import AuthenticatedUser, require_auth
from .middleware.service_auth import ServicePrincipal, require_service_principal
from .permissions import PermissionsRegistry, lookup_permission

# The Cognito group that gates the admin user-management surface. Kept in one
# place so it stays in step with the `admin` group provisioned in Terraform
# (modules/cloud/aws/auth).
ADMIN_GROUP = "admin"

_event_publisher: EventPublisher | None = None
_cognito_admin: CognitoAdmin | None = None


def get_event_publisher() -> EventPublisher:
    global _event_publisher
    if _event_publisher is None:
        _event_publisher = EventPublisher()
    return _event_publisher


def get_cognito_admin() -> CognitoAdmin:
    global _cognito_admin
    if _cognito_admin is None:
        _cognito_admin = CognitoAdmin()
    return _cognito_admin


def require_admin(
    caller: AuthenticatedUser = Depends(require_auth),
) -> AuthenticatedUser:
    """FastAPI dependency that requires the caller to be in the `admin` Cognito
    group. Returns the caller so handlers can record who performed the action.

    Roles come from the verified `cognito:groups` claim (ADR-0004); membership is
    Cognito's, so a suspended/removed admin loses this the moment their token is
    revoked or expires.
    """
    if ADMIN_GROUP not in caller.roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrator access required",
        )
    return caller


def require_tenant_context(caller: AuthenticatedUser = Depends(require_auth)) -> str:
    """
    FastAPI dependency that returns the tenant_id from the verified JWT (ADR-0001).

    Raises 500 if tenant_id cannot be determined — catches regressions in auth
    middleware before they reach the database layer.
    """
    if not caller.tenant_id:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="tenant_id missing from auth context",
        )
    return caller.tenant_id


def require_plugin_tenant_context(
    caller: AuthenticatedUser = Depends(require_auth),
) -> str:
    """
    FastAPI dependency used by every dynamically-registered plugin route
    (ADR-0003 chunk 6 / issue #19).

    Currently identical to require_tenant_context — every plugin route is
    tenant-scoped exactly like a native route (CLAUDE.md invariant #2).
    Deliberately kept as its own dependency, rather than plugin routes
    depending on require_tenant_context directly, so a future authorization
    layer (ADR-0004's declarative per-table `permissions`/`required_role`)
    has a single seam to extend without touching every generated plugin
    route handler in api.routing.plugin_router.
    """
    return require_tenant_context(caller)


def require_crud_permission(
    table: str,
    operation: str,
    registry: PermissionsRegistry,
) -> Callable[..., Awaitable[None]]:
    """Build the ADR-0004 authorization guard for one generic-CRUD route.

    Attached as a route-level dependency by the plugin and core-table routers,
    it runs before the handler and enforces the declarative permission model:

    - ``(table, operation)`` not in the registry, or ``allowed: false`` -> 404.
      A table/operation that isn't exposed must be indistinguishable from one
      that doesn't exist (ADR-0004 §4), so this deliberately mirrors the
      handler's own "row not found" 404 rather than returning 403.
    - ``required_role`` non-empty and disjoint from the caller's roles -> 403.
      The operation is exposed; the caller simply lacks the role. An empty
      ``required_role`` authorises any authenticated caller.

    Tenant scoping is applied separately and unconditionally by the handler
    (require_plugin_tenant_context), independent of this guard — it is never a
    table-configurable permission.

    ``registry`` is passed in (not read from the global cache) so a router's
    routes and their permission checks are always built from the same manifest
    set, which keeps tests hermetic.
    """

    async def guard(caller: AuthenticatedUser = Depends(require_auth)) -> None:
        rule = lookup_permission(table, operation, registry=registry)
        if rule is None or not rule.allowed:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
        if rule.required_role and not set(rule.required_role).intersection(caller.roles):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You do not have permission to perform this action",
            )

    return guard


def require_service_crud_permission(
    table: str,
    operation: str,
    registry: PermissionsRegistry,
) -> Callable[..., Awaitable[None]]:
    """Build the ADR-0014 §7 agent read-scope-ceiling guard for one route.

    The service-principal sibling of :func:`require_crud_permission`. It shares
    the same ``lookup_permission`` source of truth and the same default-deny /
    indistinguishability posture, but authorises on a **structurally separate**
    axis: a caller's derived logical name (``ServicePrincipal.logical_names``)
    intersecting the rule's ``allowed_principals``, never a Cognito-role check.

    The whole point of §7 is two separate evaluation paths, so this is a new
    guard rather than a branch inside ``require_crud_permission``. It depends on
    ``require_service_principal`` — **not** ``require_auth`` — which means a
    Cognito-user request (no SigV4 IAM principal on the API Gateway event) is
    rejected with 401 *before* this guard body runs. A Cognito user can
    therefore never satisfy this guard, whatever groups they hold: the
    separation is enforced by the dependency graph, not by a runtime check here.

    Behaviour:

    - ``(table, operation)`` not in the registry, or ``allowed: false`` -> 404,
      identical to the Cognito guard so an unexposed operation is
      indistinguishable from a nonexistent one (ADR-0004 §4).
    - The principal's logical names disjoint from ``rule.allowed_principals``
      -> **404, not 403**. A service principal has no role to "lack", and
      indistinguishability still applies — an ungranted table must look
      nonexistent. An empty ``allowed_principals`` (the thin default) therefore
      denies every principal.

    Tenant scoping is applied separately and unconditionally by the handler,
    independent of this guard (ADR-0001). ``registry`` is passed in for the same
    hermeticity reason as ``require_crud_permission``.

    NOTE: This guard is a tested primitive and is deliberately **not mounted on
    any route** — no agent read route exists yet (ADR-0014 §7 piece 3). The
    mechanics must be right and reviewed before a consumer attaches to them.
    """

    async def guard(
        principal: ServicePrincipal = Depends(require_service_principal),
    ) -> None:
        rule = lookup_permission(table, operation, registry=registry)
        if rule is None or not rule.allowed:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
        if not principal.logical_names.intersection(rule.allowed_principals):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")

    return guard
