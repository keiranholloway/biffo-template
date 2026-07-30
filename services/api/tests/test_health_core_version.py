"""`/health` reports the core version baked in at package time (#648).

The issue asked for a runtime walk up the filesystem looking for `core.version`.
Measured on 2026-07-30, that would have reported `0.41.17` for a deployment running
`0.181.0` — 140 releases behind, in the one endpoint whose job is saying what is
deployed — and #842 now deletes that file, after which the walk finds nothing.

So the version is resolved at BUILD time by `scripts/resolve-core-version.sh` and
written to `api/_core_version.py`, which is generated and git-ignored.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest
from api.core_version import UNKNOWN_CORE_VERSION, core_version
from api.routers.health import router as health_router
from fastapi import FastAPI
from fastapi.testclient import TestClient

REPO_ROOT = Path(__file__).resolve().parents[3]
GENERATED = REPO_ROOT / "services" / "api" / "src" / "api" / "_core_version.py"


@pytest.fixture
def client() -> TestClient:
    """A minimal app carrying only the health router.

    Deliberately not the full application: `/health` has no dependencies, and
    pulling in the DB-overridden app fixtures would make this test fail for
    reasons that have nothing to do with the version it is asserting. The prefix
    mirrors `main.py`'s mount so the asserted path is the real one.
    """
    app = FastAPI()
    app.include_router(health_router, prefix="/api/v1")
    return TestClient(app)


def test_a_checkout_reports_unknown_rather_than_raising():
    """No generated module in a working tree, and that is not a failure.

    A checkout has no deployed version to report. `/health` must never error
    (#648), so the absence reads as `unknown`.
    """
    assert not GENERATED.exists(), (
        f"{GENERATED} exists in the working tree. It is generated at package time "
        f"and git-ignored; a committed copy would report a stale version, which is "
        f"the defect #648's original mechanism would have shipped."
    )
    assert core_version() == UNKNOWN_CORE_VERSION


def test_health_returns_the_version_field_populated(client: TestClient):
    body = client.get("/api/v1/health").json()
    assert body["status"] == "ok"
    # Populated at all, which it was not before #648: the field defaulted to
    # "0.0.0" and was never set. "0.0.0" was worse than absent — a plausible
    # semver reads as a real answer rather than as no answer.
    assert body["version"] == UNKNOWN_CORE_VERSION
    assert body["version"] != "0.0.0"


def test_health_reports_the_baked_version_when_one_is_packaged(client: TestClient):
    """The property that matters, exercised the way packaging actually does it.

    Writes the generated module, re-imports, asserts the endpoint reports it, then
    removes it. Without this the suite only ever proves the `unknown` path — which
    is the half that already worked.
    """
    GENERATED.write_text('CORE_VERSION = "9.9.9"\n')
    try:
        # `core_version()` imports lazily, so a fresh call picks the new module up;
        # drop any negative cache from the earlier ImportError.
        sys.modules.pop("api._core_version", None)
        assert core_version() == "9.9.9"
        assert client.get("/api/v1/health").json()["version"] == "9.9.9"
    finally:
        GENERATED.unlink()
        sys.modules.pop("api._core_version", None)


def test_the_resolver_agrees_with_what_would_be_baked():
    """The script and the runtime must not disagree about the same checkout.

    Two halves written at different times, in different languages, that only work
    if they mean the same thing. Asserting the script's output alone would prove
    nothing about what `/health` reports.
    """
    # Absolute /bin/sh: ruff's S607 objects to a partial executable path, and it
    # has a point — a bare "sh" resolves against PATH, which a test should not
    # depend on.
    result = subprocess.run(  # noqa: S603
        ["/bin/sh", str(REPO_ROOT / "scripts" / "resolve-core-version.sh"), "--quiet"],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        check=False,
    )
    assert result.returncode == 0, f"resolver failed in this checkout: {result.stderr}"
    resolved = result.stdout.strip()
    assert resolved, "resolver exited 0 but emitted nothing"

    GENERATED.write_text(f'CORE_VERSION = "{resolved}"\n')
    try:
        sys.modules.pop("api._core_version", None)
        assert core_version() == resolved
    finally:
        GENERATED.unlink()
        sys.modules.pop("api._core_version", None)
