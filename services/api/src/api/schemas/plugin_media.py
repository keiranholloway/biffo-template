"""Schemas for plugin object storage (ADR-0021, #1437).

Note what is absent from every request model: the owning plugin. It is resolved
from the verified ``ServicePrincipal`` at the route, never accepted from the
body — a caller able to name its own owner could read and overwrite another
plugin's files.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from .base import BiffoBaseSchema


class PresignUploadRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    content_type: str = Field(min_length=1, max_length=255)


class PresignUploadResponse(BaseModel):
    """What the browser needs to POST directly to S3.

    ``fields`` must be sent verbatim and ``key`` echoed back to confirm. The key
    is returned rather than left for the caller to construct, because it carries
    a server-generated uuid the caller cannot know — which is exactly what keeps
    it unguessable and traversal-free.
    """

    key: str
    url: str
    fields: dict[str, str]
    max_bytes: int
    expires_in: int


class ConfirmUploadRequest(BaseModel):
    key: str = Field(min_length=1, max_length=1024)


class PluginMediaResponse(BiffoBaseSchema):
    owner_plugin: str
    storage_key: str
    filename: str
    mime_type: str
    size_bytes: int


class MediaUrlResponse(BaseModel):
    """A short-lived GET URL.

    ``expires_in`` is returned so a caller can decide whether to re-request
    rather than hard-coding an assumption about the window. A URL held past it
    fails at S3, not here.
    """

    url: str
    expires_in: int
