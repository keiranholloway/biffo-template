"""Plugin migration transitions against a REAL Postgres -- #1511 as a permanent
fixture (biffo-template#1925, M3 of epic #1523).

Three transitions, each asserted against a real database rather than against
generated source text alone:

1. **Fresh install.** Generate the plugin's migration into an empty versions
   directory and ``alembic upgrade head`` it; every manifest-declared table and
   index must exist, and every table must carry a NOT NULL ``tenant_id``
   (ADR-0001).
2. **Upgrade onto an existing installation.** Add one column to the manifest
   and regenerate. The new revision's ``upgrade()`` must contain ONLY that
   delta and its ``downgrade()`` must invert ONLY it. This is #1511's exact
   bug: the generator re-created all six of ``biffo-plugin-marketing``'s
   tables, and the downgrade dropped five tables of data it never created.
3. **Data survival.** With rows already in every table from (1), apply (2)'s
   revision, then downgrade it. Every row must survive both directions, and
   the downgrade must not drop a table it did not create.

## Why the expected delta is computed from the manifests, not the generator

Assertion (2) derives "what the delta should be" by diffing the two manifests
itself (new tables, new columns, and the indexes those imply) and compares the
generated revision's ``op.*`` calls against that. If it asked the generator's
own helpers (``already_created_tables`` etc.) what the delta was, a regression
in those helpers would move the expectation and the output together, and the
assertion would pass on exactly the bug it exists to catch.

## Fail-first is part of the suite, not only of the PR

``test_full_regeneration_turns_exactly_assertion_2_red`` puts back the
pre-#1513 behaviour (``already_created_tables`` reporting nothing, so every
declared table looks new) and asserts that (1) still passes, (2) fails, and
(3) is reported as blocked. It is **not** reported as passed. A fixture whose
failing case has never been observed is the class epic #1523 exists to close.
This file keeps that failing case observable on every run, not just on the
day it was written.

## Isolation and re-runnability

Each run owns one Postgres schema, reached through the connection's
``search_path``. It drops and recreates that schema at the start and leaves
it in place at the end, so a second run against the same database meets
whatever the first one left behind. ``test_second_consecutive_run_is_green``
proves the second run is still green. The schema is dropped by the fixture,
never by the check. Nothing here touches a table the application owns.

## Where this goes next

The default in #1925 is for this to run under ``biffo plugin verify`` from a
plugin repo, as ``biffo_plugin_sdk.conformance.checks.migrations``. That needs
the generator and the ``plugin_table`` model extracted into the SDK first,
and the SDK's check needs a DB driver, which TID251 (ADR-0002, invariant 4)
bans outside ``services/api/``. Both are outside this change's read-set, and
the second is a security-gate decision, so they are split out on #1925.
``run_transitions`` below is written with no Core import except the generator
it is handed, so it can move into the SDK unchanged once they land.
"""

from __future__ import annotations

import ast
import asyncio
import json
import os
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
from api.migrations import plugin_migrations
from api.models.plugin_table import PluginTableDefinition, resolve_type_call


def _pg_dsn() -> str | None:
    return os.environ.get("BIFFO_TEST_PG_DSN") or os.environ.get("TABSII_TEST_PG_DSN")


pytestmark = [
    pytest.mark.skipif(
        _pg_dsn() is None,
        reason=(
            "NEVER EXECUTED IN THIS REPO -- biffo-template ships no Postgres CI lane "
            "(biffo-template#1648), so this test has not run once here; a green suite "
            "proves nothing about the code it guards. Run it for real: "
            'eval "$(sh scripts/pg-test-db.sh --export)"'
        ),
    ),
]


# --------------------------------------------------------------------------
# The fixture manifests. Shaped after #1511's real case at smaller scale:
# several tables, one of which later gains `publish_url` (tabsii-platform#900
# is the column that exposed #1539; #1511 was the table-level twin).
# --------------------------------------------------------------------------

_MANIFEST_V1: dict[str, Any] = {
    "name": "conformance-fixture",
    "version": "1.0.0",
    "tables": [
        {
            "name": "cf_campaign",
            "columns": [
                {"name": "title", "type": "String(200)", "index": True},
                {"name": "status", "type": "String(32)"},
            ],
        },
        {
            "name": "cf_channel",
            "columns": [{"name": "label", "type": "String(100)"}],
            "indexes": [{"name": "uq_cf_channel_label", "columns": ["label"], "unique": True}],
        },
        {
            "name": "cf_post",
            "columns": [
                {"name": "body", "type": "Text", "nullable": True},
                {"name": "published", "type": "Boolean"},
                {"name": "score", "type": "Float", "nullable": True},
            ],
        },
    ],
}


def _manifest_v2() -> dict[str, Any]:
    """V1 plus exactly one nullable, indexed column on an existing table."""
    manifest = json.loads(json.dumps(_MANIFEST_V1))
    manifest["version"] = "1.1.0"
    channel = next(t for t in manifest["tables"] if t["name"] == "cf_channel")
    channel["columns"].append(
        {"name": "publish_url", "type": "String(500)", "nullable": True, "index": True}
    )
    return manifest


# --------------------------------------------------------------------------
# The check itself.
# --------------------------------------------------------------------------

Op = tuple[str, str, str]  # (op name, table, object name -- column/index/table)

#: The generator under test: writes the delta migration for `manifest` into
#: `versions_dir`. Same shape as `plugin_migrations.generate_migration_for_plugin`.
Generate = Callable[[dict[str, Any], Path], Path | None]


class TransitionAssertionError(AssertionError):
    def __init__(self, assertion: int, message: str) -> None:
        super().__init__(f"assertion ({assertion}) failed: {message}")
        self.assertion = assertion


@dataclass
class TransitionReport:
    passed: list[int] = field(default_factory=list)
    failed: dict[int, str] = field(default_factory=dict)
    blocked: list[int] = field(default_factory=list)
    lines: list[str] = field(default_factory=list)

    def say(self, line: str) -> None:
        self.lines.append(line)
        print(line, flush=True)


def _tables(manifest: dict[str, Any]) -> dict[str, PluginTableDefinition]:
    return {
        t["name"]: PluginTableDefinition(**json.loads(json.dumps(t))) for t in manifest["tables"]
    }


def _index_ops(table: PluginTableDefinition, only_columns: set[str] | None = None) -> set[Op]:
    """Index names the manifest implies: `ix_<table>_<col>` for every
    `index=True` column (including the auto `tenant_id`), plus every declared
    IndexDefinition. `only_columns` restricts to per-column indexes on those
    columns -- used for the upgrade delta, where no IndexDefinition is new."""
    ops: set[Op] = set()
    for col in table.columns:
        if col.index and (only_columns is None or col.name in only_columns):
            ops.add(("index", table.name, f"ix_{table.name}_{col.name}"))
    if only_columns is None:
        ops |= {("index", table.name, idx.name) for idx in table.indexes}
    return ops


def _expected_delta(old: dict[str, Any], new: dict[str, Any]) -> tuple[set[Op], set[Op]]:
    """(upgrade ops, downgrade ops) the delta between two manifests implies,
    computed from the manifests alone (see module docstring)."""
    old_tables, new_tables = _tables(old), _tables(new)
    up: set[Op] = set()
    down: set[Op] = set()
    for name, table in new_tables.items():
        if name not in old_tables:
            up.add(("create_table", name, name))
            down.add(("drop_table", name, name))
            for _, t, idx in _index_ops(table):
                up.add(("create_index", t, idx))
                down.add(("drop_index", t, idx))
            continue
        added = {c.name for c in table.columns} - {c.name for c in old_tables[name].columns}
        for col in added:
            up.add(("add_column", name, col))
            down.add(("drop_column", name, col))
        for _, t, idx in _index_ops(table, only_columns=added):
            up.add(("create_index", t, idx))
            down.add(("drop_index", t, idx))
    return up, down


def _literal(node: ast.expr | None) -> str:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return "<non-literal>"


def _ops_in(func: ast.FunctionDef) -> list[Op]:
    """Every `op.<name>(...)` call in a migration function, as an Op."""
    found: list[Op] = []
    for node in ast.walk(func):
        if not (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "op"
        ):
            continue
        name, args = node.func.attr, node.args
        first = args[0] if args else None
        second = args[1] if len(args) > 1 else None
        if name in ("create_table", "drop_table"):
            found.append((name, _literal(first), _literal(first)))
        elif name in ("create_index", "drop_index"):
            found.append((name, _literal(second), _literal(first)))
        elif name == "add_column":
            col = second.args[0] if isinstance(second, ast.Call) and second.args else None
            found.append((name, _literal(first), _literal(col)))
        elif name == "drop_column":
            found.append((name, _literal(first), _literal(second)))
        else:
            found.append((name, _literal(first), "<unrecognised op>"))
    return found


def _migration_functions(path: Path) -> tuple[list[Op], list[Op], str | None, str | None]:
    tree = ast.parse(path.read_text(), filename=path.name)
    funcs = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
    assigns = {
        t.id: n.value
        for n in tree.body
        if isinstance(n, ast.Assign)
        for t in n.targets
        if isinstance(t, ast.Name)
    }

    def _rev(name: str) -> str | None:
        node = assigns.get(name)
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        return None

    return (
        _ops_in(funcs["upgrade"]),
        _ops_in(funcs["downgrade"]),
        _rev("revision"),
        _rev("down_revision"),
    )


# --- the database side ------------------------------------------------------

_ENV_PY = """\
from alembic import context

connection = context.config.attributes["connection"]
context.configure(connection=connection, target_metadata=None)
with context.begin_transaction():
    context.run_migrations()
"""


class _Sandbox:
    """A throwaway Alembic script location, bound to one Postgres schema."""

    def __init__(self, root: Path, dsn: str, schema: str) -> None:
        self.dsn, self.schema = dsn, schema
        self.script_dir = root / "alembic"
        self.versions_dir = self.script_dir / "versions"
        self.versions_dir.mkdir(parents=True)
        (self.script_dir / "env.py").write_text(_ENV_PY)

    def _engine(self):
        from sqlalchemy.ext.asyncio import create_async_engine

        return create_async_engine(
            self.dsn,
            hide_parameters=True,
            connect_args={"server_settings": {"search_path": self.schema}},
        )

    async def _with_conn(self, fn: Callable[[Any], Any]) -> Any:
        engine = self._engine()
        try:
            async with engine.begin() as conn:
                return await conn.run_sync(fn)
        finally:
            await engine.dispose()

    def run(self, fn: Callable[[Any], Any]) -> Any:
        return asyncio.run(self._with_conn(fn))

    def reset_schema(self) -> None:
        from sqlalchemy import text

        quoted = f'"{self.schema}"'

        def _reset(conn: Any) -> None:
            conn.execute(text(f"DROP SCHEMA IF EXISTS {quoted} CASCADE"))
            conn.execute(text(f"CREATE SCHEMA {quoted}"))

        self.run(_reset)

    def alembic(self, action: str, target: str) -> None:
        from alembic import command
        from alembic.config import Config

        def _do(conn: Any) -> None:
            cfg = Config()
            cfg.set_main_option("script_location", str(self.script_dir))
            cfg.attributes["connection"] = conn
            getattr(command, action)(cfg, target)

        self.run(_do)

    def columns(self) -> dict[str, dict[str, bool]]:
        """{table: {column: is_nullable}} for every table in the schema."""
        from sqlalchemy import text

        def _q(conn: Any) -> dict[str, dict[str, bool]]:
            rows = conn.execute(
                text(
                    "SELECT table_name, column_name, is_nullable FROM information_schema.columns "
                    "WHERE table_schema = :s"
                ),
                {"s": self.schema},
            )
            out: dict[str, dict[str, bool]] = {}
            for table, column, nullable in rows:
                out.setdefault(table, {})[column] = nullable == "YES"
            return out

        return self.run(_q)

    def indexes(self) -> set[tuple[str, str]]:
        from sqlalchemy import text

        def _q(conn: Any) -> set[tuple[str, str]]:
            rows = conn.execute(
                text("SELECT tablename, indexname FROM pg_indexes WHERE schemaname = :s"),
                {"s": self.schema},
            )
            return {(t, i) for t, i in rows}

        return self.run(_q)

    def ids(self, tables: list[str]) -> dict[str, set[str]]:
        from sqlalchemy import text

        def _q(conn: Any) -> dict[str, set[str]]:
            # Table names come from the fixture manifest, never from input,
            # and are quoted as identifiers.
            return {
                t: {r[0] for r in conn.execute(text(f'SELECT id FROM "{t}"'))}  # noqa: S608  # nosec B608 -- identifiers from the fixture manifest, quoted
                for t in tables
            }

        return self.run(_q)

    def insert_rows(self, tables: dict[str, PluginTableDefinition], per_table: int) -> int:
        from datetime import UTC, datetime

        from sqlalchemy import text

        samples: dict[str, Any] = {
            "String": "x",
            "Text": "x",
            "Integer": 1,
            "Float": 1.5,
            "Boolean": True,
            "DateTime": datetime.now(UTC),
        }

        def _ins(conn: Any) -> int:
            count = 0
            for table in tables.values():
                cols = [c.name for c in table.columns]
                for _ in range(per_table):
                    values: dict[str, Any] = {}
                    for col in table.columns:
                        base, _args, _kw = resolve_type_call(col.type)
                        # Strings are unique per row: the fixture declares a
                        # unique index, and a seed that collides with it is a
                        # fixture bug, not a finding.
                        if base in ("String", "Text"):
                            values[col.name] = f"row-{uuid.uuid4().hex[:8]}"
                        else:
                            values[col.name] = samples.get(base, "x")
                    values["id"] = str(uuid.uuid4())
                    values["tenant_id"] = "default"
                    col_sql = ", ".join(f'"{c}"' for c in cols)
                    bind_sql = ", ".join(f":{c}" for c in cols)
                    conn.execute(
                        text(f'INSERT INTO "{table.name}" ({col_sql}) VALUES ({bind_sql})'),  # noqa: S608  # nosec B608 -- identifiers from the fixture manifest, quoted
                        values,
                    )
                    count += 1
            return count

        return self.run(_ins)


def _assert_fresh_install(
    sandbox: _Sandbox, generate: Generate, manifest: dict[str, Any], report: TransitionReport
) -> None:
    tables = _tables(manifest)
    generated = generate(manifest, sandbox.versions_dir)
    if generated is None:
        raise TransitionAssertionError(1, "generator produced no migration for a fresh install")
    sandbox.alembic("upgrade", "head")

    columns = sandbox.columns()
    missing_tables = sorted(set(tables) - set(columns))
    if missing_tables:
        raise TransitionAssertionError(1, f"table(s) not created: {', '.join(missing_tables)}")
    for name, table in tables.items():
        missing = {c.name for c in table.columns} - set(columns[name])
        if missing:
            raise TransitionAssertionError(1, f"{name}: column(s) not created: {sorted(missing)}")
        if columns[name].get("tenant_id", True):
            raise TransitionAssertionError(
                1, f"{name}: tenant_id is missing or nullable (ADR-0001)"
            )

    expected_indexes = {(t, i) for table in tables.values() for _, t, i in _index_ops(table)}
    missing_idx = expected_indexes - sandbox.indexes()
    if missing_idx:
        raise TransitionAssertionError(1, f"index(es) not created: {sorted(missing_idx)}")
    if not tables or not expected_indexes:
        raise TransitionAssertionError(1, "fixture declares no tables or no indexes -- vacuous")
    report.say(
        f"migrations: (1) fresh install applied {len(tables)} table(s) / "
        f"{len(expected_indexes)} index(es), tenant_id NOT NULL on all {len(tables)}"
    )


def _assert_upgrade_is_delta(
    sandbox: _Sandbox,
    generate: Generate,
    old: dict[str, Any],
    new: dict[str, Any],
    report: TransitionReport,
) -> Path:
    before = {p.name: p.read_text() for p in sandbox.versions_dir.glob("*.py")}
    prior_head = plugin_migrations.get_current_head_revision(sandbox.versions_dir)
    generate(new, sandbox.versions_dir)
    after = {p.name: p.read_text() for p in sandbox.versions_dir.glob("*.py")}

    problems: list[str] = []
    rewritten = sorted(n for n in before if after.get(n) != before[n])
    added = sorted(set(after) - set(before))
    if rewritten:
        # Pre-#1513 this is how the full regeneration showed up: the delta's
        # revision id hashed the same table names as (1)'s, so the "new"
        # revision overwrote the applied one. Its ops are still diffed below,
        # so the message names what it would have done as well.
        problems.append(
            f"regeneration rewrote already-applied migration(s) {rewritten} instead of "
            "appending a new revision -- an applied migration must never change"
        )
    changed = added + rewritten
    if len(changed) != 1:
        raise TransitionAssertionError(
            2, "; ".join([*problems, f"expected exactly 1 new revision, got {added}"])
        )
    path = sandbox.versions_dir / changed[0]

    up, down, revision, down_revision = _migration_functions(path)
    if not rewritten and (down_revision != prior_head or revision in (None, prior_head)):
        problems.append(
            f"new revision {revision!r} does not chain onto the prior head {prior_head!r} "
            f"(down_revision={down_revision!r})"
        )
    expected_up, expected_down = _expected_delta(old, new)
    if not expected_up:
        raise TransitionAssertionError(2, "fixture manifests differ by nothing -- vacuous")
    for label, got, want in (("upgrade()", up, expected_up), ("downgrade()", down, expected_down)):
        if len(got) != len(set(got)):
            problems.append(f"{label} repeats an op: {got}")
        extra, lacking = sorted(set(got) - want), sorted(want - set(got))
        if extra:
            problems.append(f"{label} does more than the delta: {extra}")
        if lacking:
            problems.append(f"{label} is missing part of the delta: {lacking}")
    if problems:
        raise TransitionAssertionError(2, "; ".join(problems))
    report.say(
        f"migrations: (2) upgrade is exactly the delta -- upgrade() {len(up)} op(s), "
        f"downgrade() inverts exactly {len(down)}: {sorted(up)}"
    )
    return path


def _assert_data_survives(
    sandbox: _Sandbox, old: dict[str, Any], new: dict[str, Any], report: TransitionReport
) -> None:
    old_tables = _tables(old)
    names = sorted(old_tables)
    before = sandbox.ids(names)
    rows = sum(len(v) for v in before.values())
    if rows == 0:
        raise TransitionAssertionError(3, "no rows seeded -- vacuous")

    sandbox.alembic("upgrade", "head")
    added_cols = {(op[1], op[2]) for op in _expected_delta(old, new)[0] if op[0] == "add_column"}
    columns = sandbox.columns()
    absent = sorted(f"{t}.{c}" for t, c in added_cols if c not in columns.get(t, {}))
    if absent:
        raise TransitionAssertionError(3, f"upgrade did not add {absent}")
    if sandbox.ids(names) != before:
        raise TransitionAssertionError(3, "rows changed across the upgrade")

    sandbox.alembic("downgrade", "-1")
    columns = sandbox.columns()
    dropped = sorted(set(names) - set(columns))
    if dropped:
        raise TransitionAssertionError(
            3, f"downgrade dropped table(s) it did not create: {dropped} (#1511)"
        )
    if sandbox.ids(names) != before:
        raise TransitionAssertionError(3, "rows lost across the downgrade")
    lingering = sorted(f"{t}.{c}" for t, c in added_cols if c in columns.get(t, {}))
    if lingering:
        raise TransitionAssertionError(3, f"downgrade did not remove {lingering}")

    # Leave the installation at head, the state a real upgrade ends in.
    sandbox.alembic("upgrade", "head")
    report.say(
        f"migrations: (3) {rows} row(s) across {len(names)} table(s) survived upgrade and "
        "downgrade; downgrade dropped no table it did not create"
    )


def run_transitions(
    sandbox: _Sandbox,
    generate: Generate,
    old: dict[str, Any],
    new: dict[str, Any],
    rows_per_table: int = 2,
) -> TransitionReport:
    """Run (1) -> seed rows -> (2) -> (3) against `sandbox`'s schema.

    (3) applies (2)'s revision, so a failure in (2) makes (3) BLOCKED, not
    passed. It is not run, because its input is known to be wrong."""
    report = TransitionReport()
    sandbox.reset_schema()
    for stale in sandbox.versions_dir.glob("*.py"):
        stale.unlink()

    try:
        _assert_fresh_install(sandbox, generate, old, report)
        report.passed.append(1)
    except TransitionAssertionError as exc:
        report.failed[1] = str(exc)
        report.blocked += [2, 3]
        return report

    sandbox.insert_rows(_tables(old), rows_per_table)

    try:
        _assert_upgrade_is_delta(sandbox, generate, old, new, report)
        report.passed.append(2)
    except TransitionAssertionError as exc:
        report.failed[2] = str(exc)
        report.blocked.append(3)
        return report

    try:
        _assert_data_survives(sandbox, old, new, report)
        report.passed.append(3)
    except TransitionAssertionError as exc:
        report.failed[3] = str(exc)
    return report


# --------------------------------------------------------------------------
# Tests
# --------------------------------------------------------------------------


@pytest.fixture
def sandbox(tmp_path: Path):
    dsn = _pg_dsn()
    assert dsn is not None  # narrows for pyright; skipif already checked
    box = _Sandbox(tmp_path, dsn, f"plugin_mig_{uuid.uuid4().hex[:12]}")
    yield box
    from sqlalchemy import text

    box.run(lambda conn: conn.execute(text(f'DROP SCHEMA IF EXISTS "{box.schema}" CASCADE')))


def test_lane_is_real_postgres_and_isolated_to_the_sandbox_schema(sandbox: _Sandbox) -> None:
    """Sanity: without this, every other assertion in this file could be
    reading a database that is not Postgres, or a schema that is not ours."""
    from sqlalchemy import text

    sandbox.reset_schema()
    version, current_schema = sandbox.run(
        lambda conn: conn.execute(text("SELECT version(), current_schema()")).one()
    )
    assert version.startswith("PostgreSQL"), version
    assert current_schema == sandbox.schema


def test_three_transitions_pass_against_real_postgres(sandbox: _Sandbox) -> None:
    report = run_transitions(
        sandbox, plugin_migrations.generate_migration_for_plugin, _MANIFEST_V1, _manifest_v2()
    )
    assert report.failed == {}, report.failed
    assert report.passed == [1, 2, 3]
    assert report.blocked == []
    assert "applied 3 table(s) / 5 index(es)" in report.lines[0]


def test_second_consecutive_run_is_green(sandbox: _Sandbox) -> None:
    """The first run leaves its installation in place. The second meets it and
    must still be green."""
    generate = plugin_migrations.generate_migration_for_plugin
    first = run_transitions(sandbox, generate, _MANIFEST_V1, _manifest_v2())
    assert sandbox.columns(), "first run left nothing behind -- the re-run proves nothing"
    second = run_transitions(sandbox, generate, _MANIFEST_V1, _manifest_v2())
    assert (first.passed, first.failed) == ([1, 2, 3], {})
    assert (second.passed, second.failed) == ([1, 2, 3], {})


def test_full_regeneration_turns_exactly_assertion_2_red(
    sandbox: _Sandbox, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#1511 kept observable: the pre-#1513 generator treated every declared
    table as new on every run. `already_created_tables` is the function #1513
    introduced to stop that, so making it report nothing puts that behaviour
    back and changes nothing else."""
    monkeypatch.setattr(plugin_migrations, "already_created_tables", lambda _versions: set())
    report = run_transitions(
        sandbox, plugin_migrations.generate_migration_for_plugin, _MANIFEST_V1, _manifest_v2()
    )
    assert report.passed == [1]
    assert list(report.failed) == [2]
    assert report.blocked == [3]
    # Named for what #1511 actually did, not only for the id collision.
    assert "('create_table', 'cf_campaign', 'cf_campaign')" in report.failed[2]
    assert "('drop_table', 'cf_post', 'cf_post')" in report.failed[2]


def test_a_downgrade_that_drops_an_old_table_is_caught_by_assertion_2(
    sandbox: _Sandbox,
) -> None:
    """Mirror case for the downgrade direction on its own: an upgrade() that
    is exactly the delta, but a downgrade() that also drops a table the
    revision never created (#1511's data-loss half)."""
    real = plugin_migrations.generate_migration_for_plugin

    def _lossy(manifest: dict[str, Any], versions_dir: Path) -> Path | None:
        path = real(manifest, versions_dir)
        if path is not None and manifest["version"] == "1.1.0":
            header = "def downgrade() -> None:\n"
            src = path.read_text().replace(header, f"{header}    op.drop_table('cf_post')\n")
            path.write_text(src)
        return path

    report = run_transitions(sandbox, _lossy, _MANIFEST_V1, _manifest_v2())
    assert report.passed == [1]
    assert list(report.failed) == [2]
    assert "drop_table" in report.failed[2]
