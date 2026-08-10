"""Plugin object storage — the internal presign/confirm/serve surface (#1437).

The S3 client is stubbed here, as it is in every lane. That is a real limit and
worth naming: **no test in this file executes a real S3 call**, which is exactly
why `test_plugin_storage_prefix_grant.py` exists alongside it — the IAM half
cannot be reached from Python at all.

What these do cover is the half that IS reachable: that one plugin cannot touch
another's objects, that confirm believes S3 rather than the caller, and that a
retried confirm does not double-count.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Generator
from typing import Any

import pytest
from api import plugin_storage
from api.database import get_db
from api.middleware.service_auth import ServicePrincipal, require_service_principal
from api.models.base import Base
from api.models.plugin_media import PluginMedia  # noqa: F401 — registers the table
from api.routers import internal_plugin_storage
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

_BASE = "/api/v1/internal/plugins/me/storage"

_MARKETING = ServicePrincipal(
    principal_arn="arn:aws:sts::123456789012:assumed-role/test-host-role/session",
    asserted_plugin="marketing",
)
_SCOUT = ServicePrincipal(
    principal_arn="arn:aws:sts::123456789012:assumed-role/biffo-dev-plugin-scout-role/s"
)


class FakeS3:
    """Stands in for boto3's client. Records calls; returns what S3 would.

    A fake rather than a mock so the tests read as behaviour ("what does S3
    hold") instead of call assertions, matching the estate's house style.
    """

    def __init__(self) -> None:
        self.objects: dict[str, tuple[int, str]] = {}
        self.presigned_posts: list[dict[str, Any]] = []
        self.presigned_gets: list[dict[str, Any]] = []

    def generate_presigned_post(self, **kwargs: Any) -> dict[str, Any]:
        self.presigned_posts.append(kwargs)
        return {"url": "https://s3.example/bucket", "fields": {"key": kwargs["Key"]}}

    def head_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:  # noqa: N803
        if Key not in self.objects:
            from botocore.exceptions import ClientError

            raise ClientError({"Error": {"Code": "404"}}, "HeadObject")
        size, ctype = self.objects[Key]
        return {"ContentLength": size, "ContentType": ctype}

    def generate_presigned_url(self, op: str, **kwargs: Any) -> str:
        self.presigned_gets.append(kwargs)
        return "https://s3.example/signed-get"


@pytest.fixture
def ctx(monkeypatch: pytest.MonkeyPatch) -> Generator[dict]:
    fake = FakeS3()
    monkeypatch.setattr(plugin_storage, "_s3", lambda: fake)
    monkeypatch.setattr(plugin_storage.settings, "plugin_media_bucket", "test-bucket")

    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )

    async def _create() -> None:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    asyncio.run(_create())
    sessions = async_sessionmaker(engine, expire_on_commit=False)

    async def override_get_db() -> AsyncGenerator[AsyncSession]:
        async with sessions() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app = FastAPI()
    app.include_router(internal_plugin_storage.router, prefix="/api/v1")
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[require_service_principal] = lambda: _MARKETING

    yield {"app": app, "client": TestClient(app), "s3": fake}
    asyncio.run(engine.dispose())


def _presign(client: TestClient, **over: Any) -> dict[str, Any]:
    body = {"filename": "hero.png", "content_type": "image/png"}
    body.update(over)
    resp = client.post(f"{_BASE}/presign", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


# --- key construction -----------------------------------------------------


def test_the_key_is_scoped_to_plugin_and_tenant(ctx):
    key = _presign(ctx["client"])["key"]
    assert key.startswith("plugins/marketing/default/")


def test_the_key_is_never_derived_from_the_filename(ctx):
    """A caller-supplied name must not reach the key's identity.

    Traversal, collision and guessing all follow from a key built out of user
    input; a server-generated uuid removes all three at once.
    """
    key = _presign(ctx["client"], filename="../../../etc/passwd")["key"]
    assert ".." not in key
    assert key.startswith("plugins/marketing/default/")
    # The name survives only as decoration on the last segment, sanitised.
    assert key.rsplit("/", 1)[-1] == "etc_passwd"


def test_two_uploads_of_the_same_filename_do_not_collide(ctx):
    a = _presign(ctx["client"])["key"]
    b = _presign(ctx["client"])["key"]
    assert a != b


def test_a_leading_dot_cannot_produce_a_hidden_file(ctx):
    key = _presign(ctx["client"], filename=".htaccess")["key"]
    assert key.rsplit("/", 1)[-1] == "htaccess"


# --- presign conditions ---------------------------------------------------


def test_the_presign_conditions_bound_size_and_type(ctx):
    """The conditions are the enforcement, and S3 applies them, not us."""
    _presign(ctx["client"])
    conditions = ctx["s3"].presigned_posts[0]["Conditions"]
    assert {"Content-Type": "image/png"} in conditions
    assert ["content-length-range", 1, plugin_storage.DEFAULT_MAX_BYTES] in conditions


def test_a_zero_byte_upload_is_excluded_by_the_range(ctx):
    """Lower bound 1, not 0.

    A zero-byte object satisfies every other check and is not a file; excluding
    it at the condition means S3 refuses it rather than us discovering it later.
    """
    _presign(ctx["client"])
    conditions = ctx["s3"].presigned_posts[0]["Conditions"]
    ranges = [c for c in conditions if isinstance(c, list) and c[0] == "content-length-range"]
    assert ranges and ranges[0][1] == 1


def test_the_policy_pins_the_key_prefix(ctx):
    """Belt and braces: even holding the signature, a caller cannot write out."""
    _presign(ctx["client"])
    conditions = ctx["s3"].presigned_posts[0]["Conditions"]
    assert ["starts-with", "$key", "plugins/marketing/default/"] in conditions


def test_presign_writes_no_row(ctx):
    """A presign is an offer, not a fact.

    Recording it would describe an object that may never exist — and would make
    any storage total include uploads that never happened.
    """
    _presign(ctx["client"])
    assert ctx["client"].get(_BASE).json() == []


# --- confirm --------------------------------------------------------------


def test_confirm_reads_size_and_type_from_s3(ctx):
    """Not from the caller. This is the ops_evidence trap, avoided deliberately.

    A client able to declare these could presign for a 25 MB image and record
    whatever it liked, and any figure built on them would be fiction.
    """
    key = _presign(ctx["client"])["key"]
    ctx["s3"].objects[key] = (4096, "image/png")

    resp = ctx["client"].post(f"{_BASE}/confirm", json={"key": key})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["size_bytes"] == 4096
    assert body["mime_type"] == "image/png"
    assert body["owner_plugin"] == "system:marketing"


def test_confirming_an_object_that_never_landed_is_404(ctx):
    """The ordinary outcome of an abandoned upload, not an error."""
    key = _presign(ctx["client"])["key"]
    assert ctx["client"].post(f"{_BASE}/confirm", json={"key": key}).status_code == 404


def test_confirm_is_idempotent(ctx):
    """A retried confirm must not create a second row.

    A client that times out and retries is normal; two rows for one object would
    make every per-plugin storage total double-count it.
    """
    key = _presign(ctx["client"])["key"]
    ctx["s3"].objects[key] = (10, "image/png")

    first = ctx["client"].post(f"{_BASE}/confirm", json={"key": key}).json()
    second = ctx["client"].post(f"{_BASE}/confirm", json={"key": key}).json()
    assert first["id"] == second["id"]
    assert len(ctx["client"].get(_BASE).json()) == 1


def test_a_plugin_cannot_confirm_another_plugins_key(ctx):
    """Otherwise confirm becomes a read grant on somebody else's files.

    The caller never wrote this object and could not have — but without the
    prefix check it would gain a record of it, and with it a URL.
    """
    foreign = "plugins/idea-scout/default/abc/secret.png"
    ctx["s3"].objects[foreign] = (10, "image/png")
    resp = ctx["client"].post(f"{_BASE}/confirm", json={"key": foreign})
    assert resp.status_code == 403
    assert ctx["client"].get(_BASE).json() == []


def test_a_plugin_cannot_confirm_another_tenants_key(ctx):
    foreign = "plugins/marketing/other-tenant/abc/secret.png"
    ctx["s3"].objects[foreign] = (10, "image/png")
    assert ctx["client"].post(f"{_BASE}/confirm", json={"key": foreign}).status_code == 403


# --- serving and listing --------------------------------------------------


def test_a_url_is_minted_per_request_not_stored(ctx):
    key = _presign(ctx["client"])["key"]
    ctx["s3"].objects[key] = (10, "image/png")
    media_id = ctx["client"].post(f"{_BASE}/confirm", json={"key": key}).json()["id"]

    resp = ctx["client"].get(f"{_BASE}/{media_id}/url")
    assert resp.status_code == 200, resp.text
    assert resp.json()["url"] == "https://s3.example/signed-get"
    assert resp.json()["expires_in"] == plugin_storage.DOWNLOAD_EXPIRY_SECONDS
    # The stored record holds a key, never a URL — a stored URL is stale the
    # moment it is written.
    assert "url" not in ctx["client"].get(_BASE).json()[0]


def test_another_plugin_gets_404_for_an_id_it_does_not_own(ctx):
    """404, not 403 — deliberately.

    Distinguishing "exists but not yours" from "does not exist" confirms
    existence to a caller with no right to know it.
    """
    key = _presign(ctx["client"])["key"]
    ctx["s3"].objects[key] = (10, "image/png")
    media_id = ctx["client"].post(f"{_BASE}/confirm", json={"key": key}).json()["id"]

    ctx["app"].dependency_overrides[require_service_principal] = lambda: _SCOUT
    assert ctx["client"].get(f"{_BASE}/{media_id}/url").status_code == 404


def test_the_list_shows_only_the_callers_own_media(ctx):
    key = _presign(ctx["client"])["key"]
    ctx["s3"].objects[key] = (10, "image/png")
    ctx["client"].post(f"{_BASE}/confirm", json={"key": key})

    ctx["app"].dependency_overrides[require_service_principal] = lambda: _SCOUT
    assert ctx["client"].get(_BASE).json() == []


# --- unconfigured environment --------------------------------------------


def test_an_unconfigured_environment_is_503_not_500(monkeypatch, ctx):
    """A deployment nobody wired is an operator problem, not a request bug.

    503 says so; 500 sends someone reading tracebacks for a missing env var.
    """
    monkeypatch.setattr(plugin_storage.settings, "plugin_media_bucket", "")
    resp = ctx["client"].post(
        f"{_BASE}/presign", json={"filename": "a.png", "content_type": "image/png"}
    )
    assert resp.status_code == 503


# --- limits ---------------------------------------------------------------


def test_a_plugin_cannot_declare_more_than_the_platform_allows(ctx):
    """The platform's opinion beats the plugin's."""
    assert plugin_storage.resolve_max_bytes(10**12) == plugin_storage.MAX_DECLARABLE_BYTES
    assert plugin_storage.resolve_max_bytes(None) == plugin_storage.DEFAULT_MAX_BYTES
    assert plugin_storage.resolve_max_bytes(0) == plugin_storage.DEFAULT_MAX_BYTES
    assert plugin_storage.resolve_max_bytes(1024) == 1024
