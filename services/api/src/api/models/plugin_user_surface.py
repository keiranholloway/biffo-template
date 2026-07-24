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

from pydantic import BaseModel, ConfigDict, Field, field_validator

# A single URL path segment: the plugin mounts its ingress under <plugin>/<path>/*,
# so the segment must not itself contain a slash or be empty.
_PATH_SEGMENT = re.compile(r"^[a-z][a-z0-9_-]*$")
# A dotted import path to the Lambda handler, e.g. "ideation.lambda.handler".
_HANDLER = re.compile(r"^[a-zA-Z_][\w]*(\.[a-zA-Z_][\w]*)+$")
# A repo-relative build directory, e.g. "web/dist". No absolute paths, no traversal.
_REL_DIR = re.compile(r"^[\w][\w./-]*$")


def _require_group(value: str) -> str:
    if not value.strip():
        raise ValueError("required_group must be a non-empty Cognito group name.")
    return value


class UserIngress(BaseModel):
    """The plugin's authenticated, group-gated Lambda ingress (ADR-0018 §1)."""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(
        default="api",
        description="Single path segment the ingress mounts under: reached at "
        "<base>/<plugin>/<path>/* on the shared CloudFront.",
    )
    required_group: str = Field(
        description="The Cognito group a caller must be in. Verified by the handler "
        "against the shared-Cognito JWT and enforced again by Core (ADR-0017 §3)."
    )
    handler: str = Field(
        description="Dotted import path to the plugin's Lambda handler, "
        "e.g. 'ideation.lambda.handler'. A declaration, resolved in the plugin's own "
        "runtime — never imported by Core (ADR-0002)."
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

    @field_validator("handler")
    @classmethod
    def _validate_handler(cls, value: str) -> str:
        if not _HANDLER.match(value):
            raise ValueError(
                f"user_ingress.handler {value!r} must be a dotted import path, "
                "e.g. 'ideation.lambda.handler'."
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


def parse_user_frontend_from_manifest(manifest: dict[str, Any]) -> UserFrontend | None:
    """The manifest's ``user_frontend`` declaration, or ``None`` if absent."""
    raw = manifest.get("user_frontend")
    return None if raw is None else UserFrontend(**raw)
