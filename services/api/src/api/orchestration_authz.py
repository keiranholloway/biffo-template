"""Optional scoped-authorization seam for the user-facing orchestration
workflow CRUD (routers/orchestration.py) — docs/implementation/0003-hierarchy
-scoped-workflows Phase 3.

Every deployment authorizes workflow CRUD by Cognito ``admin`` group
membership alone (``require_admin``) — all-or-nothing. An instance that has
adopted hierarchy scoping (Phase 1/2) may also want a *narrower* grant: a
caller who isn't a platform admin but genuinely owns a workflow's target scope
(e.g. a brand manager, via that instance's own role-assignment model) should
be able to manage workflows scoped to their own reach, without becoming a
full admin.

Registered the same way as the scope resolver (``scope_resolvers.py``) and the
event registry (``events/registry.py``): the template ships a fail-closed
default (nothing but a platform admin may act — today's behaviour, unchanged),
an instance registers its own authorizer at domain-module import time. The
template has no concept of "role assignments" or "brand" — only the
instance's own authorization model knows how to answer "can THIS caller act
on THIS scope."
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from .middleware.auth import AuthenticatedUser

# ``(caller, db, scope) -> may this caller create/read/update/delete/enable a
# workflow definition carrying this scope?`` ``scope`` is ``None`` for an
# unscoped/tenant-wide definition. Async because answering this may need a
# database lookup (e.g. the caller's role assignments) — safe here because
# this runs inside Core (ADR-0002), never in a plugin.
WorkflowScopeAuthorizer = Callable[
    [AuthenticatedUser, AsyncSession, dict[str, Any] | None], Awaitable[bool]
]


async def _default_authorizer(
    caller: AuthenticatedUser, db: AsyncSession, scope: dict[str, Any] | None
) -> bool:
    """No instance authorizer registered: fail closed. The router only
    consults this for a caller who already failed the platform-admin check
    (``require_admin``'s prior behaviour), so the default keeps that exact
    all-or-nothing gate — nothing is authorized by scope alone until an
    instance registers a real authorizer.
    """
    del caller, db, scope
    return False


_authorizer: WorkflowScopeAuthorizer = _default_authorizer


def register_workflow_scope_authorizer(authorizer: WorkflowScopeAuthorizer) -> None:
    """Declare the instance's scoped-authorization check.

    Idempotent like ``register_scope_resolver``: a later call replaces the
    earlier one — there is exactly one active authorizer (an instance has
    exactly one authorization model), not a registry keyed by anything.
    """
    global _authorizer
    _authorizer = authorizer


async def authorize_workflow_scope(
    caller: AuthenticatedUser, db: AsyncSession, scope: dict[str, Any] | None
) -> bool:
    """True if ``caller`` may act on a workflow definition carrying ``scope``."""
    return await _authorizer(caller, db, scope)
