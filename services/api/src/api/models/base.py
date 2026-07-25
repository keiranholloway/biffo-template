import uuid
from datetime import datetime
from typing import Any, ClassVar

from sqlalchemy import DateTime, String, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class TenantScopedModel(Base):
    """
    Abstract base for every Biffo table.

    All tables carry tenant_id to preserve the multi-tenant seam (ADR-0001).
    In single-tenant deployments this value is always 'default', but it must
    be present so adding real multi-tenancy never requires a schema migration.
    """

    __abstract__ = True

    # Declarative generic-CRUD permissions for this core table (ADR-0004). A
    # core model opts into the generic CRUD layer by setting this to a dict of
    # the same shape as a plugin manifest's table `permissions` block, e.g.:
    #   __crud_permissions__ = {
    #       "read": {"allowed": True, "required_role": ["admin"]},
    #   }
    # It is validated against TablePermissions (models/plugin_table.py) when the
    # permissions registry is built (ADR-0004 §2) — not here, to keep this base
    # module free of a circular import back into the manifest models. Empty (the
    # default) means fully denied: the table is invisible to the generic CRUD
    # layer. `User` deliberately leaves it unset — /users and /auth/me stay
    # hand-written because they carry auth-linkage semantics (ADR-0004 §1).
    __crud_permissions__: ClassVar[dict[str, Any]] = {}

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    tenant_id: Mapped[str] = mapped_column(
        String(64), nullable=False, index=True, default="default"
    )
    # Both a Python-side `default` AND a `server_default`. The server_default keeps
    # the DDL self-describing; the `default` makes the ORM self-sufficient — it puts
    # now() into the INSERT itself rather than relying on the column having a DB
    # default. That matters for plugin tables (ADR-0003): their generated migrations
    # created created_at/updated_at NOT NULL WITHOUT a DB default, so a server_default
    # alone left every owner-data INSERT (which omits the timestamps) violating the
    # NOT NULL constraint. With the `default`, the value is always supplied.
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=func.now(), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=func.now(),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
