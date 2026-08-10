"""Object storage for plugins (ADR-0021, biffo-template#1437).

The first S3 client in template Core, and deliberately the only one: a plugin
never holds AWS credentials or touches a bucket. It asks Core to mint a
presigned URL, the browser moves the bytes directly to S3, and Core verifies
afterwards what actually landed. Bytes never pass through a Lambda.

## The key layout, and why every segment is there

    plugins/<plugin>/<tenant_id>/<uuid4>/<filename>

``<plugin>`` comes from the caller's **verified** ``ServicePrincipal``, never
from the request body — the rule ``internal_plugin_config.py`` already states,
whose docstring names the threat: a caller-supplied name *"would let any
allowlisted service read another plugin's config."* Here the equivalent would
let one plugin read and overwrite another's media.

``<tenant_id>`` is ADR-0001, and it is what makes "delete everything for this
tenant" expressible later as a prefix operation rather than a table scan.

``<uuid4>`` means the key is **never derived from user input**. That is what
removes path traversal, collision and guessing in one move, and it matches every
presigning implementation in the estate — not one of them builds a key from a
filename.

The filename survives only as the last segment, sanitised, so a download has a
sensible name. It is decoration; the uuid is the identity.

## Why confirm reads the object

``head_object`` after upload, with ``mime_type`` and ``size_bytes`` taken from
what S3 actually holds. Without it a client can presign for a 25 MB image and
record whatever it likes, and a crashed upload leaves a row describing an object
that is not there.

The estate has both shapes and they disagree: ``lms_media`` reads
``ContentLength`` from ``head_object``; ``ops_evidence`` takes ``size_bytes``
from the request body and checks it against a ceiling it never verifies. This
follows ``lms_media``.

## What a presigned URL does NOT do

Generating one is a **local signing operation that never contacts S3**, so it
cannot fail on a permission Core does not hold. The URL is well-formed, the
endpoint returns 200, and the browser gets AccessDenied. tabsii-platform shipped
three green milestones into that hole; see ``plugin-storage.core.tf`` and the
prefix-grant test for the guard.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

import boto3
from botocore.exceptions import ClientError

from .config import settings

#: The one prefix this capability owns. The IAM grant in
#: `plugin-storage.core.tf` names `plugins/*`, and
#: `tests/test_plugin_storage_prefix_grant.py` asserts the two agree — because
#: nothing else can. Presigning never contacts S3, so a mismatch is invisible
#: until a browser tries to use the URL.
KEY_ROOT = "plugins"

#: Upload window. Long enough for a person to choose a file and for the PUT to
#: run on a poor connection; short enough that a leaked policy is not a standing
#: write grant. The estate uses 300s for documents and 900s for large media.
UPLOAD_EXPIRY_SECONDS = 900

#: Download window. Deliberately shorter: a GET URL is bearer-ish, so anyone
#: holding it can fetch until it expires. Callers that need a URL to outlive
#: this should ask for another one, not hold this longer.
DOWNLOAD_EXPIRY_SECONDS = 300

#: Ceiling on what a plugin may declare, whatever its manifest says. A plugin
#: asking for 5 GB should be refused by the platform rather than trusted; this
#: is the platform's opinion, not the plugin's.
MAX_DECLARABLE_BYTES = 512 * 1024 * 1024

#: Default when a manifest declares no limit. Comfortable for stills, small
#: enough that an unconfigured plugin cannot accidentally accept video.
DEFAULT_MAX_BYTES = 25 * 1024 * 1024

_FILENAME_SAFE = re.compile(r"[^A-Za-z0-9._-]")
#: Runs of dots collapse to one. `..` cannot traverse here — separators are
#: already gone by this point and the segment is the last in the key — but
#: leaving it costs nothing to remove and removes a class of surprise for
#: whatever downstream code eventually splits this string on something we did
#: not anticipate. `file.tar.gz` is unaffected: its dots are not adjacent.
_DOT_RUN = re.compile(r"\.{2,}")
_client: Any = None


class ObjectStorageUnavailableError(RuntimeError):
    """No bucket is configured for this environment.

    A distinct error rather than a generic failure because the two causes need
    different responses: an unconfigured environment is an operator problem, a
    rejected upload is a caller problem.
    """


def _s3() -> Any:
    """Lazily-built S3 client, memoised for the life of the Lambda container.

    Lazy for the same reason `chat_engine` builds its Lambda client lazily:
    import time runs on every cold start including for requests that never touch
    S3, and a client constructed there is latency nobody asked for.
    """
    global _client
    if _client is None:
        _client = boto3.client("s3")
    return _client


def _bucket() -> str:
    bucket = (settings.plugin_media_bucket or "").strip()
    if not bucket:
        raise ObjectStorageUnavailableError(
            "Object storage is not configured for this environment "
            "(BIFFO_PLUGIN_MEDIA_BUCKET is unset)."
        )
    return bucket


def sanitise_filename(name: str) -> str:
    """Reduce a filename to something safe to place in a key and a header.

    The key's identity is its uuid, so this may be lossy without consequence —
    which is exactly why it can afford to be strict. Anything outside a
    conservative allowlist becomes an underscore, runs of dots collapse to one
    (so ``..`` cannot survive), leading and trailing dots and underscores go (no
    ``.htaccess``, no hidden files), and the result is truncated.

    Returns ``"file"`` when nothing usable survives, rather than an empty last
    segment — a key ending in ``/`` is a prefix, not an object, and S3 will
    happily create one that nothing can then fetch.
    """
    cleaned = _DOT_RUN.sub(".", _FILENAME_SAFE.sub("_", name.strip())).strip("._")
    return cleaned[:120] or "file"


def build_key(*, plugin: str, tenant_id: str, filename: str) -> str:
    """The full object key. See the module docstring for why each segment exists."""
    return f"{KEY_ROOT}/{plugin}/{tenant_id}/{uuid4()}/{sanitise_filename(filename)}"


@dataclass(frozen=True)
class PresignedUpload:
    key: str
    url: str
    fields: dict[str, str]


def presign_upload(
    *, plugin: str, tenant_id: str, filename: str, content_type: str, max_bytes: int
) -> PresignedUpload:
    """Mint a presigned POST the browser can upload to directly.

    The conditions are the enforcement, and they are enforced by **S3** rather
    than by us — which is the point. A caller that ignores them does not get a
    lenient upload, it gets a rejected one.

    ``content-length-range`` starts at 1, not 0: a zero-byte upload satisfies
    every other check and produces an object that is not a file.
    """
    key = build_key(plugin=plugin, tenant_id=tenant_id, filename=filename)
    presigned = _s3().generate_presigned_post(
        Bucket=_bucket(),
        Key=key,
        Fields={"Content-Type": content_type},
        Conditions=[
            {"Content-Type": content_type},
            ["content-length-range", 1, max_bytes],
            # Belt and braces against a tampered policy: even holding this
            # signature, the caller cannot write outside its own plugin.
            ["starts-with", "$key", f"{KEY_ROOT}/{plugin}/{tenant_id}/"],
        ],
        ExpiresIn=UPLOAD_EXPIRY_SECONDS,
    )
    return PresignedUpload(key=key, url=presigned["url"], fields=presigned["fields"])


@dataclass(frozen=True)
class StoredObject:
    key: str
    size_bytes: int
    mime_type: str


def head(key: str) -> StoredObject | None:
    """What S3 actually holds at ``key``, or ``None`` if there is nothing there.

    ``None`` rather than an exception for the not-found case, because "the
    client never completed the upload" is an ordinary outcome of an optimistic
    flow, not an error condition. Any other ``ClientError`` propagates — a 403
    here means the IAM grant is wrong, and swallowing it would turn a
    misconfiguration into an indistinguishable "not uploaded".
    """
    try:
        meta = _s3().head_object(Bucket=_bucket(), Key=key)
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in {"404", "NoSuchKey", "NotFound"}:
            return None
        raise
    return StoredObject(
        key=key,
        size_bytes=int(meta["ContentLength"]),
        # Falls back rather than raising: S3 records what the uploader declared,
        # and an object with no recorded type is odd but not a failure.
        mime_type=str(meta.get("ContentType") or "application/octet-stream"),
    )


def presign_download(key: str, *, filename: str | None = None) -> str:
    """A short-lived GET URL for one object.

    ``response-content-disposition`` is set from the stored filename so a
    download arrives named sensibly rather than as a uuid.
    """
    params: dict[str, Any] = {"Bucket": _bucket(), "Key": key}
    if filename:
        params["ResponseContentDisposition"] = (
            f'attachment; filename="{sanitise_filename(filename)}"'
        )
    return str(
        _s3().generate_presigned_url("get_object", Params=params, ExpiresIn=DOWNLOAD_EXPIRY_SECONDS)
    )


def resolve_max_bytes(declared: int | None) -> int:
    """The effective ceiling for a plugin, clamped to the platform's own.

    A plugin declaring nothing gets the conservative default; one declaring more
    than the platform allows is clamped rather than refused, because the
    alternative is an install-time failure for a value the operator can do
    nothing about at that moment.
    """
    if declared is None or declared <= 0:
        return DEFAULT_MAX_BYTES
    return min(declared, MAX_DECLARABLE_BYTES)
