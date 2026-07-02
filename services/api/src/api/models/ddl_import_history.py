from sqlalchemy import String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .base import TenantScopedModel


class DdlImportHistory(TenantScopedModel):
    """Bookkeeping for api.ddl_import (docs/ADR/0005-ddl-import-module.md) --
    one row per applied DDL file, keyed by (tenant_id, import_name, filename).

    Stores a sha256 checksum of the file's content at apply time so a re-run
    of `biffo data apply` can skip already-applied, unchanged files and fail
    closed -- rather than silently reapplying -- if a previously-applied
    file's content has since changed (the DDL this tracks is not assumed to
    be idempotent; see the ADR).

    An ordinary Alembic-managed, tenant-scoped table like every other table
    in this app (ADR-0001) -- not raw SQL living outside the ORM. The DDL
    files this table tracks are themselves executed via a raw connection
    (see main.py's _run_ddl_import), but the bookkeeping *of* that is plain
    application data.
    """

    __tablename__ = "ddl_import_history"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id",
            "import_name",
            "filename",
            name="uq_ddl_import_history_tenant_import_filename",
        ),
    )

    import_name: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    checksum: Mapped[str] = mapped_column(String(64), nullable=False)
