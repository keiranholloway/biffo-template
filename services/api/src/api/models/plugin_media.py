"""What a plugin has stored (ADR-0021, biffo-template#1437).

One row per confirmed object. A row exists only after Core has verified with
``head_object`` that the bytes actually landed, so the table describes what S3
holds rather than what a client intended — an upload the browser abandoned
leaves a presigned URL that expires and no row at all.

Deliberately no ``__crud_permissions__``, like every other Core model: Core
tables are exposed through hand-written routers, not the generic-CRUD layer
(ADR-0004).
"""

from __future__ import annotations

from sqlalchemy import Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .base import TenantScopedModel


class PluginMedia(TenantScopedModel):
    __tablename__ = "plugin_media"
    __table_args__ = (
        # The key is already globally unique by construction (it carries a
        # uuid4), so this is not what stops collisions — it stops DOUBLE
        # CONFIRMATION. A client retrying a confirm after a timeout must not
        # produce a second row describing the same object, because a per-plugin
        # storage total would then count it twice.
        UniqueConstraint("tenant_id", "storage_key", name="uq_plugin_media_key"),
    )

    #: Which plugin owns this, as ``system:<plugin>``. From the verified
    #: principal, never the request — the same rule and the same reason as
    #: ``AgentRun.caller_plugin``: a forgeable owner makes every per-plugin
    #: figure meaningless, and here it would also be a read grant on another
    #: plugin's files.
    owner_plugin: Mapped[str] = mapped_column(String(128), nullable=False, index=True)

    #: Full S3 key. Not a URL: a presigned URL is minted per request and expires,
    #: so storing one would persist something already stale. The key is the
    #: durable identity; the URL is derived from it on demand.
    storage_key: Mapped[str] = mapped_column(String(1024), nullable=False)

    #: The filename the uploader gave, sanitised. Decoration for
    #: content-disposition, never part of the key's identity.
    filename: Mapped[str] = mapped_column(String(255), nullable=False)

    #: Both read from S3 at confirm time via ``head_object``, never accepted
    #: from the caller. A client that could declare these could claim a 25 MB
    #: image for a 10 KB text file, and any storage total built on them would be
    #: fiction.
    mime_type: Mapped[str] = mapped_column(String(255), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
