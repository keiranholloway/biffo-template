"""Biffo Plugin SDK."""

from .client import BiffoAPIClient, BiffoAPIError
from .config import (
    ConfigState,
    PluginConfigError,
    PluginConfigTransientError,
    SecretResolution,
    get_plugin_config,
    plugin_config_env_names,
    resolve_secret,
    resolve_setting,
)
from .events import BiffoEvent, EventSubscriber, create_event_handler
from .fixtures import (
    FixtureNotRecordedError,
    FixtureRecorder,
    ManifestSchema,
    SchemaViolation,
)
from .plugin import (
    AdminIngress,
    BiffoPluginBase,
    ColumnDefinition,
    ConfigDeclaration,
    EventSubscription,
    IndexDefinition,
    LegacyRequiredGroupWarning,
    PermissionRule,
    PluginManifest,
    RouteDef,
    SeedDeclaration,
    TableDefinition,
    TablePermissions,
    ToolDeclaration,
    UIComponent,
    UserFrontend,
    UserIngress,
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
from .usage import get_runs_usage, get_thread_usage
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
    "AdminIngress",
    "BiffoAPIClient",
    "BiffoAPIError",
    "BiffoEvent",
    "BiffoPluginBase",
    "CognitoConfig",
    "ColumnDefinition",
    "ConfigDeclaration",
    "ConfigState",
    "EventSubscriber",
    "EventSubscription",
    "FixtureNotRecordedError",
    "FixtureRecorder",
    "ForbiddenError",
    "ForwardedUser",
    "IndexDefinition",
    "LegacyRequiredGroupWarning",
    "ManifestSchema",
    "PermissionRule",
    "PluginConfigError",
    "PluginConfigTransientError",
    "PluginManifest",
    "PrincipalCoreClient",
    "RouteDef",
    "SchemaViolation",
    "SecretResolution",
    "SeedDeclaration",
    "SignedCoreClient",
    "TableDefinition",
    "TablePermissions",
    "ToolDeclaration",
    "UIComponent",
    "UnauthorizedError",
    "UserAuthError",
    "UserFrontend",
    "UserIngress",
    "authorize",
    "create_core_client",
    "create_event_handler",
    "get_plugin_config",
    "get_runs_usage",
    "get_thread_usage",
    "load_manifest",
    "plugin_config_env_names",
    "register_plugin",
    "require_group",
    "resolve_secret",
    "resolve_setting",
]
