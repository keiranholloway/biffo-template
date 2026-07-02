"""RBAC reference plugin (ADR-0003 chunk 14 / issue #27).

See services/rbac/README.md for scope, what's genuinely wired end to end,
and what's blocked on chunks that don't exist yet (#22-26).
"""

from .permissions import PermissionChecker
from .plugin import DEFAULT_ROLE_NAME, RbacPlugin

__all__ = ["DEFAULT_ROLE_NAME", "PermissionChecker", "RbacPlugin"]
