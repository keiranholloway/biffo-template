from fastapi import Depends, HTTPException, status

from .events.base import EventPublisher
from .middleware.auth import AuthenticatedUser, require_auth

_event_publisher: EventPublisher | None = None


def get_event_publisher() -> EventPublisher:
    global _event_publisher
    if _event_publisher is None:
        _event_publisher = EventPublisher()
    return _event_publisher


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
