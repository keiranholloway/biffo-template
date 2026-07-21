"""Tests for api.ddl_import.discover_ddl_import_dirs / list_sql_files."""

from api.ddl_import import discover_ddl_import_dirs, list_sql_files


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
        _write_sql_file(tmp_path, "tabsii", "000_schema.sql")
        assert discover_ddl_import_dirs(tmp_path) == ["tabsii"]

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
        _write_sql_file(tmp_path, "tabsii", "001_second.sql")
        _write_sql_file(tmp_path, "tabsii", "000_first.sql")
        _write_sql_file(tmp_path, "tabsii", "010_tenth.sql")

        files = list_sql_files(tmp_path / "tabsii")
        assert [f.name for f in files] == [
            "000_first.sql",
            "001_second.sql",
            "010_tenth.sql",
        ]

    def test_non_recursive_ignores_nested_sql_files(self, tmp_path):
        _write_sql_file(tmp_path, "tabsii", "000_first.sql")
        nested = tmp_path / "tabsii" / "nested"
        nested.mkdir()
        (nested / "999_nested.sql").write_text("SELECT 1;")

        files = list_sql_files(tmp_path / "tabsii")
        assert [f.name for f in files] == ["000_first.sql"]

    def test_ignores_non_sql_files(self, tmp_path):
        _write_sql_file(tmp_path, "tabsii", "000_first.sql")
        (tmp_path / "tabsii" / "NOTES.md").write_text("not sql")

        files = list_sql_files(tmp_path / "tabsii")
        assert [f.name for f in files] == ["000_first.sql"]
