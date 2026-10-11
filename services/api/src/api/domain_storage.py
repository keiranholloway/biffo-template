"""Object storage for user-owned Core product domains (biffo-platform#337).

A product domain (for example ``user_profile``) that holds user files uses this
module rather than ``plugin_storage``. It shares the same S3 client, bucket and
filename sanitiser, but keeps its own key root so the IAM grant for domains
(``domain-storage.core.tf``, ``domains/*``, Core API role only) is separate from
the plugin grant (``plugins/*``, Core and the plugin host).

## Key layout

    domains/<domain>/<tenant_id>/<owner_id>/<uuid4>/<filename>

``<domain>``, ``<tenant_id>`` and ``<owner_id>`` are supplied by the calling
domain from the verified token, never from a request body. ``<uuid4>`` means the
key is never derived from user input; the filename is sanitised decoration.
The presigned POST carries a ``starts-with`` condition on the owner prefix, so a
signed policy cannot be used to write under another owner.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from . import plugin_storage
from .plugin_storage import (
    DEFAULT_MAX_BYTES,
    DOWNLOAD_EXPIRY_SECONDS,
    UPLOAD_EXPIRY_SECONDS,
    ObjectStorageUnavailableError,
    PresignedUpload,
    StoredObject,
    sanitise_filename,
)

#: The one prefix this capability owns; `domain-storage.core.tf` grants `domains/*`
#: and `tests/test_domain_storage_prefix_grant.py` asserts the two agree.
KEY_ROOT = "domains"

__all__ = [
    "DEFAULT_MAX_BYTES",
    "DOWNLOAD_EXPIRY_SECONDS",
    "KEY_ROOT",
    "UPLOAD_EXPIRY_SECONDS",
    "ObjectStorageUnavailableError",
    "PresignedUpload",
    "StoredObject",
    "build_key",
    "delete",
    "head",
    "owner_prefix",
    "presign_download",
    "presign_upload",
]


def _segment(label: str, value: str) -> str:
    """Reject a key segment that is empty or could alter the key's structure."""
    if not value or "/" in value or value in {".", ".."}:
        raise ValueError(f"invalid {label} for object key: {value!r}")
    return value


def owner_prefix(*, domain: str, tenant_id: str, owner_id: str) -> str:
    """The prefix every object for one owner of one domain lives under."""
    return (
        f"{KEY_ROOT}/{_segment('domain', domain)}/"
        f"{_segment('tenant_id', tenant_id)}/{_segment('owner_id', owner_id)}/"
    )


def build_key(*, domain: str, tenant_id: str, owner_id: str, filename: str) -> str:
    """The full object key: owner prefix, a fresh uuid4, the sanitised filename."""
    prefix = owner_prefix(domain=domain, tenant_id=tenant_id, owner_id=owner_id)
    return f"{prefix}{uuid4()}/{sanitise_filename(filename)}"


def presign_upload(
    *,
    domain: str,
    tenant_id: str,
    owner_id: str,
    filename: str,
    content_type: str,
    max_bytes: int = DEFAULT_MAX_BYTES,
) -> PresignedUpload:
    """Mint a presigned POST. Size and type are enforced by S3, not by us."""
    prefix = owner_prefix(domain=domain, tenant_id=tenant_id, owner_id=owner_id)
    key = build_key(domain=domain, tenant_id=tenant_id, owner_id=owner_id, filename=filename)
    presigned = plugin_storage._s3().generate_presigned_post(
        Bucket=plugin_storage._bucket(),
        Key=key,
        Fields={"Content-Type": content_type},
        Conditions=[
            {"Content-Type": content_type},
            ["content-length-range", 1, max_bytes],
            ["starts-with", "$key", prefix],
        ],
        ExpiresIn=UPLOAD_EXPIRY_SECONDS,
    )
    return PresignedUpload(key=key, url=presigned["url"], fields=presigned["fields"])


def head(key: str) -> StoredObject | None:
    """What S3 actually holds at ``key``, or ``None`` if nothing is there."""
    return plugin_storage.head(key)


def presign_download(key: str, *, filename: str | None = None) -> str:
    """A short-lived GET URL; always sets an attachment Content-Disposition."""
    return plugin_storage.presign_download(key, filename=filename)


def delete(key: str) -> None:
    """Delete one object. S3 deletes are idempotent: a missing key is not an error."""
    client: Any = plugin_storage._s3()
    client.delete_object(Bucket=plugin_storage._bucket(), Key=key)
