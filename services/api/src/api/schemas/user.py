from datetime import datetime

from pydantic import EmailStr

from .base import BiffoBaseSchema


class UserResponse(BiffoBaseSchema):
    email: EmailStr
    username: str
    is_active: bool
    last_login_at: datetime | None = None


class UserUpdateRequest(BiffoBaseSchema):
    username: str | None = None
    is_active: bool | None = None
