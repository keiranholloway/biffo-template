"""Tests for scripts/generate_plugin_migrations.py -- the CLI entrypoint the
Node CLI (`biffo plugin install`/`upgrade`/`sync-migrations`) shells out to,
via `uv run python`, to generate real, git-committed migration files."""

from __future__ import annotations

import importlib.util
import json
import shutil
import tempfile
from pathlib import Path

import pytest

_SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "generate_plugin_migrations.py"


def _load_main():
    spec = importlib.util.spec_from_file_location("generate_plugin_migrations", _SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.main


main = _load_main()


class TestGeneratePluginMigrationsCli:
    def setup_method(self):
        self.tmpdir = tempfile.mkdtemp()
        self.versions_dir = Path(self.tmpdir) / "versions"
        self.versions_dir.mkdir()
        self.services_root = Path(self.tmpdir) / "services"
        self.services_root.mkdir()

    def teardown_method(self):
        shutil.rmtree(self.tmpdir)

    def _write_manifest(self, plugin_name: str, manifest: dict) -> None:
        # exist_ok=True: a test rewriting a plugin's manifest between two
        # runs (e.g. issue #1539's "table gains a column" scenario) calls
        # this twice for the same plugin_name.
        plugin_dir = self.services_root / plugin_name
        plugin_dir.mkdir(exist_ok=True)
        (plugin_dir / "biffo.plugin.json").write_text(json.dumps(manifest))

    def _run(self, *extra_args: str) -> tuple[int, str, str]:
        argv = [
            "--services-root",
            str(self.services_root),
            "--versions-dir",
            str(self.versions_dir),
            *extra_args,
        ]
        exit_code = main(argv)
        return exit_code

    def test_generates_and_prints_the_absolute_path(self, capsys: pytest.CaptureFixture) -> None:
        self._write_manifest(
            "rbac", {"name": "rbac", "version": "1.0.0", "tables": [{"name": "roles"}]}
        )

        exit_code = self._run()

        assert exit_code == 0
        out = capsys.readouterr().out.strip()
        assert out
        generated_path = Path(out)
        assert generated_path.is_absolute()
        assert generated_path.exists()
        assert generated_path.parent == self.versions_dir

    def test_idempotent_rerun_prints_nothing(self, capsys: pytest.CaptureFixture) -> None:
        self._write_manifest(
            "rbac", {"name": "rbac", "version": "1.0.0", "tables": [{"name": "roles"}]}
        )

        self._run()
        capsys.readouterr()  # discard first run's output
        exit_code = self._run()

        assert exit_code == 0
        assert capsys.readouterr().out == ""

    def test_plugin_filter_restricts_to_the_named_plugin(
        self, capsys: pytest.CaptureFixture
    ) -> None:
        self._write_manifest(
            "rbac", {"name": "rbac", "version": "1.0.0", "tables": [{"name": "roles"}]}
        )
        self._write_manifest(
            "billing",
            {"name": "billing", "version": "1.0.0", "tables": [{"name": "invoices"}]},
        )

        exit_code = self._run("--plugin", "rbac")

        assert exit_code == 0
        out = capsys.readouterr().out.strip().splitlines()
        assert len(out) == 1
        assert "roles" in out[0]

    def test_multiple_plugin_flags_restrict_to_all_named_plugins(
        self, capsys: pytest.CaptureFixture
    ) -> None:
        self._write_manifest(
            "rbac", {"name": "rbac", "version": "1.0.0", "tables": [{"name": "roles"}]}
        )
        self._write_manifest(
            "billing",
            {"name": "billing", "version": "1.0.0", "tables": [{"name": "invoices"}]},
        )

        exit_code = self._run("--plugin", "rbac", "--plugin", "billing")

        assert exit_code == 0
        out = capsys.readouterr().out.strip().splitlines()
        assert len(out) == 2

    def test_unknown_plugin_name_exits_nonzero_with_stderr_message(
        self, capsys: pytest.CaptureFixture
    ) -> None:
        exit_code = self._run("--plugin", "nonexistent")

        assert exit_code == 1
        err = capsys.readouterr().err
        assert "nonexistent" in err

    def test_plugin_with_no_tables_generates_nothing(self, capsys: pytest.CaptureFixture) -> None:
        self._write_manifest("noop", {"name": "noop", "version": "1.0.0", "tables": []})

        exit_code = self._run()

        assert exit_code == 0
        assert capsys.readouterr().out == ""

    def test_column_added_to_existing_table_generates_a_migration(
        self, capsys: pytest.CaptureFixture
    ) -> None:
        # Issue #1539's real-world route: a plugin refresh where the table
        # SET is unchanged but a table gained a column.
        self._write_manifest(
            "marketing",
            {
                "name": "marketing",
                "version": "1.0.0",
                "tables": [
                    {
                        "name": "marketing_channel",
                        "columns": [{"name": "key", "type": "String(64)"}],
                    }
                ],
            },
        )
        self._run()
        capsys.readouterr()  # discard first run's output

        self._write_manifest(
            "marketing",
            {
                "name": "marketing",
                "version": "1.1.0",
                "tables": [
                    {
                        "name": "marketing_channel",
                        "columns": [
                            {"name": "key", "type": "String(64)"},
                            {"name": "publish_url", "type": "String(512)", "nullable": True},
                        ],
                    }
                ],
            },
        )
        exit_code = self._run()

        assert exit_code == 0
        out = capsys.readouterr().out.strip()
        assert out
        assert "add_column" in Path(out).read_text()

    def test_column_removed_from_existing_table_exits_nonzero_naming_it(
        self, capsys: pytest.CaptureFixture
    ) -> None:
        # Issue #1539: refuse rather than guess when an already-migrated
        # table's column is removed, retyped, or nullability-changed — this
        # needs a human decision about existing rows, and the operator must
        # see why, not a bare nonzero exit.
        self._write_manifest(
            "marketing",
            {
                "name": "marketing",
                "version": "1.0.0",
                "tables": [
                    {
                        "name": "marketing_channel",
                        "columns": [{"name": "key", "type": "String(64)"}],
                    }
                ],
            },
        )
        self._run()
        capsys.readouterr()  # discard first run's output

        self._write_manifest(
            "marketing",
            {
                "name": "marketing",
                "version": "1.1.0",
                "tables": [{"name": "marketing_channel", "columns": []}],
            },
        )
        exit_code = self._run()

        assert exit_code == 1
        err = capsys.readouterr().err
        assert "marketing_channel" in err
        assert "key" in err
        assert "removed" in err
