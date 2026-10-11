from __future__ import annotations

import re
from typing import Any

import pytest
from api import domain_storage, plugin_storage
from botocore.exceptions import ClientError


class FakeS3:
    def __init__(self) -> None:
        self.post: dict[str, Any] = {}
        self.url: dict[str, Any] = {}
        self.deleted: list[dict[str, Any]] = []
        self.head_result: Any = {"ContentLength": 7, "ContentType": "text/plain"}

    def generate_presigned_post(self, **kw: Any) -> dict[str, Any]:
        self.post = kw
        return {"url": "https://s3.example/b", "fields": {"key": kw["Key"]}}

    def generate_presigned_url(self, op: str, **kw: Any) -> str:
        self.url = {"op": op, **kw}
        return "https://s3.example/get"

    def head_object(self, **kw: Any) -> dict[str, Any]:
        if isinstance(self.head_result, Exception):
            raise self.head_result
        return self.head_result

    def delete_object(self, **kw: Any) -> dict[str, Any]:
        self.deleted.append(kw)
        return {}


@pytest.fixture
def s3(monkeypatch: pytest.MonkeyPatch) -> FakeS3:
    fake = FakeS3()
    monkeypatch.setattr(plugin_storage, "_client", fake)
    monkeypatch.setattr(plugin_storage.settings, "plugin_media_bucket", "bkt")
    return fake


_ARGS = {"domain": "user_profile", "tenant_id": "t1", "owner_id": "u1"}


def test_key_layout() -> None:
    key = domain_storage.build_key(**_ARGS, filename="My CV (1).pdf")
    assert re.fullmatch(r"domains/user_profile/t1/u1/[0-9a-f-]{36}/My_CV__1_.pdf", key), key


def test_key_is_unique_per_call() -> None:
    assert domain_storage.build_key(**_ARGS, filename="a") != domain_storage.build_key(
        **_ARGS, filename="a"
    )


@pytest.mark.parametrize("field", ["domain", "tenant_id", "owner_id"])
@pytest.mark.parametrize("bad", ["", "a/b", ".."])
def test_bad_segments_rejected(field: str, bad: str) -> None:
    with pytest.raises(ValueError):
        domain_storage.build_key(**{**_ARGS, field: bad}, filename="x")


def test_presign_upload_conditions(s3: FakeS3) -> None:
    up = domain_storage.presign_upload(
        **_ARGS, filename="a.pdf", content_type="application/pdf", max_bytes=100
    )
    assert s3.post["Bucket"] == "bkt"
    assert s3.post["Key"] == up.key
    conds = s3.post["Conditions"]
    assert {"Content-Type": "application/pdf"} in conds
    assert ["content-length-range", 1, 100] in conds
    assert ["starts-with", "$key", "domains/user_profile/t1/u1/"] in conds
    assert up.key.startswith("domains/user_profile/t1/u1/")


def test_head_found_and_missing(s3: FakeS3) -> None:
    obj = domain_storage.head("domains/x")
    assert obj is not None and obj.size_bytes == 7 and obj.mime_type == "text/plain"
    s3.head_result = ClientError({"Error": {"Code": "404"}}, "HeadObject")
    assert domain_storage.head("domains/x") is None


def test_presign_download(s3: FakeS3) -> None:
    url = domain_storage.presign_download("domains/a/b/c/d/file.pdf")
    assert url == "https://s3.example/get"
    assert s3.url["op"] == "get_object"
    assert s3.url["Params"]["Key"] == "domains/a/b/c/d/file.pdf"
    assert s3.url["Params"]["ResponseContentDisposition"] == 'attachment; filename="file.pdf"'


def test_delete(s3: FakeS3) -> None:
    domain_storage.delete("domains/a/b/c/d/file.pdf")
    assert s3.deleted == [{"Bucket": "bkt", "Key": "domains/a/b/c/d/file.pdf"}]
