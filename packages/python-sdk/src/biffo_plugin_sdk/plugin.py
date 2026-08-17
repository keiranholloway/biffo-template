"""Plugin manifest schema validation and registration helpers.

The shapes in this file (``ColumnDefinition``, ``IndexDefinition``,
``PermissionRule``, ``TablePermissions``, ``TableDefinition``) are kept in
field-for-field sync with ``services/api/src/api/models/plugin_table.py``'s
``ColumnDefinition``/``IndexDefinition``/``PermissionRule``/
``TablePermissions``/``PluginTableDefinition`` in the biffo-template monorepo.
This package can't import that module directly — it's installed by plugin
authors' separate repositories, outside the Core API's own deployment — so
the duplication is unavoidable. If either side changes, update the other.
This SDK deliberately stops at structural validation: it does not resolve
column types into real SQLAlchemy columns (that stays Core-API-only, per
ADR-0002 — no DB client machinery outside services/api/).

``BiffoPluginBase`` (the SDK's main entry point, per ADR-0003 section 3)
lives in this module rather than a separate file: it wraps ``PluginManifest``
and ``register_plugin`` directly, so keeping them together avoids a circular
import between "the manifest" and "the class that registers a manifest".
"""

from __future__ import annotations

import json
import re
from abc import ABC, abstractmethod
from collections import Counter
from collections.abc import Callable
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .client import BiffoAPIClient
from .events import EventHandler, EventSubscriber
from .signed_client import create_core_client


class ColumnDefinition(BaseModel):
    """Defines a single column on a plugin-created table."""

    name: str = Field(description="Column name.")
    type: str = Field(description="SQLAlchemy column type string, e.g. 'String(255)' or 'Integer'.")
    primary_key: bool = Field(default=False, description="Whether this is the primary key.")
    nullable: bool = Field(default=False, description="Whether NULL values are allowed.")
    index: bool = Field(default=False, description="Create a database index on this column.")
    default: str | None = Field(default=None, description="SQL default value expression.")
    description: str = Field(default="", description="Human-readable column description.")


class IndexDefinition(BaseModel):
    """Defines a database index on a plugin-created table."""

    name: str = Field(description="Index name in the database.")
    columns: list[str] = Field(min_length=1, description="Column names included in the index.")
    unique: bool = Field(default=False, description="Whether the index enforces uniqueness.")


# The five generic CRUD operations the permission model authorises, in a
# canonical order. Mirrored as the keys of TablePermissions below, and the
# equivalents in the Core API's plugin_table.py/plugin_route.py and the CLI.
CRUD_OPERATIONS: tuple[str, ...] = ("list", "read", "create", "update", "delete")


class PermissionRule(BaseModel):
    """Authorization rule for a single CRUD operation on a table (ADR-0004).

    Default-deny: an operation is invisible to the generic CRUD layer unless
    ``allowed`` is explicitly true. ``required_role`` is an any-of allow-list
    matched against the caller's ``cognito:groups`` roles; an empty list means
    any authenticated caller may perform the operation once it is allowed.
    Tenant scoping (ADR-0001) is applied unconditionally by the generic layer
    regardless of this rule and is deliberately not configurable here.

    ``extra="forbid"`` so a typo'd key (e.g. ``role`` for ``required_role``)
    fails loudly rather than being silently ignored on a security surface.
    """

    model_config = ConfigDict(extra="forbid")

    allowed: bool = Field(
        default=False,
        description="Whether the generic CRUD layer exposes this operation at all.",
    )
    required_role: list[str] = Field(
        default_factory=list,
        description="Any-of role allow-list; empty means any authenticated caller.",
    )


class TablePermissions(BaseModel):
    """Per-operation permission block for a table (ADR-0004).

    Every operation defaults to fully denied, so a table with no permissions
    block — or one that omits an operation — is invisible to the generic CRUD
    layer for that operation. This is a default-deny allow-list, not a
    default-expose deny-list.

    ``extra="forbid"`` so an unknown operation key (e.g. ``delet``) is a hard
    error rather than a silently-ignored, permanently-denied operation.
    """

    model_config = ConfigDict(extra="forbid")

    list: PermissionRule = Field(default_factory=PermissionRule)
    read: PermissionRule = Field(default_factory=PermissionRule)
    create: PermissionRule = Field(default_factory=PermissionRule)
    update: PermissionRule = Field(default_factory=PermissionRule)
    delete: PermissionRule = Field(default_factory=PermissionRule)


# Mirrors _AUTO_COLUMNS in plugin_table.py, which is itself kept in sync with
# TenantScopedModel in base.py. If either changes, update all three.
_AUTO_COLUMNS: list[ColumnDefinition] = [
    ColumnDefinition(name="id", type="String(36)", primary_key=True),
    ColumnDefinition(name="tenant_id", type="String(64)", nullable=False, index=True),
    ColumnDefinition(name="created_at", type="DateTime(timezone=True)", nullable=False),
    ColumnDefinition(name="updated_at", type="DateTime(timezone=True)", nullable=False),
]

_AUTO_COLUMN_NAMES: frozenset[str] = frozenset(c.name for c in _AUTO_COLUMNS)


class TableDefinition(BaseModel):
    """Defines a complete table schema for a plugin.

    Automatically adds id, tenant_id, created_at, updated_at columns
    following the TenantScopedModel pattern (ADR-0001) — the same behavior
    as the Core API's PluginTableDefinition, so a manifest that validates
    here is guaranteed to validate there too.
    """

    name: str = Field(description="Table name in the database.")
    columns: list[ColumnDefinition] = Field(default_factory=list)
    indexes: list[IndexDefinition] = Field(default_factory=list)
    permissions: TablePermissions = Field(
        default_factory=TablePermissions,
        description="Declarative per-operation generic-CRUD permissions "
        "(ADR-0004). Absent means fully denied — the table is invisible to the "
        "generic CRUD layer until an operation is explicitly allowed.",
    )

    @model_validator(mode="before")
    @classmethod
    def _ensure_auto_columns(cls, data: Any) -> Any:
        """A manifest may not redeclare a reserved auto-column name, since
        doing so could silently weaken the tenant-isolation guarantee
        (ADR-0001), e.g. by declaring tenant_id as nullable.
        """
        if isinstance(data, dict):
            existing_cols = list(data.get("columns", []))
            for col in existing_cols:
                name = col["name"] if isinstance(col, dict) else col.name
                if name in _AUTO_COLUMN_NAMES:
                    raise ValueError(
                        f"Column '{name}' is reserved and added automatically; "
                        "it must not be declared in the manifest."
                    )
            data["columns"] = existing_cols + list(_AUTO_COLUMNS)
        return data

    @model_validator(mode="after")
    def _validate_uniqueness(self) -> TableDefinition:
        """Validate no duplicate column or index names, and that every
        index only references columns that actually exist on the table.
        """
        col_counts = Counter(c.name for c in self.columns)
        dupes = [n for n, c in col_counts.items() if c > 1]
        if dupes:
            raise ValueError(f"Duplicate column names: {dupes}")

        idx_counts = Counter(i.name for i in self.indexes)
        idx_dupes = [n for n, c in idx_counts.items() if c > 1]
        if idx_dupes:
            raise ValueError(f"Duplicate index names: {idx_dupes}")

        valid_cols = set(col_counts.keys())
        for idx in self.indexes:
            for col in idx.columns:
                if col not in valid_cols:
                    raise ValueError(
                        f"Index '{idx.name}' references unknown column '{col}'. "
                        f"Valid columns: {valid_cols}"
                    )
        return self


# Operation -> the HTTP method(s) it's allowed to use. Deliberately reuses
# ADR-0004's list/read/create/update/delete vocabulary for its permissions
# registry, so a future permissions block on a route/table can be expressed
# in the same terms without a renaming migration.
_OPERATION_METHODS: dict[str, frozenset[str]] = {
    "list": frozenset({"GET"}),
    "read": frozenset({"GET"}),
    "create": frozenset({"POST"}),
    "update": frozenset({"PUT", "PATCH"}),
    "delete": frozenset({"DELETE"}),
}

# Operations that address a single row need an {id} path parameter; the
# collection-level operations (list, create) must not have one.
_SINGLE_ROW_OPERATIONS: frozenset[str] = frozenset({"read", "update", "delete"})


class RouteDef(BaseModel):
    """Definition of an API route for plugin manifests.

    Mirrors ``services/api/src/api/models/plugin_route.py``'s
    ``RouteDefinition`` in the biffo-template monorepo (same duplication
    rationale as ``ColumnDefinition``/``TableDefinition`` above).

    Per ADR-0002, a plugin cannot ship executable route-handler code that the
    Core API imports and runs inside its own process — plugins talk to the
    Core API over HTTP, they are not linked into it. So a route's "handler"
    is not code: it is a declaration of which of the plugin's own tables
    (declared in this same manifest's ``tables``) the route exposes, and
    which generic CRUD ``operation`` the Core API should synthesize for it,
    scoped to the caller's tenant_id (ADR-0001). This is why this model has
    ``table``/``operation`` fields instead of a free-form ``handler: str``
    naming a Python function.
    """

    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE"]
    path: str = Field(
        description="Path relative to the plugin's mount point "
        "(/api/v1/plugins/<name>), e.g. '/widgets' or '/widgets/{id}'. "
        "Must start with '/'."
    )
    table: str = Field(description="Name of a table declared in this manifest's `tables`.")
    operation: Literal["list", "read", "create", "update", "delete"] = Field(
        description="Generic CRUD operation the Core API synthesizes for "
        "this route against `table`."
    )
    description: str = ""

    @model_validator(mode="after")
    def _validate_method_and_path(self) -> RouteDef:
        if not self.path.startswith("/"):
            raise ValueError(f"path must start with '/': {self.path!r}")

        allowed_methods = _OPERATION_METHODS[self.operation]
        if self.method not in allowed_methods:
            raise ValueError(
                f"operation '{self.operation}' requires method in "
                f"{sorted(allowed_methods)}, got {self.method!r}"
            )

        has_id = "{id}" in self.path
        needs_id = self.operation in _SINGLE_ROW_OPERATIONS
        if needs_id and not has_id:
            raise ValueError(
                f"operation '{self.operation}' addresses a single row and "
                f"requires an '{{id}}' path parameter: {self.path!r}"
            )
        if not needs_id and has_id:
            raise ValueError(
                f"operation '{self.operation}' is collection-level and must "
                f"not have an '{{id}}' path parameter: {self.path!r}"
            )
        return self


class ToolDeclaration(BaseModel):
    """A tool a plugin's runtime exposes to an agentic worker (ADR-0014 §7).

    Pure *declaration* — ``name``, ``description`` and the JSON-Schema
    ``parameters`` — mirroring what the runtime's in-code tool registry holds,
    minus the executor and availability predicate (those stay in the plugin's
    Python and are never on the wire). The registry remains the ceiling: a
    declared tool a build does not register fails the run (see the runtime's
    ``tools.py``).

    **Not yet implemented (#569): "Core reads these to populate the workflow
    builder's tool picker" is aspirational for a third-party plugin's manifest.**
    Today Core reads exactly one manifest this way — the first-party
    ``agent-runtime`` plugin's, matched by name
    (``services/api/src/api/routers/orchestration.py``'s
    ``_agent_runtime_tools()``) — which happens to declare its tools with this
    same shape, but no *generic* mechanism reads an arbitrary plugin's ``tools``
    field for this or any other purpose. Building that generic read is a
    separate, more general piece of work than #569 wired up (which only added
    authoring-time validation for the agent-runtime-specific tool list already
    reaching Core through ``action_config``). Until it exists, declaring
    ``tools`` here validates and round-trips through ``PluginManifest`` but has
    no effect on Core's behaviour for a third-party plugin.
    """

    name: str = Field(description="Registered tool name, matching the runtime's registry key.")
    description: str = Field(description="Human-readable summary shown in the tool picker.")
    parameters: dict[str, Any] = Field(
        default_factory=dict,
        description="JSON Schema for the tool's arguments, as sent to the model provider.",
    )


class ChatAgentDeclaration(BaseModel):
    """A buffered chat agent this plugin registers with Core (ADR-0017 seam #1).

    Core resolves a chat turn's trusted config from the agent ``key`` a request
    carries, never from prompt text in the request (ADR-0016 §1) — so the
    ``system_prompt`` here is the INSTALL-VETTED instruction channel. The bounds
    default to Core's own assistant values; a plugin declares only the essentials.
    """

    model_config = ConfigDict(extra="forbid")

    key: str = Field(pattern=r"^[a-z][a-z0-9-]*$")
    agent_name: str | None = None
    system_prompt: str = Field(min_length=1)
    model: str = Field(min_length=1)
    required_group: str = Field(min_length=1)
    max_history_messages: int = Field(default=40, gt=0)
    max_output_tokens: int = Field(default=1024, gt=0)
    timeout_seconds: float = Field(default=20.0, gt=0)


class SeedDeclaration(BaseModel):
    """A plugin's tenant-scoped baseline-row seed (ADR-0005 DDL import,
    biffo-template#1554).

    ``dir`` names a plugin-relative directory of ``.sql`` files —
    ``biffo plugin install``/``upgrade`` vendor every ``*.sql`` file directly
    under it (non-recursive, matching ``biffo data import``'s own convention)
    into the instance's ``db/imports/_plugin-<name>/``, where the instance's
    already-existing "Apply DDL imports" deploy step applies it idempotently
    on every deploy via ``ddl_import_history`` checksum tracking — no token,
    no per-tenant API call, no new deploy machinery.

    **The idempotency contract, written down** (the issue's own point: this
    was a gap nobody had stated): every file here MUST be safe to re-run —
    ``INSERT ... SELECT ... WHERE NOT EXISTS`` against a stable natural key,
    never a bare ``INSERT``. Files are checksum-locked once applied
    (ADR-0005 section 4): a file that changes after it has been applied halts
    the whole DDL-import batch on the next deploy rather than silently
    re-applying or silently skipping. A later plugin version that needs to
    change its baseline data ships a new, additively-numbered file — it must
    NOT edit one already released. `biffo plugin install`/`upgrade` vendor a
    full replacement of the target directory's contents from whatever the
    plugin ships (mirroring how they already replace ``services/<name>/``
    and ``modules/plugins/<name>/``), so this contract is enforced by
    ADR-0005's existing checksum mechanism, not by new CLI machinery.

    ``baseline_tables`` names which of this manifest's own ``tables`` the
    seed guarantees populated for every tenant this deployment already knows
    about. Checked post-deploy by the Core API's ``biffo:plugin-baseline-check``
    Lambda event (invoked from the deploy workflow, after DDL imports are
    applied) — an empty table here is a loud, specific deploy failure instead
    of a silently-empty feature. Optional: a plugin may vendor seed DDL with
    nothing to assert (e.g. pure reference data it doesn't consider load-bearing).
    """

    model_config = ConfigDict(extra="forbid")

    dir: str = Field(
        description="Plugin-relative directory of baseline-seed .sql files, "
        "e.g. 'db/seed'. No leading slash or traversal."
    )
    baseline_tables: list[str] = Field(
        default_factory=list,
        description="Names of this manifest's own `tables` that `dir`'s seed "
        "guarantees are populated for every known tenant.",
    )


# An ASGI app reference "<module>:<attr>" (ADR-0021) — the shared plugin host mounts
# it. Textually identical to services/api/src/api/models/plugin_user_surface.py's
# `_APP_REF` / `_REL_DIR` / `_require_group` — see UserIngress's docstring below for
# why this SDK carries its own copy rather than importing that module.
_APP_REF = re.compile(r"^[a-zA-Z_][\w]*(\.[a-zA-Z_][\w]*)*:[a-zA-Z_][\w]*$")
_REL_DIR = re.compile(r"^[\w][\w./-]*$")


def _require_group(value: str) -> str:
    if not value.strip():
        raise ValueError("required_group must be a non-empty Cognito group name.")
    return value


class UserIngress(BaseModel):
    """The plugin's authenticated, group-gated API ingress (ADR-0021).

    ``app`` names the ASGI app the **shared plugin host** mounts at
    ``/api/v1/plugins/<name>/*``; the host provides the Lambda entry and enforces
    ``required_group`` (ADR-0011), so a plugin ships no Lambda handler and no
    infrastructure.

    Field-for-field identical to ``services/api/src/api/models/plugin_user_surface
    .py``'s ``UserIngress`` — same duplication rationale as ``TableDefinition``/
    ``RouteDef`` above: this SDK is installed by plugin authors' separate
    repositories, outside the Core API's own deployment, so it can't import that
    module directly. Unlike those two, this shape previously had **no** copy here
    at all — ``PluginManifest`` didn't know ``user_ingress``/``admin_ingress``
    existed (biffo-template#1517) — so the shared plugin host, the one reader that
    actually acts on these fields, was parsing them by hand with no validation.
    If either copy changes, update the other.
    """

    model_config = ConfigDict(extra="forbid")

    required_group: str = Field(
        description="The Cognito group a caller must be in. The shared plugin host "
        "enforces it before dispatching to the plugin (ADR-0011/0021)."
    )
    app: str = Field(
        description="ASGI app reference '<module>:<attr>' (e.g. 'ideation.app:app') "
        "the shared plugin host mounts (ADR-0021)."
    )

    @field_validator("required_group")
    @classmethod
    def _validate_required_group(cls, value: str) -> str:
        return _require_group(value)

    @field_validator("app")
    @classmethod
    def _validate_app(cls, value: str) -> str:
        if not _APP_REF.match(value):
            raise ValueError(
                f"user_ingress.app {value!r} must be an ASGI app reference "
                "'<module>:<attr>', e.g. 'ideation.app:app'."
            )
        return value


class AdminIngress(BaseModel):
    """The plugin's admin-gated API and optional static UI bundle.

    ``app`` names the ASGI app the **shared plugin host** mounts at
    ``/api/v1/plugins/<name>/admin/*``; the host provides the Lambda entry and
    enforces ``required_group`` (ADR-0011). Mirrors ``plugin_user_surface.py``'s
    ``AdminIngress`` — see ``UserIngress`` above for the duplication rationale.
    """

    model_config = ConfigDict(extra="forbid")

    required_group: str = Field(
        description="The Cognito group a caller must be in. The shared plugin host "
        "enforces it before dispatching to the plugin (ADR-0011)."
    )
    app: str = Field(
        description="ASGI app reference '<module>:<attr>' (e.g. 'ideation.admin:app') "
        "the shared plugin host mounts at /api/v1/plugins/<name>/admin/*."
    )

    @field_validator("required_group")
    @classmethod
    def _validate_required_group(cls, value: str) -> str:
        return _require_group(value)

    @field_validator("app")
    @classmethod
    def _validate_app(cls, value: str) -> str:
        if not _APP_REF.match(value):
            raise ValueError(
                f"admin_ingress.app {value!r} must be an ASGI app reference "
                "'<module>:<attr>', e.g. 'ideation.admin:app'."
            )
        return value


class UserFrontend(BaseModel):
    """The plugin's path-routed static frontend under shared-Cognito SSO (ADR-0018
    §2). Mirrors ``plugin_user_surface.py``'s ``UserFrontend`` — see
    ``UserIngress`` above for the duplication rationale.
    """

    model_config = ConfigDict(extra="forbid")

    dir: str = Field(
        description="Repo-relative directory of the built static export "
        "(e.g. 'web/dist'), deployed to a new S3 origin behind <plugin>/* on the "
        "shared CloudFront."
    )
    required_group: str = Field(
        description="The Cognito group gated client-side (the real enforcement is the "
        "ingress and Core, never the client)."
    )

    @field_validator("dir")
    @classmethod
    def _validate_dir(cls, value: str) -> str:
        if value.startswith("/") or ".." in value.split("/") or not _REL_DIR.match(value):
            raise ValueError(
                f"user_frontend.dir {value!r} must be a repo-relative path with no "
                "leading '/' and no '..' traversal."
            )
        return value

    @field_validator("required_group")
    @classmethod
    def _validate_required_group(cls, value: str) -> str:
        return _require_group(value)


class EventSubscription(BaseModel):
    """An EventBridge event the plugin reacts to (ADR-0003).

    Kept deliberately loose — ``extra="allow"``, matching
    ``cli/src/lib/plugin-manifest.ts``'s ``event_subscriptions`` handling: the
    authoritative shape is the plugin registry's, and both this model and the CLI
    only need ``detail_type`` (and, by default, ``source``) to let the host/CLI
    recognise and count subscriptions. A human-readable ``description``, or the
    legacy ``handler`` key some manifests still carry, is accepted rather than
    rejected — unlike ``UserIngress``/``AdminIngress`` above, this is not a
    security surface, so there is nothing a silently-ignored typo here could
    weaken.
    """

    model_config = ConfigDict(extra="allow")

    source: str = "biffo.core"
    detail_type: str


class UIComponent(BaseModel):
    """A portal UI element the plugin adds (ADR-0003), e.g. an admin nav link.

    Mirrors ``_skeletons/plugin-template/registry-schema.json``'s
    ``ui_components`` item shape (``additionalProperties: false`` there too).
    """

    model_config = ConfigDict(extra="forbid")

    type: Literal["nav-link", "page", "dashboard-widget", "modal", "dialog"]
    label: str
    path: str
    icon: str | None = None
    requires_auth: bool = True


class PluginManifest(BaseModel):
    """Validated manifest for a Biffo plugin.

    Required fields: ``name``, ``version``.
    Optional fields carry sensible defaults so plugins can be minimal.

    ``extra="forbid"`` (biffo-template#1517): before this, an unknown top-level
    key — a typo like ``admin_ingres``, or a field this SDK version predates —
    validated with no error and was silently dropped. That is the estate's
    dominant fail-open shape one layer up from the security surfaces above: a
    consumer that has upgraded past the SDK's 1.4 version gate now fails the
    install/CI gate loudly instead of mounting the plugin with that surface
    quietly absent, on a manifest that would previously have validated by
    accident. See ``pyproject.toml``'s version comment for why this is the
    gate rather than an unconditional behaviour change.
    """

    model_config = ConfigDict(extra="forbid")

    name: str
    version: str
    description: str = ""
    author: str = "Biffo Team"
    tags: list[str] = []
    tables: list[TableDefinition] = []
    api_routes: list[RouteDef] = []
    required_core_version: str = ">=0.0.0"
    tools: list[ToolDeclaration] = []
    chat_agents: list[ChatAgentDeclaration] = []
    seed: SeedDeclaration | None = None
    # A plugin declaring `chat_agents_dynamic: true` registers its chat agents
    # itself, at runtime, instead of statically via `chat_agents` above (see
    # services/api/src/api/routing/chat_agent_registration.py, ADR-0017 seam #1
    # extension). The two are alternatives, not required to agree — a dynamic
    # plugin's static `chat_agents` list is typically empty.
    chat_agents_dynamic: bool = False
    event_subscriptions: list[EventSubscription] = []
    ui_components: list[UIComponent] = []
    # Python package dependencies (including biffo-plugin-sdk's own pin) —
    # documentation for a human/tool reading the manifest, e.g.
    # `_skeletons/plugin-template/registry-schema.json`'s equivalent field.
    # Not read by the host or the CLI's install flow; Python dependencies are
    # resolved from the plugin repo's own pyproject.toml, not from this
    # manifest.
    dependencies: dict[str, str] = {}
    # Capability version requirements the plugin declares it needs from Core
    # (e.g. `"owner-scoped-tables": "^1"`). Declared by every live plugin as of
    # biffo-template#1517 and validated here so a typo'd capability name still
    # round-trips — but, like `tools` above, parsing is NOT the same as reading:
    # no code anywhere in the estate (CLI, host, or Core) currently checks a
    # plugin's `core_capabilities` against what Core actually offers. Making
    # this field `extra="forbid"`-reachable without declaring it would have
    # broken all three live plugins' manifests the moment this model went
    # strict; accepting-and-documenting it here is the deliberate choice over
    # rejecting it, since rejecting would require editing every plugin
    # repository in the same change. Wiring an actual reader is separate,
    # unstarted work.
    core_capabilities: dict[str, str] = {}
    # ADR-0021/0018 user-facing and admin-facing surfaces. All three optional: a
    # plugin without them is an ordinary (data/event/CRUD) plugin the shared host
    # never mounts.
    user_ingress: UserIngress | None = None
    admin_ingress: AdminIngress | None = None
    user_frontend: UserFrontend | None = None

    @model_validator(mode="after")
    def _validate_routes_reference_declared_tables(self) -> PluginManifest:
        """A route can only expose a table this same manifest declares — it
        can't reference another plugin's table, and can't be declared
        without the table it serves."""
        table_names = {t.name for t in self.tables}
        for route in self.api_routes:
            if route.table not in table_names:
                raise ValueError(
                    f"Route {route.method} {route.path} references table "
                    f"{route.table!r}, which is not declared in this "
                    f"manifest's 'tables' ({sorted(table_names)})."
                )

        if self.seed:
            for table in self.seed.baseline_tables:
                if table not in table_names:
                    raise ValueError(
                        f"seed.baseline_tables references table {table!r}, "
                        f"which is not declared in this manifest's 'tables' "
                        f"({sorted(table_names)})."
                    )
        return self

    def model_dump_serializable(self) -> dict[str, Any]:
        """Return a JSON-serialisable dict (no Pydantic internals)."""
        return self.model_dump(mode="json")


def load_manifest(path: str | Path) -> PluginManifest:
    """Load and validate a plugin manifest from a JSON file.

    Raises:
        FileNotFoundError: If *path* does not exist.
        ValueError: If the file contains invalid JSON or fails schema validation.
    """
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"Manifest not found: {p}")

    try:
        raw = p.read_text(encoding="utf-8")
    except OSError as exc:
        raise ValueError(f"Cannot read manifest: {exc}") from exc

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON in manifest {p}: {exc}") from exc

    try:
        return PluginManifest(**data)
    except Exception as exc:
        raise ValueError(f"Schema validation failed for {p}: {exc}") from exc


def register_plugin(manifest: PluginManifest) -> dict[str, Any]:
    """Return a serialisable registration dict for the given manifest.

    This is what the CLI sends to the registry during ``biffo plugin install``.
    """
    return {
        "name": manifest.name,
        "version": manifest.version,
        "description": manifest.description,
        "author": manifest.author,
        "tags": manifest.tags,
        "required_core_version": manifest.required_core_version,
        "tables": [t.model_dump(mode="json") for t in manifest.tables],
        "api_routes": [r.model_dump(mode="json") for r in manifest.api_routes],
        "seed": manifest.seed.model_dump(mode="json") if manifest.seed else None,
    }


class BiffoPluginBase(ABC):
    """Abstract base class plugin authors extend to implement a Biffo plugin.

    This is the main entry point described in ADR-0003 section 3 — it ties
    together the rest of the SDK rather than duplicating it:

    - ``self.manifest`` holds the ``PluginManifest`` passed to the
      constructor; ``register()`` delegates to the module-level
      ``register_plugin()`` function using it.
    - ``self.api`` is a ready-to-use ``BiffoAPIClient``, constructed eagerly
      in ``__init__``. Building an ``httpx.AsyncClient`` doesn't require a
      running event loop (it only opens connections lazily on the first
      request), so there's no benefit to deferring construction — and eager
      construction means a misconfigured environment (missing
      ``BIFFO_CORE_API_URL``) surfaces at plugin startup instead of on the
      first API call.
    - ``self.events`` is an ``EventSubscriber`` private to this instance
      (not a module-level singleton), so multiple plugin instances — e.g.
      in tests — never share event registrations. ``subscribe()`` is a thin
      decorator wrapping ``self.events.register()``.

    **The lifecycle hooks are not invoked.** ``on_install()``,
    ``on_uninstall()`` and ``on_upgrade()`` are declared here and implemented
    by every plugin, and nothing anywhere calls them: ADR-0003 section 9
    described a ``biffo plugin install`` that would, and that call site was
    never built — ``cli/src`` does not reference the names at all. Putting
    seeding or teardown in one produces work that silently never happens, and
    the symptom surfaces far from the cause: the plugin deploys clean, its
    tables are empty, and whatever validates against those rows rejects
    everything (biffo-template#709). They stay declared, as no-ops, only so
    existing plugins keep type-checking. Do not build on them.

    What actually runs, if you need baseline data:

    - **Self-seeding at startup.** A plugin that contributes an ASGI app to
      the shared plugin host (``api_ingress`` in the manifest, ADR-0021) has
      its ASGI *lifespan* driven by the host — but only because the host
      performs the handshake itself: Starlette's ``Mount`` never delivers the
      lifespan scope, so a mounted plugin's own ``@app.on_event("startup")``
      was equally dead until biffo-template#948. Startup runs once per
      process, i.e. on every cold start, so the work must be idempotent.
      Core's ``POST /api/v1/internal/plugins/me/config/seed`` is the endpoint
      built for that path; it was itself not idempotent until
      biffo-template#1000, so treat this route as young and verify your own
      seed rather than assuming it is a finished story.
      ``POST /api/v1/internal/plugins/me/workflows/seed`` is the analogous
      route for a plugin's own ``WorkflowDefinition`` rows
      (biffo-template#1593) — unlike the config route above, it **upserts**:
      every cold start's declared values overwrite whatever is currently
      stored, so a definition's snapshot (e.g. an agent action's model or
      timeout) can never outlive the build that last declared it. Call it
      with the same ``self.api.post(...)`` shape, keyed per definition by a
      ``definition_key`` you choose and keep stable across deploys.
    - **Out-of-band seeding, now a declared interface (biffo-template#1554).**
      This is what the first-party plugins use, and it needs no credentials
      and no running plugin — it is also the only option for an event-only
      plugin (one with no ASGI app, such as the skeleton's ``example_plugin``),
      which has no startup to hang anything on. Declare ``seed`` on this
      manifest (:class:`SeedDeclaration`): ``dir`` names a plugin-relative
      directory of idempotent ``.sql`` files, and ``baseline_tables`` names
      which of this manifest's own ``tables`` they populate. ``biffo plugin
      install``/``upgrade`` vendor ``dir`` into the instance's
      ``db/imports/_plugin-<name>/``, where the instance's already-existing
      DDL-import deploy step (ADR-0005) applies it — the same mechanism a
      hand-written module in ``db/imports/<name>/`` always used, just
      declared in the manifest instead of a step nobody was told to perform.
      A table named in ``baseline_tables`` with no rows for a tenant this
      deployment already knows about fails the deploy loudly instead of
      shipping a feature that silently does nothing.
    - **Teardown: nothing.** ADR-0003 section 9 is explicit that
      ``biffo plugin uninstall`` leaves the plugin's tables in place and
      generates no drop migration. There is no teardown hook to miss.
    """

    def __init__(self, manifest: PluginManifest, api: BiffoAPIClient | None = None) -> None:
        self.manifest = manifest
        self.api = api if api is not None else create_core_client()
        self.events = EventSubscriber()

    @abstractmethod
    def on_install(self) -> None:
        """**Not invoked.** Nothing calls this — implement it as a no-op.

        ``biffo plugin install`` does not run it (ADR-0003 section 9 describes
        an install flow that would, which was never built), so seeding placed
        here silently never happens. See the class docstring for the two paths
        that do run: startup self-seeding for a plugin with an ASGI app, and a
        ``db/imports/`` module for everything else.
        """

    @abstractmethod
    def on_uninstall(self) -> None:
        """**Not invoked.** Nothing calls this — implement it as a no-op.

        ``biffo plugin uninstall`` removes the plugin's code and Terraform and
        deliberately leaves its tables alone (ADR-0003 section 9), so there is
        no teardown moment for this to be part of.
        """

    def on_upgrade(self, from_version: str) -> None:
        """**Not invoked.** Nothing calls this, from *from_version* or otherwise.

        Kept as a concrete no-op so a plugin that overrode it still imports.
        Migration work belongs in the Alembic revisions the CLI generates from
        the manifest, which do run.
        """
        return None

    def subscribe(
        self, detail_type: str, source: str = "biffo.core"
    ) -> Callable[[EventHandler], EventHandler]:
        """Decorator registering a handler for events matching *detail_type*.

        Modelled on Flask/FastAPI route decorators (``@app.route(...)``),
        but bound to this plugin instance — usually applied inside
        ``__init__`` after ``super().__init__()`` runs — rather than a
        module-level app singleton, so each plugin instance owns its own
        ``self.events`` registrations::

            class MyPlugin(BiffoPluginBase):
                def __init__(self) -> None:
                    super().__init__(PluginManifest(name="my-plugin", version="1.0.0"))

                    @self.subscribe("user.created")
                    def handle_user_created(event: BiffoEvent) -> None:
                        ...

        *source* is accepted to match the events a plugin declares in its
        manifest's ``event_subscriptions`` (ADR-0003), but ``EventSubscriber``
        only dispatches by ``detail_type`` today — cross-source filtering is
        left to a later chunk, same as ``EventSubscriber.dispatch``'s
        ordering/error-handling semantics.
        """

        def decorator(handler: EventHandler) -> EventHandler:
            self.events.register(detail_type, handler)
            return handler

        return decorator

    def subscribe_all(self) -> Callable[[EventHandler], EventHandler]:
        """Decorator registering a handler for **every** event (a catch-all).

        Use for a generic forwarder that reacts to any event without enumerating
        detail types — e.g. the orchestration engine forwards every event to the
        Core API, which decides (from stored workflow definitions) what to do, so
        adding a new trigger needs no plugin code change (ADR-0010, epic #210)::

            @self.subscribe_all()
            async def _forward(event: BiffoEvent) -> None:
                await self.process_event(event)
        """

        def decorator(handler: EventHandler) -> EventHandler:
            self.events.register_all(handler)
            return handler

        return decorator

    def register(self) -> dict[str, Any]:
        """Delegate to ``register_plugin()`` and return the registration dict."""
        return register_plugin(self.manifest)
