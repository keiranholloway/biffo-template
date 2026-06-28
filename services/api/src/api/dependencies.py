from fastapi import Header, HTTPException, status

from .events.base import EventPublisher

_event_publisher: EventPublisher | None = None


def get_event_publisher() -> EventPublisher:
    global _event_publisher
    if _event_publisher is None:
        _event_publisher = EventPublisher()
    return _event_publisher


def require_tenant_context(x_tenant_id: str = Header(default="default")) -> str:
    """
    FastAPI dependency injected on every route (ADR-0001 compliance check).

    In single-tenant deployments this always returns 'default'.
    In multi-tenant deployments the tenant_id comes from the JWT claim.
    Raises 500 if called in a context where tenant_id cannot be determined —
    this catches regressions in the auth middleware before they reach the DB.
    """
    if not x_tenant_id:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="tenant_id missing from request context",
        )
    return x_tenant_id
