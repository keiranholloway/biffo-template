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


def _bake(version: str) -> None:
    """Write the generated module as packaging would, and defeat the bytecode cache.

    Clearing `sys.modules` is not enough, and finding that out was instructive: two
    of these tests wrote `CORE_VERSION = "9.9.9"` and `CORE_VERSION = "1.2.3"` —
    **identical byte length** — within the same second. Python validates a cached
    `.pyc` on (mtime, size), both matched, so the stale bytecode was reused and the
    second test read the first's value.

    That is the same timestamp-invalidation trap #724 is about: zip/unzip rewrites
    mtimes, which is why precompiling a Lambda package needs
    `--invalidation-mode unchecked-hash`. Here the fix is simply to delete the
    cached bytecode along with the module.
    """
    GENERATED.write_text(f'CORE_VERSION = "{version}"\n')
    sys.modules.pop("api._core_version", None)
    for stale in (GENERATED.parent / "__pycache__").glob("_core_version.*"):
        stale.unlink()


def _unbake() -> None:
    GENERATED.unlink(missing_ok=True)
    sys.modules.pop("api._core_version", None)
    for stale in (GENERATED.parent / "__pycache__").glob("_core_version.*"):
        stale.unlink()


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
    _bake("9.9.9")
    try:
        assert core_version() == "9.9.9"
        assert client.get("/api/v1/health").json()["version"] == "9.9.9"
    finally:
        _unbake()


def test_the_resolver_and_the_runtime_agree(tmp_path: Path):
    """The script and the runtime must mean the same thing about the same checkout.

    Two halves written at different times in different languages, that only work if
    they agree. Asserting the script's output alone would prove nothing about what
    `/health` reports.

    Hermetic on purpose. The first version of this test ran the resolver against
    whatever checkout it happened to land in and asserted exit 0 — which **failed in
    CI**, because `ci.yml`'s Python job fetches no tags, so the template's `core-v*`
    path had nothing to read. That was environment coupling in the test, not a bug
    in the resolver: the resolver failing loudly with no version available is
    exactly its designed behaviour.

    (Worth noting: `ci.yml` already carries a comment about that trap and three of
    its four jobs set `fetch-tags`/`fetch-depth: 0`. The test job does not. Left
    alone here — this test no longer needs tags, and widening the fix is a separate
    change.)

    So the agreement is exercised through the `biffo.core.json` path, which needs no
    git state at all.
    """
    (tmp_path / "biffo.core.json").write_text('{"version": "1.2.3"}\n')
    result = subprocess.run(  # noqa: S603
        ["/bin/sh", str(REPO_ROOT / "scripts" / "resolve-core-version.sh"), "--quiet"],
        capture_output=True,
        text=True,
        cwd=tmp_path,
        check=False,
    )
    assert result.returncode == 0, f"resolver failed on an instance fixture: {result.stderr}"
    resolved = result.stdout.strip()
    assert resolved == "1.2.3", "resolver must read biffo.core.json, the ADR-0006 authority"

    # And the runtime reads back exactly what the resolver would have baked.
    _bake(resolved)
    try:
        assert core_version() == resolved
    finally:
        _unbake()


def test_the_resolver_refuses_a_checkout_with_no_version_source(tmp_path: Path):
    """No authority and no tags must exit non-zero, not emit something plausible.

    This is the property that makes build-time resolution worth anything: a
    deployment that cannot say what version it is should fail the build, not ship
    and report `unknown`. It is also the case CI accidentally exercised.
    """
    result = subprocess.run(  # noqa: S603
        ["/bin/sh", str(REPO_ROOT / "scripts" / "resolve-core-version.sh"), "--quiet"],
        capture_output=True,
        text=True,
        cwd=tmp_path,
        check=False,
    )
    assert result.returncode != 0
    assert not result.stdout.strip(), "must emit no version when it cannot determine one"


def test_the_resolver_refuses_a_garbled_authority(tmp_path: Path):
    """A malformed biffo.core.json fails rather than falling back to a tag.

    #811 records what falling back cost: a garbled record resolved to a
    114-version-old fossil and was read as authoritative.
    """
    (tmp_path / "biffo.core.json").write_text('{"nope": true}\n')
    result = subprocess.run(  # noqa: S603
        ["/bin/sh", str(REPO_ROOT / "scripts" / "resolve-core-version.sh"), "--quiet"],
        capture_output=True,
        text=True,
        cwd=tmp_path,
        check=False,
    )
    assert result.returncode != 0
    assert not result.stdout.strip()
