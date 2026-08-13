"""Biffo Plugin SDK."""

from .client import BiffoAPIClient, BiffoAPIError
from .events import BiffoEvent, EventSubscriber, create_event_handler
from .plugin import (
    BiffoPluginBase,
    ColumnDefinition,
    IndexDefinition,
    PermissionRule,
    PluginManifest,
    RouteDef,
    SeedDeclaration,
    TableDefinition,
    TablePermissions,
    ToolDeclaration,
    load_manifest,
    register_plugin,
)

# Re-exported for the shared plugin host (ADR-0021 §1a) to bind the acting-as-plugin
# identity, and for callers/tests to reference the header name. Not in __all__ (a
# ContextVar/str has no package __module__, so the public-surface guard excludes
# them) — the `as` alias marks these as deliberate re-exports for the linter.
from .signed_client import FORWARDED_USER_HEADER as FORWARDED_USER_HEADER
from .signed_client import PLUGIN_IDENTITY_HEADER as PLUGIN_IDENTITY_HEADER
from .signed_client import PrincipalCoreClient, SignedCoreClient, create_core_client
from .signed_client import acting_as_plugin as acting_as_plugin
from .user_serving import (
    CognitoConfig,
    ForbiddenError,
    ForwardedUser,
    UnauthorizedError,
    UserAuthError,
    authorize,
    require_group,
)

__all__ = [
    "BiffoAPIClient",
    "BiffoAPIError",
    "BiffoEvent",
    "BiffoPluginBase",
    "CognitoConfig",
    "ColumnDefinition",
    "EventSubscriber",
    "ForbiddenError",
    "ForwardedUser",
    "IndexDefinition",
    "PermissionRule",
    "PluginManifest",
    "PrincipalCoreClient",
    "RouteDef",
    "SeedDeclaration",
    "SignedCoreClient",
    "TableDefinition",
    "TablePermissions",
    "ToolDeclaration",
    "UnauthorizedError",
    "UserAuthError",
    "authorize",
    "create_core_client",
    "create_event_handler",
    "load_manifest",
    "register_plugin",
    "require_group",
]
