from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import TenantScopedModel
from .organization import Organization


class User(TenantScopedModel):
    __tablename__ = "users"

    cognito_sub: Mapped[str] = mapped_column(String(36), unique=True, nullable=False, index=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    username: Mapped[str] = mapped_column(String(64), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Non-identity profile fields. given_name/family_name/phone_number live on
    # Cognito (the identity source of truth) instead of being duplicated here —
    # these columns are the ones Cognito has no concept of.
    organization_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("organizations.id"), nullable=True, index=True
    )
    job_role: Mapped[str | None] = mapped_column(String(128), nullable=True)
    address_line1: Mapped[str | None] = mapped_column(String(255), nullable=True)
    address_line2: Mapped[str | None] = mapped_column(String(255), nullable=True)
    city: Mapped[str | None] = mapped_column(String(128), nullable=True)
    region: Mapped[str | None] = mapped_column(String(128), nullable=True)
    postal_code: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # ISO 3166-1 alpha-2 (e.g. "GB", "US") — kept a fixed short code rather than a
    # free-text country name so it stays consistent and sortable/filterable.
    country: Mapped[str | None] = mapped_column(String(2), nullable=True)

    organization: Mapped[Organization | None] = relationship()
