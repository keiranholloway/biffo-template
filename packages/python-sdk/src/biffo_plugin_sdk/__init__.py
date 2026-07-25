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
    TableDefinition,
    TablePermissions,
    ToolDeclaration,
    load_manifest,
    register_plugin,
)
from .signed_client import (
    PLUGIN_IDENTITY_HEADER,
    SignedCoreClient,
    acting_as_plugin,
    create_core_client,
)
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
    "RouteDef",
    "SignedCoreClient",
    "acting_as_plugin",
    "PLUGIN_IDENTITY_HEADER",
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
