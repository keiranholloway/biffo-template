"""Convention guard: DDL-import modules must be safe to apply twice.

`biffo data apply` runs each `db/imports/<name>/*.sql` file once and records a
sha256 of its content. If a file's checksum later changes, the next apply
**hard-fails** — "this tool does not support modifying already-applied DDL —
add a new file instead" (`main.py::_run_db_init`).

That guardrail has a consequence that motivates this test: **a module's
idempotency can never be fixed after the fact.** Once a module has been applied
in any environment its text is frozen, and no later module can rescue it —
only the module's own text decides whether re-running it errors. A
non-idempotent module is therefore permanent. The convention has to be enforced
*before* a module first lands, which is what this does.

Why idempotency matters at all, given apply already skips by checksum: the skip
protects the normal path, but not a database whose objects exist while its
`ddl_import_history` does not — a schema-only restore, a truncated history
table, or a chain applied by hand. In those cases the whole import re-runs, and
any non-idempotent module aborts it.

## Per-import configuration

Everything instance-specific lives in an **optional** `.ddl-guard.json` beside
the SQL, i.e. `db/imports/<name>/.ddl-guard.json`. `db/` is user-owned, so an
instance's exemptions survive `biffo core upgrade`; this file is template-owned
and carries no instance's data.

```json
{
  "first_guarded_module": "015",
  "grandfathered_bare_policies": {
    "029_marketplace_brand_profiles.sql": ["bmp_create", "bmp_read"]
  }
}
```

- `first_guarded_module` — skip modules whose filename sorts before this. For a
  chain vendored from a pre-existing schema, the early one-shot modules
  (`CREATE TABLE tenants` …) are legitimately not idempotent and were never
  intended to be re-run. Defaults to guarding everything.
- `grandfathered_bare_policies` — policy names in a module that is already
  applied somewhere and so can no longer be corrected. Pinned per name, so a
  *new* bare policy in that same file still fails, and a stale entry fails too.

Both keys are optional; an absent file means "guard everything, exempt
nothing". Unknown keys and malformed JSON are hard errors rather than being
ignored — an exemption you believe is in force but that silently isn't would be
worse than no guard at all.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import NamedTuple

import pytest
from api.ddl_import import list_sql_files

# services/api/tests/ -> services/api -> services -> <repo root>
REPO_ROOT = Path(__file__).resolve().parents[3]
IMPORTS_ROOT = REPO_ROOT / "db" / "imports"

CONFIG_FILENAME = ".ddl-guard.json"
_KNOWN_CONFIG_KEYS = frozenset({"first_guarded_module", "grandfathered_bare_policies"})


class GuardConfig(NamedTuple):
    """Resolved `.ddl-guard.json` for one import directory."""

    first_guarded_module: str
    grandfathered_bare_policies: dict[str, frozenset[str]]
    source: Path | None


class GuardedModule(NamedTuple):
    """One SQL module plus the config governing it."""

    path: Path
    config: GuardConfig


def _load_config(import_dir: Path) -> GuardConfig:
    """Read `.ddl-guard.json`, or return permissive-to-nobody defaults."""
    config_path = import_dir / CONFIG_FILENAME
    if not config_path.is_file():
        return GuardConfig("", {}, None)

    try:
        raw = json.loads(config_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"{config_path} is not valid JSON: {exc}") from exc

    if not isinstance(raw, dict):
        raise ValueError(f"{config_path} must contain a JSON object, got {type(raw).__name__}")

    unknown = set(raw) - _KNOWN_CONFIG_KEYS
    if unknown:
        raise ValueError(
            f"{config_path} has unknown key(s) {sorted(unknown)}; "
            f"expected any of {sorted(_KNOWN_CONFIG_KEYS)}. "
            "Refusing to continue — a misspelled key would silently drop an exemption."
        )

    first = raw.get("first_guarded_module", "")
    if not isinstance(first, str):
        raise ValueError(f"{config_path}: 'first_guarded_module' must be a string")

    exemptions_raw = raw.get("grandfathered_bare_policies", {})
    if not isinstance(exemptions_raw, dict):
        raise ValueError(f"{config_path}: 'grandfathered_bare_policies' must be an object")

    exemptions: dict[str, frozenset[str]] = {}
    for filename, names in exemptions_raw.items():
        if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
            raise ValueError(
                f"{config_path}: 'grandfathered_bare_policies[{filename!r}]' "
                "must be a list of policy-name strings"
            )
        exemptions[filename] = frozenset(names)

    return GuardConfig(first, exemptions, config_path)


def _discover() -> list[GuardedModule]:
    """Every module the importer would apply, paired with its guard config."""
    if not IMPORTS_ROOT.is_dir():
        return []

    modules: list[GuardedModule] = []
    for import_dir in sorted(IMPORTS_ROOT.iterdir()):
        if not import_dir.is_dir():
            continue
        config = _load_config(import_dir)
        for path in list_sql_files(import_dir):
            if path.name >= config.first_guarded_module:
                modules.append(GuardedModule(path, config))
    return modules


MODULES = _discover()


def _module_id(module: GuardedModule) -> str:
    return f"{module.path.parent.name}/{module.path.name}"


def _strip_sql_comments(sql: str) -> str:
    """Drop `--` line and `/* */` block comments before scanning.

    Without this the scan matches prose: a module header explaining that "the
    CREATE POLICY errored" is not a CREATE POLICY statement.
    """
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.DOTALL)
    return re.sub(r"--[^\n]*", " ", sql)


def _read(module: GuardedModule) -> str:
    return _strip_sql_comments(module.path.read_text(encoding="utf-8"))


@pytest.mark.skipif(not MODULES, reason="no DDL imports vendored in this repo")
@pytest.mark.parametrize("module", MODULES, ids=_module_id)
class TestDdlImportIdempotency:
    """Mechanical checks for the ways a module fails on a second apply.

    Deliberately not a general "is this SQL idempotent" analysis — these cover
    the statements that actually recur in DDL-import modules and have no
    `IF NOT EXISTS` form or are easy to write without one.
    """

    def test_create_policy_is_guarded(self, module: GuardedModule) -> None:
        """`CREATE POLICY x` needs `DROP POLICY IF EXISTS x` or a catalog check.

        Postgres has no `CREATE POLICY IF NOT EXISTS`, so a bare `CREATE POLICY`
        raises "policy ... already exists" on re-apply. Two guard styles are
        accepted: drop-then-create, and wrapping the create in
        `IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = '...')`.
        """
        sql = _read(module)

        created = re.findall(r"\bCREATE\s+POLICY\s+(\w+)", sql, re.IGNORECASE)
        if not created:
            pytest.skip("module creates no policies")

        dropped = {
            name.lower()
            for name in re.findall(r"\bDROP\s+POLICY\s+IF\s+EXISTS\s+(\w+)", sql, re.IGNORECASE)
        }
        catalog_guarded = {
            name.lower() for name in re.findall(r"policyname\s*=\s*'(\w+)'", sql, re.IGNORECASE)
        }
        guarded = dropped | catalog_guarded

        allowed = module.config.grandfathered_bare_policies.get(module.path.name, frozenset())
        unguarded = {name for name in created if name.lower() not in guarded} - allowed

        assert not unguarded, (
            f"{_module_id(module)} creates {sorted(unguarded)} with no "
            "DROP POLICY IF EXISTS and no pg_policies existence check, so "
            "re-applying this module errors.\n\n"
            "Postgres has no CREATE POLICY IF NOT EXISTS — precede each "
            "CREATE POLICY with DROP POLICY IF EXISTS <name>.\n\n"
            "Fix this BEFORE the module is first applied anywhere: once applied, "
            "its checksum is recorded and the importer refuses any edit to it, "
            "making the module permanently non-idempotent. If that has already "
            "happened, record it in "
            f"{module.path.parent / CONFIG_FILENAME} under "
            "'grandfathered_bare_policies'."
        )

    def test_create_table_is_guarded(self, module: GuardedModule) -> None:
        """`CREATE TABLE` must be `IF NOT EXISTS`, or preceded by a DROP."""
        sql = _read(module)

        bare = re.findall(r"\bCREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)([\w.]+)", sql, re.IGNORECASE)
        dropped = {
            name.lower()
            for name in re.findall(r"\bDROP\s+TABLE\s+IF\s+EXISTS\s+([\w.]+)", sql, re.IGNORECASE)
        }
        unguarded = sorted({name for name in bare if name.lower() not in dropped})

        assert not unguarded, (
            f"{_module_id(module)} has CREATE TABLE without IF NOT EXISTS for "
            f"{unguarded} — re-applying this module errors."
        )

    def test_create_index_is_guarded(self, module: GuardedModule) -> None:
        """`CREATE INDEX` must be `IF NOT EXISTS`."""
        sql = _read(module)

        bare = sorted(
            set(
                re.findall(
                    r"\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+"
                    r"(?!IF\s+NOT\s+EXISTS|CONCURRENTLY)(\w+)",
                    sql,
                    re.IGNORECASE,
                )
            )
        )

        assert not bare, (
            f"{_module_id(module)} has CREATE INDEX without IF NOT EXISTS for "
            f"{bare} — re-applying this module errors."
        )

    def test_add_column_is_guarded(self, module: GuardedModule) -> None:
        """`ALTER TABLE ... ADD COLUMN` must be `IF NOT EXISTS`."""
        sql = _read(module)

        bare = sorted(
            set(re.findall(r"\bADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)(\w+)", sql, re.IGNORECASE))
        )

        assert not bare, (
            f"{_module_id(module)} has ADD COLUMN without IF NOT EXISTS for "
            f"{bare} — re-applying this module errors."
        )


@pytest.mark.skipif(not MODULES, reason="no DDL imports vendored in this repo")
class TestGuardConfigHygiene:
    """A stale or over-broad exemption list is itself a defect."""

    def test_exemptions_reference_existing_modules(self) -> None:
        """Every exempted filename must still be present in its import."""
        stale: list[str] = []
        for import_dir in sorted(p for p in IMPORTS_ROOT.iterdir() if p.is_dir()):
            config = _load_config(import_dir)
            if not config.grandfathered_bare_policies:
                continue
            present = {path.name for path in list_sql_files(import_dir)}
            stale += [
                f"{import_dir.name}/{filename}"
                for filename in config.grandfathered_bare_policies
                if filename not in present
            ]

        assert not stale, (
            f"{CONFIG_FILENAME} exempts modules that no longer exist: {sorted(stale)}. "
            "Remove them so the exemption list cannot drift into a blanket opt-out."
        )

    def test_exempted_policies_are_still_created(self) -> None:
        """Every exempted policy name must still appear in its module.

        Stops an exemption outliving the statement it excused — otherwise the
        entry silently starts covering nothing, or worse, a future rename.
        """
        stale: list[str] = []
        for import_dir in sorted(p for p in IMPORTS_ROOT.iterdir() if p.is_dir()):
            config = _load_config(import_dir)
            for filename, names in config.grandfathered_bare_policies.items():
                path = import_dir / filename
                if not path.is_file():
                    continue  # covered by the test above
                sql = _strip_sql_comments(path.read_text(encoding="utf-8"))
                created = {
                    name.lower()
                    for name in re.findall(r"\bCREATE\s+POLICY\s+(\w+)", sql, re.IGNORECASE)
                }
                stale += [
                    f"{import_dir.name}/{filename}:{name}"
                    for name in sorted(names)
                    if name.lower() not in created
                ]

        assert not stale, (
            f"{CONFIG_FILENAME} exempts policies that are no longer created: "
            f"{sorted(stale)}. Remove them."
        )


# ---------------------------------------------------------------------------
# Unit tests for the guard itself.
#
# The checks above are inert in this repo — the template vendors no DDL imports,
# so they skip. Without the tests below, this file would ship to every instance
# having never executed. These exercise the detection and config logic directly
# against synthetic modules.
# ---------------------------------------------------------------------------


def _write_module(import_dir: Path, name: str, sql: str) -> GuardedModule:
    import_dir.mkdir(parents=True, exist_ok=True)
    path = import_dir / name
    path.write_text(sql, encoding="utf-8")
    return GuardedModule(path, _load_config(import_dir))


@pytest.fixture
def checks() -> TestDdlImportIdempotency:
    return TestDdlImportIdempotency()


class TestPolicyDetection:
    def test_bare_create_policy_fails(self, tmp_path, checks) -> None:
        module = _write_module(
            tmp_path / "demo",
            "010_x.sql",
            "CREATE POLICY p_read ON t FOR SELECT USING (true);",
        )
        with pytest.raises(AssertionError, match="p_read"):
            checks.test_create_policy_is_guarded(module)

    def test_drop_then_create_passes(self, tmp_path, checks) -> None:
        module = _write_module(
            tmp_path / "demo",
            "010_x.sql",
            "DROP POLICY IF EXISTS p_read ON t;\n"
            "CREATE POLICY p_read ON t FOR SELECT USING (true);",
        )
        checks.test_create_policy_is_guarded(module)

    def test_pg_policies_existence_check_passes(self, tmp_path, checks) -> None:
        """The `DO $$ IF NOT EXISTS (SELECT 1 FROM pg_policies ...)` style."""
        module = _write_module(
            tmp_path / "demo",
            "010_x.sql",
            "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies "
            "WHERE policyname = 'p_read') THEN "
            "CREATE POLICY p_read ON t FOR SELECT USING (true); END IF; END $$;",
        )
        checks.test_create_policy_is_guarded(module)

    def test_policy_named_only_in_a_comment_is_not_a_statement(self, tmp_path, checks) -> None:
        """Prose must not be mistaken for SQL.

        Asserted via the skip outcome, which is what "this module creates no
        policies" means. `pytest.skip` raises `Skipped`, a BaseException — so
        this must catch `pytest.skip.Exception` explicitly; `pytest.raises(
        Exception)` would let it through and silently skip this test instead.
        """
        module = _write_module(
            tmp_path / "demo",
            "010_x.sql",
            "-- An earlier module's CREATE POLICY errored here.\nSELECT 1;",
        )
        with pytest.raises(pytest.skip.Exception):
            checks.test_create_policy_is_guarded(module)

    def test_strip_sql_comments_removes_both_comment_forms(self) -> None:
        stripped = _strip_sql_comments(
            "-- line CREATE POLICY a\n/* block CREATE POLICY b */\nCREATE POLICY c ON t;"
        )
        assert "a" not in stripped and "b" not in stripped
        assert "CREATE POLICY c" in stripped

    def test_comment_does_not_satisfy_the_guard(self, tmp_path, checks) -> None:
        """A DROP mentioned only in a comment must not count as guarding."""
        module = _write_module(
            tmp_path / "demo",
            "010_x.sql",
            "-- DROP POLICY IF EXISTS p_read ON t;\n"
            "CREATE POLICY p_read ON t FOR SELECT USING (true);",
        )
        with pytest.raises(AssertionError, match="p_read"):
            checks.test_create_policy_is_guarded(module)

    def test_grandfathered_policy_is_exempt(self, tmp_path, checks) -> None:
        import_dir = tmp_path / "demo"
        import_dir.mkdir()
        (import_dir / CONFIG_FILENAME).write_text(
            json.dumps({"grandfathered_bare_policies": {"010_x.sql": ["p_read"]}}),
            encoding="utf-8",
        )
        module = _write_module(
            import_dir, "010_x.sql", "CREATE POLICY p_read ON t FOR SELECT USING (true);"
        )
        checks.test_create_policy_is_guarded(module)

    def test_exemption_does_not_cover_a_new_policy(self, tmp_path, checks) -> None:
        """The pinned list must not become a blanket opt-out for the file."""
        import_dir = tmp_path / "demo"
        import_dir.mkdir()
        (import_dir / CONFIG_FILENAME).write_text(
            json.dumps({"grandfathered_bare_policies": {"010_x.sql": ["p_read"]}}),
            encoding="utf-8",
        )
        module = _write_module(
            import_dir,
            "010_x.sql",
            "CREATE POLICY p_read ON t FOR SELECT USING (true);\n"
            "CREATE POLICY p_write ON t FOR INSERT WITH CHECK (true);",
        )
        with pytest.raises(AssertionError, match="p_write"):
            checks.test_create_policy_is_guarded(module)


class TestStatementDetection:
    @pytest.mark.parametrize(
        ("sql", "check_name", "needle"),
        [
            ("CREATE TABLE t (id int);", "test_create_table_is_guarded", "t"),
            ("CREATE INDEX ix_t ON t(id);", "test_create_index_is_guarded", "ix_t"),
            ("CREATE UNIQUE INDEX ux_t ON t(id);", "test_create_index_is_guarded", "ux_t"),
            ("ALTER TABLE t ADD COLUMN c text;", "test_add_column_is_guarded", "c"),
        ],
    )
    def test_bare_statement_fails(
        self, tmp_path, checks, sql: str, check_name: str, needle: str
    ) -> None:
        module = _write_module(tmp_path / "demo", "010_x.sql", sql)
        with pytest.raises(AssertionError, match=needle):
            getattr(checks, check_name)(module)

    @pytest.mark.parametrize(
        ("sql", "check_name"),
        [
            ("CREATE TABLE IF NOT EXISTS t (id int);", "test_create_table_is_guarded"),
            ("DROP TABLE IF EXISTS t;\nCREATE TABLE t (id int);", "test_create_table_is_guarded"),
            ("CREATE INDEX IF NOT EXISTS ix_t ON t(id);", "test_create_index_is_guarded"),
            ("ALTER TABLE t ADD COLUMN IF NOT EXISTS c text;", "test_add_column_is_guarded"),
        ],
    )
    def test_guarded_statement_passes(self, tmp_path, checks, sql: str, check_name: str) -> None:
        module = _write_module(tmp_path / "demo", "010_x.sql", sql)
        getattr(checks, check_name)(module)


class TestConfigLoading:
    def test_absent_config_guards_everything(self, tmp_path) -> None:
        (tmp_path / "demo").mkdir()
        config = _load_config(tmp_path / "demo")
        assert config.first_guarded_module == ""
        assert config.grandfathered_bare_policies == {}
        assert config.source is None

    def test_first_guarded_module_is_a_filename_bound(self, tmp_path) -> None:
        """Modules sorting before the bound are out of scope."""
        import_dir = tmp_path / "demo"
        import_dir.mkdir()
        (import_dir / CONFIG_FILENAME).write_text(
            json.dumps({"first_guarded_module": "015"}), encoding="utf-8"
        )
        config = _load_config(import_dir)
        assert "014_legacy.sql" < config.first_guarded_module
        assert "015_first.sql" >= config.first_guarded_module

    def test_malformed_json_is_a_hard_error(self, tmp_path) -> None:
        import_dir = tmp_path / "demo"
        import_dir.mkdir()
        (import_dir / CONFIG_FILENAME).write_text("{not json", encoding="utf-8")
        with pytest.raises(ValueError, match="not valid JSON"):
            _load_config(import_dir)

    def test_unknown_key_is_a_hard_error(self, tmp_path) -> None:
        """A typo must not silently drop an exemption the author believes is live."""
        import_dir = tmp_path / "demo"
        import_dir.mkdir()
        (import_dir / CONFIG_FILENAME).write_text(
            json.dumps({"grandfathered_policies": {}}), encoding="utf-8"
        )
        with pytest.raises(ValueError, match="unknown key"):
            _load_config(import_dir)

    def test_wrong_exemption_shape_is_a_hard_error(self, tmp_path) -> None:
        import_dir = tmp_path / "demo"
        import_dir.mkdir()
        (import_dir / CONFIG_FILENAME).write_text(
            json.dumps({"grandfathered_bare_policies": {"010_x.sql": "p_read"}}),
            encoding="utf-8",
        )
        with pytest.raises(ValueError, match="list of policy-name strings"):
            _load_config(import_dir)
