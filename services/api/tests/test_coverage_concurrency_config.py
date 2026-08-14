"""`[tool.coverage.run]` must trace greenlets and threads (#1588).

`services/api` is async throughout and reaches the database through
SQLAlchemy's async layer, which runs user code -- including exception
handlers -- inside a greenlet (`greenlet_spawn`). That greenlet itself runs on
a background thread whenever the test suite drives the app through FastAPI's/
Starlette's `TestClient` (an `anyio` blocking portal). Coverage.py traces
neither a greenlet context nor a non-main thread unless told to, so without
both `greenlet` and `thread` declared, a local `pytest --cov` run silently
under-records async DB code and disagrees with CI -- 60 unexecuted error
branches reported locally against CI's correctly-measured 47 at the commit
this was fixed, for no reason visible in the coverage.json itself.

`greenlet` alone is not a lesser-but-safe fallback: measured directly, it
under-counts *worse* than no concurrency setting at all (80 unexecuted, vs. 60
with nothing declared), because it never extends tracing into the background
thread TestClient runs on in the first place. Both values are required
together, so this pins both rather than merely asserting the key is present.

This is a config-drift guard, not a functional test: it would not catch a
regression through pytest's own coverage run (the wrong config produces a
number, just a silently wrong one), only through someone reading a diff that
removes or narrows the setting.
"""

from __future__ import annotations

import tomllib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
PYPROJECT = REPO_ROOT / "pyproject.toml"


def test_coverage_run_traces_both_greenlet_and_thread():
    data = tomllib.loads(PYPROJECT.read_text())
    concurrency = data["tool"]["coverage"]["run"]["concurrency"]
    assert set(concurrency) == {"greenlet", "thread"}, (
        "[tool.coverage.run].concurrency must declare both `greenlet` (async DB "
        "code runs inside a greenlet) and `thread` (TestClient runs the app on "
        "a background thread) -- either alone under-records async coverage "
        "relative to CI (#1588)."
    )
