"""Plugin table definition models for dynamic schema generation.

ColumnDefinition/IndexDefinition/PermissionRule/TablePermissions/
PluginTableDefinition are mirrored in
packages/python-sdk/src/biffo_plugin_sdk/plugin.py for external plugin
authors (that package can't import this module — it's installed outside
the Core API's own deployment), and again in cli/src/lib/plugin-manifest.ts
(zod) for install-time validation. If any side's fields, defaults, or
validators change, update the others.

**Exception — ``PermissionRule.allowed_principals`` is intentionally NOT
mirrored.** It is the ADR-0014 §7 agent read-scope ceiling, and §7 places that
ceiling on Core model classes only: a table is reachable by agents solely by
having a Core model that names a principal, while plugin-authored and
DDL-imported tables are deliberately invisible to agents. A plugin manifest has
no reason to carry the field, and the CLI zod's ``.strict()`` correctly rejects
it at install time. Core's ``PermissionRule`` becoming a strict superset of the
plugin-facing schema keeps the CLI's guarantee intact (a manifest that passes
zod still parses here); the reverse divergence — Core rejecting what the CLI
accepts — is what the mirror exists to prevent, and it does not occur.
"""

from __future__ import annotations

import ast
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import Boolean, DateTime, Float, Integer, String, Text

# Module-level constant — built once, not on every _resolve_sa_type call.
_TYPE_MAP: dict[str, type] = {
    "String": String,
    "Integer": Integer,
    "Text": Text,
    "Boolean": Boolean,
    "Float": Float,
    "DateTime": DateTime,
}


def resolve_type_call(type_str: str) -> tuple[str, list[Any], dict[str, Any]]:
    """Parse a type string like 'String(36)' or 'DateTime(timezone=True)' into
    (base_type_name, positional_args, keyword_args).

    Only literal argument values are evaluated (via ast.literal_eval on each
    argument node individually) — arbitrary expressions are rejected rather
    than silently dropped or spliced verbatim into generated code.
    """
    if "(" not in type_str:
        return type_str, [], {}

    base_type, _, rest = type_str.partition("(")
    params = rest[:-1] if rest.endswith(")") else rest

    try:
        call = ast.parse(f"_({params})", mode="eval").body
    except SyntaxError as exc:
        raise ValueError(f"Invalid type parameters in {type_str!r}: {exc}") from exc
    if not isinstance(call, ast.Call):
        raise ValueError(f"Invalid type parameters in {type_str!r}")

    try:
        args = [ast.literal_eval(a) for a in call.args]
        kwargs = {kw.arg: ast.literal_eval(kw.value) for kw in call.keywords if kw.arg}
    except ValueError as exc:
        raise ValueError(f"Invalid type parameters in {type_str!r}: {exc}") from exc

    return base_type, args, kwargs


class ColumnDefinition(BaseModel):
    """Defines a single column on a plugin-created table.

    The Core API translates these into SQLAlchemy mapped columns.
    """

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
# canonical order. Mirrored as the keys of TablePermissions below, the
# operation Literal in plugin_route.py, and the equivalents in the SDK and CLI.
CRUD_OPERATIONS: tuple[str, ...] = ("list", "read", "create", "update", "delete")


class PermissionRule(BaseModel):
    """Authorization rule for a single CRUD operation on a table (ADR-0004).

    Default-deny: an operation is invisible to the generic CRUD layer unless
    ``allowed`` is explicitly true. ``required_role`` is an any-of allow-list
    matched against the caller's ``cognito:groups`` (``AuthenticatedUser.roles``);
    an empty list means any authenticated caller may perform the operation once
    it is allowed. Tenant scoping (ADR-0001) is applied unconditionally by the
    generic layer regardless of this rule and is deliberately not configurable
    here.

    ``allowed_principals`` is a **separate** allow-list on a distinct axis
    (ADR-0014 §7): the agent read-scope ceiling. It is evaluated **only** for
    ADR-0009 service principals (the ``require_service_crud_permission`` guard),
    never for ``AuthenticatedUser`` — and ``required_role`` is likewise never
    consulted for a service principal. The two fields are deliberately kept
    apart because folding the agent grant into ``required_role`` would let a
    Cognito group literally named ``agent-runtime`` — creatable out-of-band via
    the AWS console/CLI — silently confer agent read access. The ``system:``
    prefix is legibility; the security property is that this is a field a
    Cognito group cannot populate at all.

    ``extra="forbid"`` so a typo'd key (e.g. ``role`` for ``required_role``)
    fails loudly rather than being silently ignored on a security surface.

    ``permission_code`` is a **second axis**, in the same spirit as
    ``allowed_principals``: a DB-held permission code rather than a Cognito
    group. The template already resolves these per request everywhere else —
    ``AuthenticatedUser.permissions`` (middleware/auth.py),
    ``IdentityProvider.resolve_permissions`` (ADR-0012), write-back
    (``WriteBackTarget.permission_code``) and orchestration all honour them, and
    ADR-0025 attributes the permission set to ADR-0004 by name. The generic CRUD
    layer was the only subsystem that could not see them, so an instance whose
    authorization is DB-held had to **fork this file and dependencies.py** —
    which is the fork ADR-0004 exists to prevent (#889).

    The field must live here rather than being added by an instance because
    ``extra="forbid"`` above is correct and stays: an instance cannot extend a
    forbidden-extras model from outside, and loosening it to let them would
    trade a real guard for an extension point.

    **The two axes are AND, not either/or.** If both are set, both must hold.
    The issue proposed short-circuiting on ``permission_code`` and returning,
    which would make a declared ``required_role`` *silently ignored* — the exact
    failure ``extra="forbid"`` exists to prevent, two lines up. AND is also
    sufficient for the DB-held case, because an empty ``required_role`` already
    authorises any authenticated caller, so a rule setting only
    ``permission_code`` behaves exactly as that instance needs.
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
    permission_code: str = Field(
        default="",
        description=(
            "ADR-0004 second authorization axis: a DB-held permission code the "
            "caller must hold, resolved per request through the ADR-0012 "
            "identity seam into AuthenticatedUser.permissions. Empty by "
            "default, which preserves role-only authorization exactly."
        ),
    )
    allowed_principals: list[str] = Field(
        default_factory=list,
        description=(
            "ADR-0014 §7 agent read-scope ceiling: service-principal logical "
            "names (e.g. 'system:agent-runtime') permitted to read this "
            "operation. Empty by default — thin-by-default, a table grants "
            "agents nothing until it names one. Evaluated only for ADR-0009 "
            "service principals, never for authenticated Cognito users."
        ),
    )

    @field_validator("allowed_principals")
    @classmethod
    def _validate_allowed_principals(cls, value: list[str]) -> list[str]:
        """Every entry must be a non-empty ``system:<name>`` string.

        The ``system:`` prefix is legibility per ADR-0014 §7, but enforcing it
        here is fail-loud hygiene on a security surface: the only values that
        can ever match a derived principal name are ``system:<name>`` (see
        ``ServicePrincipal.logical_names``), so an entry without the prefix — or
        an empty one — is unmatchable dead config that should be rejected at
        parse time rather than silently never granting anything.
        """
        for entry in value:
            if not entry.startswith("system:") or len(entry) <= len("system:"):
                raise ValueError(
                    f"allowed_principals entry {entry!r} must be a non-empty "
                    "'system:<name>' string (ADR-0014 §7)."
                )
        return value


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


class OwnerScopedServiceAccess(BaseModel):
    """Opts a CRUD-closed table into service-auth, owner-scoped access (ADR-0017 §5).

    A plugin's own Lambda may read/write this table's rows through Core's internal
    owner-scoped data API — but only when **both** hold:

    - it authenticates as an allowed service principal (SigV4, ADR-0009), and
    - it acts on behalf of a **forwarded, re-verified founder** (ADR-0017 §3).

    Core scopes every row to that founder via ``owner_column`` and takes the owner
    from the verified token, **never from the request**. This is a third, distinct
    axis: separate from ``permissions`` (tenant CRUD) and from
    ``PermissionRule.allowed_principals`` (the ADR-0014 §7 agent *read* ceiling). A
    table can therefore be closed to tenants and to agents yet still be managed by
    its owning module for its own user. Default-deny: absent means no such access.
    """

    model_config = ConfigDict(extra="forbid")

    owner_column: str = Field(
        description="The column holding the owner's Cognito sub. Every row is scoped "
        "to the forwarded founder on this column; it is never settable from a request."
    )
    allowed_principals: list[str] = Field(
        description="'system:<name>' service principals (the owning module's Lambda) "
        "permitted to manage rows. Empty is rejected — an opt-in with no principal "
        "grants nothing and is dead config."
    )

    @field_validator("allowed_principals")
    @classmethod
    def _validate_allowed_principals(cls, value: list[str]) -> list[str]:
        if not value:
            raise ValueError(
                "owner_scoped_service.allowed_principals must name at least one "
                "'system:<name>' principal (ADR-0017 §5)."
            )
        for entry in value:
            if not entry.startswith("system:") or len(entry) <= len("system:"):
                raise ValueError(
                    f"allowed_principals entry {entry!r} must be a non-empty "
                    "'system:<name>' string (ADR-0014 §7)."
                )
        return value


# Shared auto-column definitions — kept in sync with TenantScopedModel in base.py.
# If TenantScopedModel gains a new column, update this list too.
_AUTO_COLUMNS: list[ColumnDefinition] = [
    ColumnDefinition(name="id", type="String(36)", primary_key=True),
    ColumnDefinition(name="tenant_id", type="String(64)", nullable=False, index=True),
    ColumnDefinition(
        name="created_at",
        type="DateTime(timezone=True)",
        nullable=False,
    ),
    ColumnDefinition(
        name="updated_at",
        type="DateTime(timezone=True)",
        nullable=False,
    ),
]

# These names are reserved for the auto-columns above and may not be
# redeclared by a manifest — see _ensure_auto_columns.
_AUTO_COLUMN_NAMES: frozenset[str] = frozenset(c.name for c in _AUTO_COLUMNS)


class PluginTableDefinition(BaseModel):
    """Defines a complete table schema for a plugin.

    Automatically adds id, tenant_id, created_at, updated_at columns
    following the TenantScopedModel pattern (ADR-0001).
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
    owner_scoped_service: OwnerScopedServiceAccess | None = Field(
        default=None,
        description="Opt this table into service-auth, owner-scoped access for its "
        "owning module's Lambda (ADR-0017 §5). Independent of `permissions`; a table "
        "may be CRUD-closed to tenants yet managed here by its owner.",
    )

    @model_validator(mode="before")
    @classmethod
    def _ensure_auto_columns(cls, data: Any) -> Any:
        """Ensure auto-columns are always present, using their canonical
        definition — a manifest may not redeclare a reserved auto-column
        name, since doing so could silently weaken the tenant-isolation
        guarantee (ADR-0001), e.g. by declaring tenant_id as nullable.
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
    def _validate_uniqueness(self) -> PluginTableDefinition:
        """Validate no duplicate column or index names."""
        from collections import Counter

        col_counts = Counter(c.name for c in self.columns)
        dupes = [n for n, c in col_counts.items() if c > 1]
        if dupes:
            raise ValueError(f"Duplicate column names: {dupes}")

        idx_counts = Counter(i.name for i in self.indexes)
        idx_dupes = [n for n, c in idx_counts.items() if c > 1]
        if idx_dupes:
            raise ValueError(f"Duplicate index names: {idx_dupes}")

        # Validate index columns reference actual columns
        valid_cols = set(col_counts.keys())
        for idx in self.indexes:
            for col in idx.columns:
                if col not in valid_cols:
                    raise ValueError(
                        f"Index '{idx.name}' references unknown column '{col}'. "
                        f"Valid columns: {valid_cols}"
                    )

        # The owner-scope column must be a real, non-auto column: scoping on a
        # missing column would fail-open (no filter) and scoping on tenant_id/id
        # would mean the row's owner is not the founder (ADR-0017 §5).
        if self.owner_scoped_service is not None:
            owner_column = self.owner_scoped_service.owner_column
            if owner_column in _AUTO_COLUMN_NAMES:
                raise ValueError(
                    f"owner_scoped_service.owner_column '{owner_column}' may not be an "
                    "auto-managed column; declare a column that holds the owner's sub."
                )
            if owner_column not in valid_cols:
                raise ValueError(
                    f"owner_scoped_service.owner_column '{owner_column}' is not a declared "
                    f"column. Valid columns: {sorted(valid_cols)}"
                )
        return self

    def to_sqlalchemy_model(self) -> type[Any]:
        """Convert this table definition into a SQLAlchemy model class.

        Returns:
            A new SQLAlchemy model class inheriting from TenantScopedModel.
        """
        from sqlalchemy import Column

        from .base import TenantScopedModel

        kwargs: dict[str, Any] = {"__tablename__": self.name}

        for col in self.columns:
            if col.name in _AUTO_COLUMN_NAMES:
                # Inherited from TenantScopedModel as-is, which is where the
                # Python-side defaults (uuid4 id, "default" tenant_id, server
                # timestamps) live. Rebuilding these as plain Column(...) here
                # would shadow those defaults and break inserts that don't set
                # id/tenant_id explicitly.
                continue

            col_kwargs: dict[str, Any] = {}
            if col.primary_key:
                col_kwargs["primary_key"] = True
            if not col.nullable:
                col_kwargs["nullable"] = False
            if col.default is not None:
                col_kwargs["server_default"] = col.default

            sa_type = self._resolve_sa_type(col.type)
            kwargs[col.name] = Column(sa_type, **col_kwargs)

        return type(self.name.capitalize(), (TenantScopedModel,), kwargs)

    @staticmethod
    def _resolve_sa_type(type_str: str) -> Any:
        """Resolve a type string like 'String(36)' or 'DateTime(timezone=True)'
        to a SQLAlchemy type instance."""
        base_type, args, kwargs = resolve_type_call(type_str)
        cls = _TYPE_MAP.get(base_type) or String
        return cls(*args, **kwargs)
