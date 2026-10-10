"""Tests for api.ddl_import.discover_ddl_import_dirs / list_sql_files /
ddl_import_environment, and the derived apply order in api.ddl_order."""

import subprocess

import pytest
from api import ddl_order
from api.ddl_import import ddl_import_environment, discover_ddl_import_dirs, list_sql_files
from api.ddl_order import (
    MANIFEST_NAME,
    DdlOrderUnavailableError,
    derived_numbers,
    format_manifest,
    main,
    new_numbered_modules,
)


def _write_sql_file(root, import_name: str, filename: str, content: str = "SELECT 1;") -> None:
    import_dir = root / import_name
    import_dir.mkdir(parents=True, exist_ok=True)
    (import_dir / filename).write_text(content)


class TestDiscoverDdlImportDirs:
    def test_nonexistent_root_returns_empty_list(self, tmp_path):
        assert discover_ddl_import_dirs(tmp_path / "does-not-exist") == []

    def test_empty_root_returns_empty_list(self, tmp_path):
        assert discover_ddl_import_dirs(tmp_path) == []

    def test_finds_single_import_directory(self, tmp_path):
        _write_sql_file(tmp_path, "acme", "000_schema.sql")
        assert discover_ddl_import_dirs(tmp_path) == ["acme"]

    def test_finds_multiple_import_directories_sorted(self, tmp_path):
        _write_sql_file(tmp_path, "zeta", "000.sql")
        _write_sql_file(tmp_path, "alpha", "000.sql")
        assert discover_ddl_import_dirs(tmp_path) == ["alpha", "zeta"]

    def test_unreadable_directory_is_skipped(self, tmp_path, monkeypatch):
        _write_sql_file(tmp_path, "broken", "000.sql")
        _write_sql_file(tmp_path, "fine", "000.sql")
        real_glob = type(tmp_path).glob

        def glob(self, pattern):
            if self.name == "broken":
                raise PermissionError("denied")
            return real_glob(self, pattern)

        monkeypatch.setattr(type(tmp_path), "glob", glob)
        assert discover_ddl_import_dirs(tmp_path) == ["fine"]

    def test_directory_without_sql_files_is_ignored(self, tmp_path):
        empty_dir = tmp_path / "no-sql-here"
        empty_dir.mkdir()
        (empty_dir / "README.md").write_text("not sql")
        assert discover_ddl_import_dirs(tmp_path) == []

    def test_non_directory_entry_is_ignored(self, tmp_path):
        (tmp_path / "stray-file.sql").write_text("SELECT 1;")
        assert discover_ddl_import_dirs(tmp_path) == []


class TestListSqlFiles:
    def test_nonexistent_directory_returns_empty_list(self, tmp_path):
        assert list_sql_files(tmp_path / "does-not-exist") == []

    def test_lists_sql_files_sorted_by_name(self, tmp_path):
        _write_sql_file(tmp_path, "acme", "001_second.sql")
        _write_sql_file(tmp_path, "acme", "000_first.sql")
        _write_sql_file(tmp_path, "acme", "010_tenth.sql")

        files = list_sql_files(tmp_path / "acme")
        assert [f.name for f in files] == [
            "000_first.sql",
            "001_second.sql",
            "010_tenth.sql",
        ]

    def test_non_recursive_ignores_nested_sql_files(self, tmp_path):
        _write_sql_file(tmp_path, "acme", "000_first.sql")
        nested = tmp_path / "acme" / "nested"
        nested.mkdir()
        (nested / "999_nested.sql").write_text("SELECT 1;")

        files = list_sql_files(tmp_path / "acme")
        assert [f.name for f in files] == ["000_first.sql"]

    def test_ignores_non_sql_files(self, tmp_path):
        _write_sql_file(tmp_path, "acme", "000_first.sql")
        (tmp_path / "acme" / "NOTES.md").write_text("not sql")

        files = list_sql_files(tmp_path / "acme")
        assert [f.name for f in files] == ["000_first.sql"]


class TestDdlImportEnvironment:
    """tabsii-platform#830 — the per-environment DDL seed gate. The property
    that matters is the fail-safe direction: unset must read as None, not as
    some default, because `_run_ddl_import` treats None as "publish nothing"
    and any other value as "publish this" (see the function's own docstring).
    """

    def test_unset_is_none(self, monkeypatch):
        monkeypatch.delenv("BIFFO_ENVIRONMENT", raising=False)
        assert ddl_import_environment() is None

    def test_blank_is_none(self, monkeypatch):
        # Whitespace-only counts as unset too — a Terraform var interpolated
        # from an empty local is exactly this shape, not a missing key.
        monkeypatch.setenv("BIFFO_ENVIRONMENT", "   ")
        assert ddl_import_environment() is None

    def test_does_not_fall_back_to_settings_default(self, monkeypatch):
        # settings.environment defaults to "dev" (config.py) for unrelated
        # reasons (echo-logging safety, log level). This function must NOT
        # inherit that default -- doing so would make "nobody set
        # BIFFO_ENVIRONMENT" indistinguishable from "this really is dev",
        # which is precisely the fail-open this gate exists to avoid.
        monkeypatch.delenv("BIFFO_ENVIRONMENT", raising=False)
        assert ddl_import_environment() != "dev"
        assert ddl_import_environment() is None

    def test_dev_is_published_literally(self, monkeypatch):
        monkeypatch.setenv("BIFFO_ENVIRONMENT", "dev")
        assert ddl_import_environment() == "dev"

    def test_staging_is_published_literally(self, monkeypatch):
        monkeypatch.setenv("BIFFO_ENVIRONMENT", "staging")
        assert ddl_import_environment() == "staging"

    def test_prod_is_published_literally(self, monkeypatch):
        monkeypatch.setenv("BIFFO_ENVIRONMENT", "prod")
        assert ddl_import_environment() == "prod"

    def test_surrounding_whitespace_is_trimmed(self, monkeypatch):
        monkeypatch.setenv("BIFFO_ENVIRONMENT", "  dev  ")
        assert ddl_import_environment() == "dev"


def _git(cwd, *args: str) -> str:
    result = subprocess.run(  # noqa: S603 -- fixed git argv, no shell
        ["git", *args],  # noqa: S607  # nosec B603,B607
        cwd=cwd,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, f"git {args} failed: {result.stderr}"
    return result.stdout


class TestDerivedApplyOrder:
    """biffo-template#2458: unnumbered `<slug>.sql` modules apply after every
    numbered one, in the order they merged into the default branch, never by name.

    Each test builds a real git history under `tmp_path`; `origin/dev` is a local
    ref standing in for the merged default branch.
    """

    @pytest.fixture
    def repo(self, tmp_path):
        _git(tmp_path, "init", "-q", "-b", "dev")
        _git(tmp_path, "config", "user.email", "ddl-order-test@example.invalid")
        _git(tmp_path, "config", "user.name", "DDL Order Test")
        _git(tmp_path, "config", "commit.gpgsign", "false")
        self._commit(tmp_path, "000_schema.sql", "001_tables.sql")
        return tmp_path

    @staticmethod
    def _commit(repo, *names: str) -> None:
        for name in names:
            _write_sql_file(repo, "acme", name)
        _git(repo, "add", "-A")
        _git(repo, "commit", "-q", "-m", f"add {' '.join(names)}")

    @staticmethod
    def _names(import_dir) -> list[str]:
        return [f.name for f in list_sql_files(import_dir)]

    def test_unnumbered_modules_follow_merge_order_not_name(self, repo):
        self._commit(repo, "zeta_first_merged.sql")
        self._commit(repo, "alpha_second_merged.sql")
        _git(repo, "update-ref", "refs/remotes/origin/dev", "HEAD")

        assert self._names(repo / "acme") == [
            "000_schema.sql",
            "001_tables.sql",
            "zeta_first_merged.sql",
            "alpha_second_merged.sql",
        ]

    def test_numbered_modules_keep_their_name_order_even_when_added_later(self, repo):
        self._commit(repo, "slug_module.sql")
        self._commit(repo, "002_late_numbered.sql")

        assert self._names(repo / "acme") == [
            "000_schema.sql",
            "001_tables.sql",
            "002_late_numbered.sql",
            "slug_module.sql",
        ]

    def test_a_branch_module_comes_after_everything_on_the_default_branch(self, repo):
        """Two PRs each add a module and neither renumbers: the one on the default
        branch keeps its place, and the branch's own module lands after it."""
        _git(repo, "checkout", "-q", "-b", "feature")
        self._commit(repo, "aaa_on_the_branch.sql")
        _git(repo, "checkout", "-q", "dev")
        self._commit(repo, "zzz_merged_meanwhile.sql")
        _git(repo, "update-ref", "refs/remotes/origin/dev", "HEAD")
        _git(repo, "checkout", "-q", "feature")
        _git(repo, "merge", "-q", "--no-edit", "dev")

        assert self._names(repo / "acme")[2:] == [
            "zzz_merged_meanwhile.sql",
            "aaa_on_the_branch.sql",
        ]

    def test_a_promotion_branch_orders_by_the_default_branch_history(self, repo):
        """staging receives dev's modules in one promotion commit; its own history
        would order them by name. The default branch's merge order wins."""
        _git(repo, "branch", "staging")
        self._commit(repo, "zeta_first_merged.sql")
        self._commit(repo, "alpha_second_merged.sql")
        _git(repo, "update-ref", "refs/remotes/origin/dev", "HEAD")
        _git(repo, "checkout", "-q", "staging")
        _git(repo, "merge", "-q", "--squash", "dev")
        _git(repo, "commit", "-q", "-m", "promote dev")

        assert self._names(repo / "acme")[2:] == [
            "zeta_first_merged.sql",
            "alpha_second_merged.sql",
        ]

    def test_uncommitted_modules_come_last_by_name(self, repo):
        self._commit(repo, "committed.sql")
        _write_sql_file(repo, "acme", "b_uncommitted.sql")
        _write_sql_file(repo, "acme", "a_uncommitted.sql")

        assert self._names(repo / "acme")[2:] == [
            "committed.sql",
            "a_uncommitted.sql",
            "b_uncommitted.sql",
        ]

    def test_a_shallow_clone_is_refused(self, repo, tmp_path_factory):
        self._commit(repo, "zeta_first_merged.sql")
        self._commit(repo, "alpha_second_merged.sql")
        clone = tmp_path_factory.mktemp("shallow") / "clone"
        _git(repo, "clone", "-q", "--depth", "1", f"file://{repo}", str(clone))

        with pytest.raises(DdlOrderUnavailableError, match="shallow"):
            list_sql_files(clone / "acme")

    def test_without_git_or_a_manifest_unnumbered_modules_are_refused(self, tmp_path):
        _write_sql_file(tmp_path, "acme", "000_schema.sql")
        _write_sql_file(tmp_path, "acme", "slug_module.sql")
        _write_sql_file(tmp_path, "acme", "another_module.sql")

        with pytest.raises(DdlOrderUnavailableError, match="slug_module.sql"):
            list_sql_files(tmp_path / "acme")

    def test_the_manifest_carries_the_order_to_a_tree_without_git(self, repo, tmp_path_factory):
        """The deploy packaging writes `.apply-order` from the checkout; the Lambda
        has the files and the manifest but no git."""
        self._commit(repo, "zeta_first_merged.sql")
        self._commit(repo, "alpha_second_merged.sql")
        manifest = format_manifest(repo / "acme")
        package = tmp_path_factory.mktemp("package") / "acme"
        package.mkdir()
        for sql in (repo / "acme").glob("*.sql"):
            (package / sql.name).write_text(sql.read_text())
        (package / MANIFEST_NAME).write_text(manifest)

        assert self._names(package) == self._names(repo / "acme")
        assert manifest == (
            "000\t000_schema.sql\n"
            "001\t001_tables.sql\n"
            "002\tzeta_first_merged.sql\n"
            "003\talpha_second_merged.sql\n"
        )

    def test_a_manifest_that_does_not_match_the_files_is_refused(self, tmp_path):
        _write_sql_file(tmp_path, "acme", "000_schema.sql")
        _write_sql_file(tmp_path, "acme", "slug_module.sql")
        _write_sql_file(tmp_path, "acme", "another_module.sql")
        (tmp_path / "acme" / MANIFEST_NAME).write_text(
            "000\t000_schema.sql\n001\tanother_module.sql\n"
        )

        with pytest.raises(DdlOrderUnavailableError, match="slug_module.sql"):
            list_sql_files(tmp_path / "acme")

    def test_a_single_unnumbered_module_needs_no_git(self, tmp_path):
        """A plugin's lone `schema.sql`: there is only one place it can go."""
        _write_sql_file(tmp_path, "acme", "schema.sql")
        _write_sql_file(tmp_path, "acme", "000_first.sql")

        assert self._names(tmp_path / "acme") == ["000_first.sql", "schema.sql"]

    def test_derived_numbers_continue_after_the_highest_numbered_file(self, tmp_path):
        paths = [tmp_path / n for n in ("000_a.sql", "223_b.sql", "223_c.sql", "x.sql", "y.sql")]
        assert [n for n, _ in derived_numbers(paths)] == [0, 223, 223, 224, 225]


class TestDdlOrderGitFailures:
    """Each way git can fail to answer is reported as 'cannot tell', never guessed."""

    @staticmethod
    def _repo(tmp_path):
        _git(tmp_path, "init", "-q", "-b", "dev")
        _git(tmp_path, "config", "user.email", "ddl-order-test@example.invalid")
        _git(tmp_path, "config", "user.name", "DDL Order Test")
        _git(tmp_path, "config", "commit.gpgsign", "false")
        for name in ("000_schema.sql", "a_mod.sql", "b_mod.sql"):
            _write_sql_file(tmp_path, "acme", name)
        _git(tmp_path, "add", "-A")
        _git(tmp_path, "commit", "-q", "-m", "init")
        _git(tmp_path, "update-ref", "refs/remotes/origin/dev", "HEAD")
        return tmp_path / "acme"

    @staticmethod
    def _failing(monkeypatch, subcommand):
        real = ddl_order._git

        def fake(import_dir, *args):
            if subcommand in args:
                return None
            return real(import_dir, *args)

        monkeypatch.setattr(ddl_order, "_git", fake)

    def test_git_binary_missing_means_no_answer(self, tmp_path, monkeypatch):
        def boom(*args, **kwargs):
            raise FileNotFoundError("git")

        monkeypatch.setattr(ddl_order.subprocess, "run", boom)
        assert ddl_order._git(tmp_path, "status") is None

    def test_new_numbered_modules_is_none_when_the_base_tree_cannot_be_listed(
        self, tmp_path, monkeypatch
    ):
        import_dir = self._repo(tmp_path)
        self._failing(monkeypatch, "ls-tree")
        assert new_numbered_modules(import_dir) is None

    def test_history_that_cannot_be_read_falls_back_to_the_manifest_or_refuses(
        self, tmp_path, monkeypatch
    ):
        import_dir = self._repo(tmp_path)
        self._failing(monkeypatch, "log")
        assert ddl_order._git_added_order(import_dir) is None
        with pytest.raises(DdlOrderUnavailableError):
            list_sql_files(import_dir)

    def test_main_reports_an_underivable_order_and_exits_1(self, tmp_path, capsys):
        _write_sql_file(tmp_path, "acme", "a_mod.sql")
        _write_sql_file(tmp_path, "acme", "b_mod.sql")

        assert main([str(tmp_path / "acme")]) == 1
        assert "ddl_order:" in capsys.readouterr().err
