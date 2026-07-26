"""User-facing and admin-facing plugin surface declarations (ADR-0021 / ADR-0018 §2).

Three top-level manifest keys let a marketplace plugin be user-facing or admin-facing:

- ``user_ingress`` — the plugin's authenticated, group-gated API. Its ``app``
  names an ASGI app the **shared plugin host** (ADR-0021) mounts at
  ``/api/v1/plugins/<name>/*``; the host provides the Lambda entry and enforces
  ``required_group`` (ADR-0011). The plugin ships no Lambda handler and no
  per-plugin infrastructure, and reaches Core only over the internal seams
  (ADR-0002 / ADR-0017 §3/§5).
- ``admin_ingress`` — the plugin's admin-gated API and optional static UI bundle.
  Its ``app`` names an ASGI app the shared plugin host mounts at
  ``/api/v1/plugins/<name>/admin/*``; the host provides the Lambda entry and
  enforces ``required_group`` (same schema as ``user_ingress``).
- ``user_frontend`` — a path-routed static app on an S3 origin and a
  ``<plugin>/*`` CloudFront behaviour, under the same Cognito App Client as the
  portal (ADR-0018 §2 frontend hosting, still in use).

All three are **distinct** from ADR-0013's public, unauthenticated ``http_ingress``
(webhooks): three declarations, two security postures, never one flag.

These are parsed piecemeal from the manifest (like ``plugin_route.py`` /
``plugin_table.py``), and — being a security surface — use ``extra="forbid"`` so a
typo'd key fails loudly rather than silently disabling a gate.
"""

from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

# An ASGI app reference "<module>:<attr>" (ADR-0021) — the shared plugin host mounts it.
_APP_REF = re.compile(r"^[a-zA-Z_][\w]*(\.[a-zA-Z_][\w]*)*:[a-zA-Z_][\w]*$")
# A repo-relative build directory, e.g. "web/dist". No absolute paths, no traversal.
_REL_DIR = re.compile(r"^[\w][\w./-]*$")


def _require_group(value: str) -> str:
    if not value.strip():
        raise ValueError("required_group must be a non-empty Cognito group name.")
    return value


class UserIngress(BaseModel):
    """The plugin's authenticated, group-gated API ingress (ADR-0021).

    ``app`` names the ASGI app the **shared plugin host** mounts at
    ``/api/v1/plugins/<name>/*``; the host provides the Lambda entry and enforces
    ``required_group`` (ADR-0011), so a plugin ships no Lambda handler and no
    infrastructure.
    """

    model_config = ConfigDict(extra="forbid")

    required_group: str = Field(
        description="The Cognito group a caller must be in. The shared plugin host "
        "enforces it before dispatching to the plugin (ADR-0011/0021)."
    )
    app: str = Field(
        description="ASGI app reference '<module>:<attr>' (e.g. 'ideation.app:app') "
        "the shared plugin host mounts (ADR-0021)."
    )

    @field_validator("required_group")
    @classmethod
    def _validate_required_group(cls, value: str) -> str:
        return _require_group(value)

    @field_validator("app")
    @classmethod
    def _validate_app(cls, value: str) -> str:
        if not _APP_REF.match(value):
            raise ValueError(
                f"user_ingress.app {value!r} must be an ASGI app reference "
                "'<module>:<attr>', e.g. 'ideation.app:app'."
            )
        return value


class AdminIngress(BaseModel):
    """The plugin's admin-gated API and optional static UI bundle.

    ``app`` names the ASGI app the **shared plugin host** mounts at
    ``/api/v1/plugins/<name>/admin/*``; the host provides the Lambda entry and
    enforces ``required_group`` (ADR-0011). The app may serve both JSON API
    routes and a static UI bundle via Starlette's StaticFiles.
    """

    model_config = ConfigDict(extra="forbid")

    required_group: str = Field(
        description="The Cognito group a caller must be in. The shared plugin host "
        "enforces it before dispatching to the plugin (ADR-0011)."
    )
    app: str = Field(
        description="ASGI app reference '<module>:<attr>' (e.g. 'ideation.admin:app') "
        "the shared plugin host mounts at /api/v1/plugins/<name>/admin/*."
    )

    @field_validator("required_group")
    @classmethod
    def _validate_required_group(cls, value: str) -> str:
        return _require_group(value)

    @field_validator("app")
    @classmethod
    def _validate_app(cls, value: str) -> str:
        if not _APP_REF.match(value):
            raise ValueError(
                f"admin_ingress.app {value!r} must be an ASGI app reference "
                "'<module>:<attr>', e.g. 'ideation.admin:app'."
            )
        return value


class UserFrontend(BaseModel):
    """The plugin's path-routed static frontend under shared-Cognito SSO (ADR-0018 §2)."""

    model_config = ConfigDict(extra="forbid")

    dir: str = Field(
        description="Repo-relative directory of the built static export "
        "(e.g. 'web/dist'), deployed to a new S3 origin behind <plugin>/* on the "
        "shared CloudFront."
    )
    required_group: str = Field(
        description="The Cognito group gated client-side (the real enforcement is the "
        "ingress and Core, never the client)."
    )

    @field_validator("dir")
    @classmethod
    def _validate_dir(cls, value: str) -> str:
        if value.startswith("/") or ".." in value.split("/") or not _REL_DIR.match(value):
            raise ValueError(
                f"user_frontend.dir {value!r} must be a repo-relative path with no "
                "leading '/' and no '..' traversal."
            )
        return value

    @field_validator("required_group")
    @classmethod
    def _validate_required_group(cls, value: str) -> str:
        return _require_group(value)


def parse_user_ingress_from_manifest(manifest: dict[str, Any]) -> UserIngress | None:
    """The manifest's ``user_ingress`` declaration, or ``None`` if absent."""
    raw = manifest.get("user_ingress")
    return None if raw is None else UserIngress(**raw)


def parse_admin_ingress_from_manifest(manifest: dict[str, Any]) -> AdminIngress | None:
    """The manifest's ``admin_ingress`` declaration, or ``None`` if absent."""
    raw = manifest.get("admin_ingress")
    return None if raw is None else AdminIngress(**raw)


def parse_user_frontend_from_manifest(manifest: dict[str, Any]) -> UserFrontend | None:
    """The manifest's ``user_frontend`` declaration, or ``None`` if absent."""
    raw = manifest.get("user_frontend")
    return None if raw is None else UserFrontend(**raw)
