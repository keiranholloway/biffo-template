from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from .base import TenantScopedModel


class Organization(TenantScopedModel):
    """A company/organization a user belongs to (free-standing, not Cognito-backed).

    Referenced by `User.organization_id`. Kept as its own table rather than a
    free-text column on `users` so admins pick from (or add to) one consistent
    list instead of the same company being spelled differently per user.
    """

    __tablename__ = "organizations"

    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
