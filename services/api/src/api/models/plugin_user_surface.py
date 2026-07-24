"""User-facing plugin surface declarations (ADR-0018).

Two top-level manifest keys let a marketplace plugin be hosted as an
*authenticated sibling* (ADR-0018), reusing ADR-0007's path-routed CloudFront +
shared-Cognito SSO:

- ``user_ingress`` — the plugin's own Lambda behind a Function URL and a
  ``<plugin>/api/*`` CloudFront behaviour. The handler verifies the shared-Cognito
  JWT itself and gates on ``required_group``; it holds no data and reaches Core only
  over the internal seams (ADR-0002 / ADR-0017 §3/§5).
- ``user_frontend`` — a path-routed static app on a new S3 origin and a
  ``<plugin>/*`` behaviour, under the same Cognito App Client as the portal.

Both are **distinct** from ADR-0013's public, unauthenticated ``http_ingress``
(webhooks): two declarations, two security postures, never one flag.

These are parsed piecemeal from the manifest (like ``plugin_route.py`` /
``plugin_table.py``), and — being a security surface — use ``extra="forbid"`` so a
typo'd key fails loudly rather than silently disabling a gate.
"""

from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

# A single URL path segment: the plugin mounts its ingress under <plugin>/<path>/*,
# so the segment must not itself contain a slash or be empty.
_PATH_SEGMENT = re.compile(r"^[a-z][a-z0-9_-]*$")
# A dotted import path to the Lambda handler, e.g. "ideation.lambda.handler".
_HANDLER = re.compile(r"^[a-zA-Z_][\w]*(\.[a-zA-Z_][\w]*)+$")
# An ASGI app reference "<module>:<attr>" (ADR-0021) — the shared plugin host mounts it.
_APP_REF = re.compile(r"^[a-zA-Z_][\w]*(\.[a-zA-Z_][\w]*)*:[a-zA-Z_][\w]*$")
# A repo-relative build directory, e.g. "web/dist". No absolute paths, no traversal.
_REL_DIR = re.compile(r"^[\w][\w./-]*$")


def _require_group(value: str) -> str:
    if not value.strip():
        raise ValueError("required_group must be a non-empty Cognito group name.")
    return value


class UserIngress(BaseModel):
    """The plugin's authenticated, group-gated API ingress.

    ADR-0021: ``app`` names the ASGI app the **shared plugin host** mounts at
    ``/api/v1/plugins/<name>/*``; the host provides the Lambda entry and enforces
    ``required_group`` (ADR-0011), so a plugin ships no Lambda handler and no
    infrastructure. ``handler`` (ADR-0018, a per-plugin Lambda) is retained for
    legacy plugins and is **deprecated**. A plugin must declare exactly one.
    """

    model_config = ConfigDict(extra="forbid")

    required_group: str = Field(
        description="The Cognito group a caller must be in. The shared plugin host "
        "enforces it before dispatching to the plugin (ADR-0011/0021)."
    )
    app: str | None = Field(
        default=None,
        description="ASGI app reference '<module>:<attr>' (e.g. 'ideation.app:app') "
        "the shared plugin host mounts (ADR-0021). Preferred over `handler`.",
    )
    handler: str | None = Field(
        default=None,
        description="Legacy (ADR-0018): dotted Lambda handler for a per-plugin "
        "Lambda. Deprecated in favour of `app` — never imported by Core (ADR-0002).",
    )
    path: str = Field(
        default="api",
        description="Legacy (ADR-0018): the single path segment under which a "
        "per-plugin Function-URL ingress was routed. Unused under ADR-0021.",
    )

    @field_validator("path")
    @classmethod
    def _validate_path(cls, value: str) -> str:
        if not _PATH_SEGMENT.match(value):
            raise ValueError(
                f"user_ingress.path {value!r} must be a single lowercase path segment "
                "(letters, digits, '-', '_'); it must not contain '/'."
            )
        return value

    @field_validator("required_group")
    @classmethod
    def _validate_required_group(cls, value: str) -> str:
        return _require_group(value)

    @field_validator("app")
    @classmethod
    def _validate_app(cls, value: str | None) -> str | None:
        if value is not None and not _APP_REF.match(value):
            raise ValueError(
                f"user_ingress.app {value!r} must be an ASGI app reference "
                "'<module>:<attr>', e.g. 'ideation.app:app'."
            )
        return value

    @field_validator("handler")
    @classmethod
    def _validate_handler(cls, value: str | None) -> str | None:
        if value is not None and not _HANDLER.match(value):
            raise ValueError(
                f"user_ingress.handler {value!r} must be a dotted import path, "
                "e.g. 'ideation.lambda.handler'."
            )
        return value

    @model_validator(mode="after")
    def _require_one_ingress(self) -> UserIngress:
        if not (self.app or self.handler):
            raise ValueError(
                "user_ingress must declare `app` (ADR-0021, preferred) or `handler` "
                "(legacy ADR-0018)."
            )
        return self


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


def parse_user_frontend_from_manifest(manifest: dict[str, Any]) -> UserFrontend | None:
    """The manifest's ``user_frontend`` declaration, or ``None`` if absent."""
    raw = manifest.get("user_frontend")
    return None if raw is None else UserFrontend(**raw)
