"""Every ``*_pg.py`` test that performs DDL must carry ``pytest.mark.serial``.

The parallel pg pass (``scripts/verify.sh``: ``-m 'not serial' -n auto``) shares
one database between workers. A file that issues DDL there races its siblings
("tuple concurrently updated" / "cache lookup failed"). Instances such as
tabsii-platform enforce this with a guard; this is the template's own copy so a
violation fails here first (biffo-template#703 class).

A file may opt out with a comment containing ``Deliberately NOT marked `serial```
when every DDL object lives in a uniquely named per-test schema.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

_TESTS = Path(__file__).parent

_DDL = re.compile(
    r"\b(CREATE|DROP|ALTER|TRUNCATE)\s+(SCHEMA|TABLE|INDEX|TYPE|EXTENSION)\b"
    r"|\bmetadata\.(create_all|drop_all)\b",
    re.IGNORECASE,
)
_SERIAL = re.compile(r"^\s*pytest\.mark\.serial\b|pytestmark\s*=\s*pytest\.mark\.serial\b", re.M)
_OPT_OUT = re.compile(r"Deliberately NOT marked `serial`")


def _code_lines(src: str) -> str:
    return "\n".join(line for line in src.splitlines() if not line.lstrip().startswith("#"))


def violation(name: str, src: str) -> str | None:
    """Return a message when ``src`` does DDL without the serial marker."""
    code = _code_lines(src)
    if not _DDL.search(code):
        return None
    if _SERIAL.search(code) or _OPT_OUT.search(src):
        return None
    return f"{name} performs DDL but is not marked `pytest.mark.serial`."


def _pg_files() -> list[Path]:
    return sorted(p for p in _TESTS.glob("*_pg.py") if p.name != Path(__file__).name)


@pytest.mark.parametrize("path", _pg_files(), ids=lambda p: p.name)
def test_a_pg_file_that_cannot_share_the_database_says_so(path: Path) -> None:
    msg = violation(path.name, path.read_text())
    assert msg is None, msg


_FIXTURE_UNMARKED = (
    "import pytest\n"
    "pytestmark = [pytest.mark.skipif(True, reason='x')]\n"
    "async def f(conn):\n"
    "    await conn.execute(text('CREATE SCHEMA s'))\n"
)


def test_guard_fails_on_ddl_without_the_marker() -> None:
    assert violation("fixture_pg.py", _FIXTURE_UNMARKED) is not None


def test_guard_passes_once_the_marker_is_added() -> None:
    marked = _FIXTURE_UNMARKED.replace(
        "[pytest.mark.skipif(True, reason='x')]",
        "[pytest.mark.skipif(True, reason='x'),\n    pytest.mark.serial]",
    )
    assert violation("fixture_pg.py", marked) is None


def test_guard_ignores_files_without_ddl() -> None:
    assert violation("fixture_pg.py", "def test_x():\n    assert True\n") is None
