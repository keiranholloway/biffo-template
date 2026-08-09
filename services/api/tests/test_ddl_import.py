"""Tests for api.ddl_import.discover_ddl_import_dirs / list_sql_files /
ddl_import_environment."""

from api.ddl_import import ddl_import_environment, discover_ddl_import_dirs, list_sql_files


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
