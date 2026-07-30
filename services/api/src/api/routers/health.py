from fastapi import APIRouter
from pydantic import BaseModel

from ..core_version import core_version

router = APIRouter(prefix="/health", tags=["health"])


class HealthResponse(BaseModel):
    status: str
    #: The core version this deployment is running, or `"unknown"` outside a
    #: packaged deployment (#648).
    #:
    #: The field already existed with a default of `"0.0.0"` and was never
    #: populated, so `/health` has been promising a version and returning a
    #: placeholder. `"0.0.0"` was worse than absent: it is a plausible-looking
    #: semver, so it reads as a real answer rather than as no answer.
    version: str = "unknown"


@router.get("", response_model=HealthResponse)
async def health_check() -> HealthResponse:
    return HealthResponse(status="ok", version=core_version())
