"""``presign_download`` must always set Content-Disposition (tabsii-platform#902).

``plugin_storage.presign_download`` used to set
``response-content-disposition`` **conditionally** on a truthy ``filename``:
when a caller omitted it (or passed ``""``), the header was silently left off
the presigned URL. That is a ``class:fail-open`` shape — the code cannot do
its job (name the download) and proceeds as though it had, with no error and
no log.

The consequence is not cosmetic. `biffo-plugin-marketing` relies on this
header for every creative download (its own #117/#122): browsers only
download a same-origin `Content-Disposition: attachment` response; a
cross-origin S3 response with no such header **navigates** instead, so the
tab shows raw bytes or an XML error page rather than triggering a save.

This file pins the previously-silent path: no header at all is no longer a
reachable outcome. A test asserting only "the header is present when
filename is given" would be worth little, because that was never the
defect — the absent case was. So every test below either omits ``filename``
or passes something falsy.
"""

from __future__ import annotations

from typing import Any

import pytest
from api import plugin_storage


class _FakeS3:
    """Records the kwargs `generate_presigned_url` was called with.

    Same shape as `test_internal_plugin_storage.py`'s `FakeS3` fake, kept
    separate and minimal here because this file only exercises
    `presign_download`, never upload or confirm.
    """

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def generate_presigned_url(self, _op: str, **kwargs: Any) -> str:
        self.calls.append(kwargs)
        return "https://s3.example/signed-get"


@pytest.fixture
def fake_s3(monkeypatch: pytest.MonkeyPatch) -> _FakeS3:
    fake = _FakeS3()
    monkeypatch.setattr(plugin_storage, "_s3", lambda: fake)
    monkeypatch.setattr(plugin_storage.settings, "plugin_media_bucket", "test-bucket")
    return fake


def _disposition(fake_s3: _FakeS3) -> str | None:
    assert len(fake_s3.calls) == 1, fake_s3.calls
    return fake_s3.calls[0]["Params"].get("ResponseContentDisposition")


# --- the defect: filename omitted entirely -------------------------------


def test_no_filename_argument_still_sets_the_header(fake_s3: _FakeS3) -> None:
    """The exact call shape that used to produce no header at all.

    Before the fix, `presign_download(key)` with no `filename` kwarg left
    `ResponseContentDisposition` out of `Params` entirely — the presigned URL
    was well-formed, S3 returned 200, and a cross-origin browser navigated to
    the raw object instead of downloading it. Silent, no error, no log.
    """
    plugin_storage.presign_download("plugins/marketing/default/abc-123/report.pdf")

    disposition = _disposition(fake_s3)
    assert disposition is not None, (
        "No Content-Disposition header was set at all — this is the exact "
        "fail-open shape #902 reports: a cross-origin presigned URL with no "
        "filename navigates instead of downloading."
    )
    assert disposition.startswith("attachment;")


def test_falsy_filename_still_sets_the_header(fake_s3: _FakeS3) -> None:
    """`filename=""` is falsy in Python, same failure mode as omitting it."""
    plugin_storage.presign_download("plugins/marketing/default/abc-123/report.pdf", filename="")

    disposition = _disposition(fake_s3)
    assert disposition is not None
    assert disposition.startswith("attachment;")


def test_none_filename_still_sets_the_header(fake_s3: _FakeS3) -> None:
    plugin_storage.presign_download("plugins/marketing/default/abc-123/report.pdf", filename=None)

    disposition = _disposition(fake_s3)
    assert disposition is not None
    assert disposition.startswith("attachment;")


# --- the fallback name, when no filename is supplied ----------------------


def test_absent_filename_falls_back_to_the_keys_last_segment(fake_s3: _FakeS3) -> None:
    """No filename supplied derives a name from the key rather than omitting it.

    `build_key` always writes the sanitised filename as the key's last
    segment, so recovering it from the key reconstructs the real name for
    every object this module itself creates — it is not a bare uuid.
    """
    plugin_storage.presign_download(
        "plugins/marketing/default/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/report.pdf"
    )

    disposition = _disposition(fake_s3)
    assert disposition == 'attachment; filename="report.pdf"'


# --- the given filename still wins, and is still sanitised ----------------


def test_given_filename_is_still_used_and_sanitised(fake_s3: _FakeS3) -> None:
    plugin_storage.presign_download(
        "plugins/marketing/default/abc-123/whatever", filename="../evil .png"
    )

    disposition = _disposition(fake_s3)
    assert disposition == 'attachment; filename="evil_.png"'
