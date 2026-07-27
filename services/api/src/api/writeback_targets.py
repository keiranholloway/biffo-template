"""Registry of agent write-back targets, and the principal-session seam (ADR-0027).

ADR-0014 §7 forbade agent writes outright. ADR-0027 lifts that under three
conditions that must all hold, and this module owns the first and the third:

1. **The ceiling** — a table is writeable only if an instance registers a
   :class:`WriteBackTarget` for it. The registry starts empty, so a freshly
   scaffolded instance can write nothing and no admin toggle can change that;
   widening it is a reviewed code change and a deploy, which is §7's stated
   reason for putting the ceiling in code rather than configuration.
2. The definition's declared config, validated on save (``schemas/orchestration``).
3. **The author's own authority** — enforced by the instance's row policies,
   reached through :func:`bind_principal_session` below.

Registration happens at instance domain-module import time, exactly like the
event registry (``events/registry.py``), the scope resolver (``scope_resolvers``)
and the scoped authorizer (``orchestration_authz``): a downstream repo declares
what it will let an agent write without editing this file.

Why the session binding is a seam
---------------------------------
Row-level security is **not** in this template. ``db_app_role.py`` says so
outright: the privilege split (the request path connects as a non-owning
``biffo_app`` role) shipped, but RLS policies and the ``SET LOCAL
app.current_user_id`` GUC plumbing were deferred with #229, see ADR-0012's
amendment. So the template genuinely cannot answer "make this session act as
that user" — only an instance that has policies can.

The default provider therefore **refuses**. An instance that has registered
nothing writes nothing, rather than writing on an unbound session where no
policy would scope it. A template that wrote the row itself would be promising
an enforcement it cannot deliver, and the failure would be silent and total.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from aws_lambda_powertools import Logger
from sqlalchemy.ext.asyncio import AsyncSession

logger = Logger()

#: The operations a target may ever expose. ``delete`` is deliberately absent and
#: has no representation anywhere in this module — ADR-0027 §5. Adding it is a
#: decision, not a config change.
WRITEBACK_OPERATIONS: tuple[str, ...] = ("create", "update")

#: Column value types a target may declare. These drive both the builder's
#: picker and the JSON Schema the agent's output tool is generated from, so the
#: set is deliberately small and maps cleanly onto both.
COLUMN_TYPES: tuple[str, ...] = (
    "text",
    "textarea",
    "email",
    "tel",
    "url",
    "number",
    "boolean",
    "enum",
)

#: What an update does to a column that already holds a value.
#:
#: ``if_empty`` is the default, and the reason is the point of the setting: an
#: agent enriching a record must not clobber what a person typed unless the
#: target explicitly says it may.
OVERWRITE_MODES: tuple[str, ...] = ("if_empty", "append", "always")

#: Columns an agent may never set, whatever a target declares. ``tenant_id`` is
#: the ADR-0001 seam, ``id`` identifies the row, and the timestamps are the audit
#: trail — all of them are Core's to write.
RESERVED_COLUMNS: frozenset[str] = frozenset(
    {"id", "tenant_id", "created_at", "updated_at", "deleted_at"}
)

#: How a derived value is produced. ``from_scope`` is the one that matters for
#: security: it takes the id from the *definition's validated scope*, which is
#: the only trustworthy source for a column an authorization decision turns on.
DERIVED_KINDS: tuple[str, ...] = ("from_tenant", "from_scope", "literal")


class WriteBackConfigurationError(ValueError):
    """A target was registered in a shape that could never be safe.

    Raised at import time, so a bad declaration fails the deploy rather than the
    request — the whole point of putting the ceiling in code.
    """


@dataclass(frozen=True)
class WriteBackColumn:
    """One column an agent is permitted to supply a value for."""

    name: str
    label: str
    type: str = "text"
    required: bool = False
    #: Permitted values when ``type`` is ``enum``; ignored otherwise.
    values: tuple[str, ...] = ()
    overwrite: str = "if_empty"

    def __post_init__(self) -> None:
        if not self.name:
            raise WriteBackConfigurationError("A write-back column needs a name.")
        if self.type not in COLUMN_TYPES:
            raise WriteBackConfigurationError(
                f"Column {self.name!r} has unknown type {self.type!r}; "
                f"expected one of {list(COLUMN_TYPES)}."
            )
        if self.overwrite not in OVERWRITE_MODES:
            raise WriteBackConfigurationError(
                f"Column {self.name!r} has unknown overwrite mode {self.overwrite!r}; "
                f"expected one of {list(OVERWRITE_MODES)}."
            )
        if self.type == "enum" and not self.values:
            raise WriteBackConfigurationError(
                f"Column {self.name!r} is an enum but declares no values, so nothing "
                "could ever be written to it."
            )


@dataclass(frozen=True)
class DerivedValue:
    """A column Core sets itself, from trusted state — never from the agent.

    This is the escalation guard, not a convenience. Any column an instance's row
    policies evaluate (for tabsii's ``leads``, ``brand_id``) decides the
    authorization outcome; if the model could supply it, LLM output would be
    feeding an authorization decision and an author scoped to one brand could
    have their agent write into another.
    """

    column: str
    kind: str
    #: The scope level to read the id from, when ``kind`` is ``from_scope``.
    level: str | None = None
    #: The fixed value, when ``kind`` is ``literal``.
    value: Any = None

    def __post_init__(self) -> None:
        if self.kind not in DERIVED_KINDS:
            raise WriteBackConfigurationError(
                f"Derived column {self.column!r} has unknown kind {self.kind!r}; "
                f"expected one of {list(DERIVED_KINDS)}."
            )
        if self.kind == "from_scope" and not self.level:
            raise WriteBackConfigurationError(
                f"Derived column {self.column!r} is from_scope but names no level."
            )


def from_tenant(column: str = "tenant_id") -> DerivedValue:
    """The ADR-0001 tenant seam."""
    return DerivedValue(column=column, kind="from_tenant")


def from_scope(column: str, level: str) -> DerivedValue:
    """The id the definition's validated ``scope`` carries at ``level``."""
    return DerivedValue(column=column, kind="from_scope", level=level)


def literal(column: str, value: Any) -> DerivedValue:
    """A fixed value — provenance markers such as ``source="agent"``."""
    return DerivedValue(column=column, kind="literal", value=value)


@dataclass(frozen=True)
class RowSelector:
    """How an ``update`` finds its row — from the *trigger event's* payload.

    Never from the agent's output. A run's target row is settled by the event
    that caused it, before the model produces anything; letting the model choose
    would make "which row" an LLM decision, and visibility under the instance's
    policies would be the only thing left standing between it and any row in the
    table.
    """

    payload_field: str
    #: The column that field is matched against.
    column: str = "id"

    def __post_init__(self) -> None:
        if not self.payload_field:
            raise WriteBackConfigurationError("A row selector needs a payload field name.")


@dataclass(frozen=True)
class WriteBackTarget:
    """A table an agent workflow may write to, and exactly how."""

    table: str
    model: type[Any]
    label: str
    permission_code: str
    allowed_principals: tuple[str, ...]
    columns: tuple[WriteBackColumn, ...]
    operations: tuple[str, ...] = ("create",)
    derived: tuple[DerivedValue, ...] = ()
    row_selector: RowSelector | None = None

    def __post_init__(self) -> None:
        if not self.operations:
            raise WriteBackConfigurationError(
                f"Target {self.table!r} declares no operations, so it grants nothing."
            )
        unknown_ops = [op for op in self.operations if op not in WRITEBACK_OPERATIONS]
        if unknown_ops:
            raise WriteBackConfigurationError(
                f"Target {self.table!r} declares unknown operation(s) {unknown_ops}; "
                f"expected some of {list(WRITEBACK_OPERATIONS)}. Note that `delete` is "
                "not offered by design (ADR-0027 §5)."
            )
        if not self.permission_code:
            raise WriteBackConfigurationError(
                f"Target {self.table!r} declares no permission_code, so no authority "
                "could ever be checked against it."
            )
        if not self.allowed_principals:
            raise WriteBackConfigurationError(
                f"Target {self.table!r} names no allowed_principals, which grants "
                "nothing and is dead config."
            )
        for entry in self.allowed_principals:
            if not entry.startswith("system:") or len(entry) <= len("system:"):
                raise WriteBackConfigurationError(
                    f"allowed_principals entry {entry!r} must be a non-empty "
                    "'system:<name>' string (ADR-0014 §7)."
                )
        if not self.columns:
            raise WriteBackConfigurationError(
                f"Target {self.table!r} declares no writeable columns."
            )

        names = [column.name for column in self.columns]
        duplicated = sorted({name for name in names if names.count(name) > 1})
        if duplicated:
            raise WriteBackConfigurationError(
                f"Target {self.table!r} declares column(s) {duplicated} more than once."
            )
        reserved = sorted(RESERVED_COLUMNS.intersection(names))
        if reserved:
            raise WriteBackConfigurationError(
                f"Target {self.table!r} would let an agent set {reserved}, which Core "
                "always sets itself (ADR-0027 §4)."
            )
        derived_names = {value.column for value in self.derived}
        overlap = sorted(derived_names.intersection(names))
        if overlap:
            # The whole point of `derived` is that these values come from trusted
            # state. A column in both sets would be settable by the agent, which
            # silently defeats the guard rather than failing.
            raise WriteBackConfigurationError(
                f"Target {self.table!r} declares {overlap} as both agent-writeable and "
                "derived; a column an authorization decision turns on must be derived "
                "only (ADR-0027 §4)."
            )

        if "update" in self.operations and self.row_selector is None:
            raise WriteBackConfigurationError(
                f"Target {self.table!r} allows update but declares no row_selector, so "
                "the row to update could only come from the agent (ADR-0027 §5)."
            )
        if "update" not in self.operations and self.row_selector is not None:
            raise WriteBackConfigurationError(
                f"Target {self.table!r} declares a row_selector but does not allow "
                "update, so the selector is dead config."
            )

    @property
    def column_names(self) -> tuple[str, ...]:
        return tuple(column.name for column in self.columns)

    def column(self, name: str) -> WriteBackColumn | None:
        return next((c for c in self.columns if c.name == name), None)

    @property
    def scope_levels(self) -> tuple[str, ...]:
        """Scope levels this target derives a column from.

        Non-empty means a definition writing here **must** carry a scope — there
        would otherwise be no id to derive, and the write would either be
        unscoped or fail at the policy. The router checks this at authoring time
        so the failure lands on save rather than hours later on a completion.
        """
        return tuple(v.level for v in self.derived if v.kind == "from_scope" and v.level)

    def allows(self, principal_names: frozenset[str]) -> bool:
        """Whether a service principal may trigger a write to this target."""
        return bool(principal_names.intersection(self.allowed_principals))


_targets: dict[str, WriteBackTarget] = {}


def register_writeback_target(target: WriteBackTarget) -> WriteBackTarget:
    """Declare a table an agent workflow may write to.

    Idempotent by replacement, like the other registries: a later registration
    for the same table supersedes the earlier one.
    """
    _targets[target.table] = target
    return target


def resolve_writeback_target(table: str) -> WriteBackTarget | None:
    """The registered target for ``table``, or ``None``.

    Callers answer ``None`` with a 404 rather than a 403: an ungranted table must
    be indistinguishable from one that does not exist (ADR-0004 §4), so one
    workflow cannot probe for what another may write.
    """
    return _targets.get(table)


def registered_writeback_targets() -> tuple[WriteBackTarget, ...]:
    """Every registered target, in registration order. Empty by default."""
    return tuple(_targets.values())


# ── The principal-session seam ────────────────────────────────────────────────

#: ``(db, user_id) -> was the session bound to that principal?`` Async because
#: binding is a database round-trip (a ``set_config`` on the live session). It
#: returns a bool rather than raising so a refusal is an ordinary, recordable
#: outcome — an instance without RLS is not an error, it simply cannot write back.
PrincipalSessionProvider = Callable[[AsyncSession, str], Awaitable[bool]]


async def _default_provider(db: AsyncSession, user_id: str) -> bool:
    """Refuse. This template has no row-level security to bind to (#229).

    Returning ``False`` — rather than doing nothing and letting the caller
    proceed — is what stops a deployment with no policies from writing every row
    unscoped and calling it authorized.
    """
    del db, user_id
    return False


_provider: PrincipalSessionProvider = _default_provider


def register_principal_session_provider(provider: PrincipalSessionProvider) -> None:
    """Declare how this instance binds a database session to a stored user.

    Idempotent like ``register_workflow_scope_authorizer``: exactly one active
    provider, since an instance has exactly one authorization model.
    """
    global _provider
    _provider = provider


async def bind_principal_session(db: AsyncSession, user_id: str) -> bool:
    """Bind ``db`` to ``user_id`` so the instance's row policies apply.

    A provider that raises is treated as a refusal, not as a pass. That
    direction is deliberate: the alternative is a write proceeding on a session
    whose binding failed halfway, which is the one outcome this seam exists to
    make impossible.
    """
    if not user_id:
        return False
    try:
        return bool(await _provider(db, user_id))
    except Exception:  # noqa: BLE001 — a failed binding must never become a write
        logger.exception(
            "Principal-session binding failed; refusing the write-back",
            extra={"user_id": user_id},
        )
        return False
