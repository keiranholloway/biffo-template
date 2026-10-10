"""New DDL modules are unnumbered: their position is derived at build (biffo-template#2458).

A module is authored as `db/imports/<name>/<slug>.sql`. `api.ddl_order` derives its
apply position from the merged default branch, so nobody picks a number and two open
PRs that each add a module cannot collide. A hand-picked number reintroduces exactly
that race (tabsii-platform 1577/1579, 2026-10-09: two modules numbered 221 three
seconds apart), so a change that adds a numbered file to an existing import fails here.

Exempt, because nobody in this repo picks those numbers:

- **A new import**, absent at the merge base: `biffo data import` vendors an existing
  numbered chain in one commit.
- **A vendored plugin seed** (`_plugin-<name>/`): `biffo plugin install` replaces it
  wholesale from the plugin repo, whose own numbering it carries.

Like `test_ddl_import_immutability.py`, a repo with `db/imports/` whose base branch
cannot be established FAILS rather than skips: a guard that cannot run is not passing.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from api.ddl_order import DEFAULT_BRANCH_REF, new_numbered_modules

# services/api/tests/ -> services/api -> services -> <repo root>
REPO_ROOT = Path(__file__).resolve().parents[3]
IMPORTS_ROOT = REPO_ROOT / "db" / "imports"
PLUGIN_SEED_PREFIX = "_plugin-"


def _git(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603 -- fixed git argv, no shell
        ["git", *args],  # noqa: S607  # nosec B603,B607
        cwd=cwd,
        capture_output=True,
        text=True,
        check=False,
    )


def _git_ok(cwd: Path, *args: str) -> str:
    result = _git(cwd, *args)
    assert result.returncode == 0, f"git {args} failed: {result.stderr}"
    return result.stdout


def _authored_import_dirs() -> list[Path]:
    if not IMPORTS_ROOT.is_dir():
        return []
    return [
        d
        for d in sorted(IMPORTS_ROOT.iterdir())
        if d.is_dir() and not d.name.startswith(PLUGIN_SEED_PREFIX)
    ]


class TestNoNewNumberedModules:
    def test_no_change_adds_a_numbered_module_to_an_existing_import(self) -> None:
        dirs = _authored_import_dirs()
        if not dirs:
            pytest.skip("no authored db/imports/<name>/ in this repo")
        found: dict[str, list[str]] = {}
        for import_dir in dirs:
            added = new_numbered_modules(import_dir)
            assert added is not None, (
                f"Cannot tell which modules this change adds to {import_dir.name}: "
                f"{DEFAULT_BRANCH_REF} does not resolve, or the clone is shallow. "
                "It is NOT passing. In CI, add `fetch-depth: 0` to the job's checkout."
            )
            if added:
                found[import_dir.name] = added
        assert not found, (
            "New DDL modules must not carry a sequence number; their position is "
            "derived when the import is provisioned (biffo-template#2458). Rename:\n  "
            + "\n  ".join(f"{name}/{f}" for name, files in found.items() for f in files)
            + "\n\nto `<slug>.sql` (no leading digits), e.g. `221_unit_formats.sql` -> "
            "`unit_formats.sql`."
        )


class TestNewNumberedModules:
    """`new_numbered_modules` against a controlled history: a repo under `tmp_path`
    whose `origin/dev` is a local ref, so the merge base is real."""

    @pytest.fixture
    def repo(self, tmp_path: Path) -> Path:
        _git_ok(tmp_path, "init", "-q", "-b", "dev")
        _git_ok(tmp_path, "config", "user.email", "ddl-order-test@example.invalid")
        _git_ok(tmp_path, "config", "user.name", "DDL Order Test")
        _git_ok(tmp_path, "config", "commit.gpgsign", "false")
        widgets = tmp_path / "db" / "imports" / "widgets"
        widgets.mkdir(parents=True)
        (widgets / "000_schema.sql").write_text("SELECT 0;\n")
        (widgets / "001_tables.sql").write_text("SELECT 1;\n")
        _git_ok(tmp_path, "add", "-A")
        _git_ok(tmp_path, "commit", "-q", "-m", "base")
        _git_ok(tmp_path, "update-ref", "refs/remotes/origin/dev", "HEAD")
        _git_ok(tmp_path, "checkout", "-q", "-b", "feature")
        return tmp_path

    def _commit(self, repo: Path, relpath: str) -> None:
        path = repo / relpath
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("SELECT 1;\n")
        _git_ok(repo, "add", "-A")
        _git_ok(repo, "commit", "-q", "-m", f"add {relpath}")

    def test_a_numbered_module_added_to_an_existing_import_is_reported(self, repo: Path) -> None:
        self._commit(repo, "db/imports/widgets/002_more.sql")
        assert new_numbered_modules(repo / "db/imports/widgets") == ["002_more.sql"]

    def test_an_unnumbered_module_is_not_reported(self, repo: Path) -> None:
        self._commit(repo, "db/imports/widgets/more_tables.sql")
        assert new_numbered_modules(repo / "db/imports/widgets") == []

    def test_existing_numbered_modules_are_not_reported(self, repo: Path) -> None:
        assert new_numbered_modules(repo / "db/imports/widgets") == []

    def test_a_new_import_may_bring_its_numbered_chain(self, repo: Path) -> None:
        self._commit(repo, "db/imports/gadgets/000_schema.sql")
        assert new_numbered_modules(repo / "db/imports/gadgets") == []

    def test_cannot_tell_without_the_base_ref(self, repo: Path) -> None:
        _git_ok(repo, "update-ref", "-d", "refs/remotes/origin/dev")
        assert new_numbered_modules(repo / "db/imports/widgets") is None

    def test_cannot_tell_outside_a_git_repo(self, tmp_path: Path) -> None:
        (tmp_path / "widgets").mkdir()
        (tmp_path / "widgets" / "002_more.sql").write_text("SELECT 1;\n")
        assert new_numbered_modules(tmp_path / "widgets") is None
