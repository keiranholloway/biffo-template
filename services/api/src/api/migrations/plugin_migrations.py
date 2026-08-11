"""Alembic migration generator for plugin table definitions."""

from __future__ import annotations

import ast
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from alembic.script import ScriptDirectory

from ..models.plugin_table import (
    ColumnDefinition,
    PluginTableDefinition,
    resolve_type_call,
)


class MigrationScanError(RuntimeError):
    """Raised when an existing migration file in versions_dir cannot be
    parsed to determine which tables it already creates.

    Deliberately fails the whole generation (see `generate_migration_for_plugin`)
    rather than treating an unreadable file as creating nothing: silently
    under-counting "already applied" tables is exactly how a plugin upgrade
    could recreate a table with DuplicateTableError, or worse — chain a
    downgrade that drops a table this migration never actually created
    (issue #1511). A failed generation is recoverable; a wrong guess here
    is not.
    """


def generate_migration_name(table_name: str) -> str:
    """Generate a deterministic, human-readable migration name.

    Args:
        table_name: The table name to include in the migration name.

    Returns:
        A migration name like 'add_roles_table_abc123'.
    """
    short_hash = hashlib.sha256(table_name.encode()).hexdigest()[:8]
    return f"add_{table_name}_table_{short_hash}"


def _short_sha256(input_str: str, length: int = 8) -> str:
    """Compute a short hex digest of SHA-256 for deterministic IDs."""
    return hashlib.sha256(input_str.encode()).hexdigest()[:length]


def get_current_head_revision(versions_dir: Path) -> str | None:
    """Return the current Alembic head revision id for versions_dir, or None
    if the chain is empty.

    Delegates to Alembic's own ScriptDirectory rather than hand-parsing
    revision/down_revision assignments out of each file, so branching/merge
    edge cases raise the same errors `alembic upgrade head` would raise
    instead of silently picking the wrong parent.

    Args:
        versions_dir: Directory containing Alembic version files.
    """
    # `dir` normally points at the folder holding script.py.mako alongside a
    # versions/ subfolder; version_locations overrides where version files are
    # actually read from, so this works whether or not versions_dir's parent
    # looks like a real Alembic script location (e.g. a bare tempdir in tests).
    script = ScriptDirectory(
        str(versions_dir.parent), version_locations=[str(versions_dir)]
    )
    return script.get_current_head()


def _compute_plugin_revision(
    manifest: dict[str, Any], tables: list[PluginTableDefinition]
) -> str:
    """Deterministic revision id for a plugin's current table set.

    Used both to name the generated migration and, by sync_plugin_migrations,
    to detect that a plugin's migration was already generated so re-running
    discovery on every db-init doesn't create duplicate migrations/heads.
    """
    return _short_sha256(
        f"{manifest.get('name', '')}-{'-'.join(t.name for t in tables)}"
    )


def _table_name_arg(call: ast.Call) -> ast.expr | None:
    """The AST node holding an `op.create_table(...)` call's table name,
    however it was passed.

    Alembic's real signature is `create_table(table_name, *columns, **kw)` —
    `table_name` is an ordinary parameter, callable positionally (as every
    migration this generator writes does) or by keyword
    (`op.create_table(table_name='x', ...)`, which is valid Python a
    hand-written or vendored migration could use). Checking only `call.args[0]`
    would silently treat the keyword form as "no table name" and skip it
    without raising — under-counting "already applied" tables exactly the way
    `MigrationScanError` exists to prevent. Returns None only when neither
    form is present, i.e. the call genuinely doesn't name a table.
    """
    if call.args:
        return call.args[0]
    for kw in call.keywords:
        if kw.arg == "table_name":
            return kw.value
    return None


def _tables_created_in_source(source: str, filename: str) -> set[str]:
    """Return every table name passed to an `op.create_table(...)` call found
    in `source`, positionally or via `table_name=`.

    Parses with `ast` rather than regex, so a table name embedding a quote
    or parenthesis still resolves correctly (mirrors the injection-safety
    reasoning in `_column_to_alembic_def`'s docstring) and so a call whose
    table name isn't a plain string literal is caught explicitly rather than
    silently contributing nothing to the result.
    """
    try:
        tree = ast.parse(source, filename=filename)
    except SyntaxError as exc:
        raise MigrationScanError(
            f"Could not parse existing migration {filename!r} as Python: {exc}"
        ) from exc

    names: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not (isinstance(func, ast.Attribute) and func.attr == "create_table"):
            continue
        if not (isinstance(func.value, ast.Name) and func.value.id == "op"):
            continue
        name_arg = _table_name_arg(node)
        if isinstance(name_arg, ast.Constant) and isinstance(name_arg.value, str):
            names.add(name_arg.value)
        else:
            raise MigrationScanError(
                f"{filename!r} calls op.create_table() with a table name that "
                "isn't a plain string literal — cannot determine what table it creates."
            )
    return names


def already_created_tables(versions_dir: Path) -> set[str]:
    """Union of every table name any existing migration file in `versions_dir`
    already creates (via `op.create_table(...)`).

    This is how `generate_migration_for_plugin` computes the delta a plugin
    upgrade should actually emit (issue #1511): without it, a plugin that
    gained one table regenerated its ENTIRE table set on every upgrade,
    which fails wherever the plugin is already installed
    (`asyncpg.exceptions.DuplicateTableError`) and whose `downgrade()` would
    drop every table the plugin owns — including ones holding live data the
    upgrade never touched.

    Matches purely by table name across *every* file in `versions_dir`, not
    by any notion of "the same plugin" — nothing in a generated migration
    currently records which plugin produced it (the revision id is a hash of
    table names, not a plugin marker), and table names are the estate's only
    real namespace: two plugins declaring the same table name would collide
    at the database regardless of this generator's bookkeeping. Raises
    `MigrationScanError` (via `_tables_created_in_source`) rather than
    guessing when an existing file can't be read this way.
    """
    names: set[str] = set()
    for path in sorted(versions_dir.glob("*.py")):
        names |= _tables_created_in_source(path.read_text(), path.name)
    return names


def parse_plugin_tables_from_manifest(
    manifest: dict[str, Any],
) -> list[PluginTableDefinition]:
    """Parse table definitions from a plugin manifest dictionary.

    Args:
        manifest: The parsed plugin manifest JSON containing a 'tables' key.

    Returns:
        List of PluginTableDefinition instances.
    """
    tables_data = manifest.get("tables", [])
    tables: list[PluginTableDefinition] = []
    for table_data in tables_data:
        tables.append(PluginTableDefinition(**table_data))
    return tables


def _column_to_alembic_def(col: "ColumnDefinition") -> str:
    """Convert a ColumnDefinition to an Alembic sa.Column() string.

    Handles parameterized types like String(36) correctly by producing
    sa.String('36') rather than the broken sa.String(36)(), and renders
    every value via repr() so names/params containing quotes can't break
    out of the generated string (see resolve_type_call for the safe parse).
    """
    parts = [repr(col.name)]

    base_type, args, kwargs = resolve_type_call(col.type)
    arg_parts = [repr(a) for a in args] + [f"{k}={v!r}" for k, v in kwargs.items()]
    parts.append(f"sa.{base_type}({', '.join(arg_parts)})")

    if col.primary_key:
        parts.append("primary_key=True")
    if not col.nullable:
        parts.append("nullable=False")
    return ", ".join(parts)


def _build_create_table_statement(table: PluginTableDefinition) -> str:
    """Build an Alembic create_table statement from a PluginTableDefinition."""
    # Build column definitions from the table's columns (includes auto columns)
    cols = []
    for col in table.columns:
        cols.append(f"sa.Column({_column_to_alembic_def(col)})")

    cols_str = ",\n        ".join(cols)

    # Build PrimaryKeyConstraint if any column is marked primary_key
    pk_cols = [c.name for c in table.columns if c.primary_key]
    pk_constraint = ""
    if pk_cols:
        pk_constraint = (
            f",\n        sa.PrimaryKeyConstraint({', '.join(repr(c) for c in pk_cols)})"
        )

    stmt = f"""op.create_table(
        {table.name!r},
        {cols_str}{pk_constraint},
    )"""
    return stmt


def _build_index_statements(table: PluginTableDefinition) -> list[tuple[str, str]]:
    """Build (create, drop) Alembic index statement pairs for indexed columns
    and IndexDefinitions.

    Returning both statements together (built from the same structured
    idx_name/table_name values) avoids re-parsing generated source text to
    recover the drop statement, which is fragile to any change in the
    create-statement's format or an index/table name containing a quote.
    """
    statements: list[tuple[str, str]] = []

    # Auto-index columns marked with index=True
    for col in table.columns:
        if col.index:
            idx_name = f"ix_{table.name}_{col.name}"
            create = (
                f"op.create_index({idx_name!r}, {table.name!r}, "
                f"[{col.name!r}], unique=False)"
            )
            drop = f"op.drop_index({idx_name!r}, {table.name!r})"
            statements.append((create, drop))

    # Explicit IndexDefinitions
    for idx in table.indexes:
        unique_flag = "True" if idx.unique else "False"
        col_list = ", ".join(repr(c) for c in idx.columns)
        create = (
            f"op.create_index({idx.name!r}, {table.name!r}, "
            f"[{col_list}], unique={unique_flag})"
        )
        drop = f"op.drop_index({idx.name!r}, {table.name!r})"
        statements.append((create, drop))

    return statements


def generate_migration_for_plugin(
    manifest: dict[str, Any],
    versions_dir: Path,
) -> Path | None:
    """Generate an Alembic migration file for the tables a plugin manifest
    declares that no earlier migration in `versions_dir` already creates.

    Only the delta is emitted — issue #1511. Before this, every call emitted
    *every* table in the manifest, so a plugin that gained one table
    regenerated a migration recreating tables previous migrations had
    already applied: `alembic upgrade` failed with `DuplicateTableError`
    everywhere the plugin was already installed, and the accompanying
    `downgrade()` dropped every table the plugin owns — including ones
    holding live data this migration never touched. Real case: upgrading
    `biffo-plugin-marketing` by one table (`marketing_channel`) generated a
    migration recreating all six of its tables.

    Known limitation, pre-existing and unchanged by this fix: the delta is
    computed by table NAME only. A manifest change to an *already-migrated*
    table's columns or indexes (same table name, different shape) produces no
    migration and no error, on the normal `sync_plugin_migrations` path, both
    before and after issue #1511 — the old revision hash was also derived
    from table names only, so a name-preserving schema change never altered
    it either. Detecting that is a materially different feature (column-level
    diffing against a prior migration's declared columns) and is out of
    scope here; it is not the destructive-downgrade defect this fix closes.

    Args:
        manifest: The parsed plugin manifest JSON.
        versions_dir: Directory where Alembic stores migration files.

    Returns:
        Path to the generated migration file, or None if every table the
        manifest declares is already created by an earlier migration in
        `versions_dir` — nothing to do, not an error.

    Raises:
        ValueError: the manifest declares no tables, or an existing
            migration file in `versions_dir` can't be parsed to determine
            what it already creates (`MigrationScanError`) — refusing here
            is deliberate: generating a migration without knowing what
            already exists risks a `downgrade()` that drops a table this
            migration never created.
    """
    tables = parse_plugin_tables_from_manifest(manifest)
    if not tables:
        raise ValueError(
            f"Plugin '{manifest.get('name', '<unknown>')}' has no tables to migrate."
        )

    try:
        already_created = already_created_tables(versions_dir)
    except MigrationScanError as exc:
        raise ValueError(
            f"Refusing to generate a migration for plugin "
            f"'{manifest.get('name', '<unknown>')}': {exc} Fix or remove the "
            "unreadable migration before retrying."
        ) from exc

    new_tables = [t for t in tables if t.name not in already_created]
    if not new_tables:
        # Every table this manifest declares already has a migration —
        # correctly a no-op (mirrors the "table set unchanged" case), not a
        # forced empty migration.
        return None
    tables = new_tables

    # Generate a unique migration name — from the delta being emitted, not
    # the plugin's full table set, so the filename/migration name describe
    # what this migration actually does.
    table_names = "_".join(t.name for t in tables)
    migration_name = generate_migration_name(table_names)

    # Build migration content
    revision = _compute_plugin_revision(manifest, tables)
    # Chain onto whatever's actually at the head of versions_dir right now,
    # instead of hard-coding None — otherwise every generated plugin
    # migration forks its own second head instead of appending to the chain
    # (breaks "alembic upgrade head" / the "existing migrations are not
    # affected — new ones are appended" acceptance criterion).
    down_revision = get_current_head_revision(versions_dir)

    # Build CREATE TABLE statements for upgrade
    create_statements = []
    drop_statements = []
    index_statements: list[tuple[str, str]] = []
    for table in tables:
        create_stmt = _build_create_table_statement(table)
        drop_stmt = f"op.drop_table({table.name!r})"
        create_statements.append(create_stmt)
        drop_statements.append(drop_stmt)
        # Collect (create, drop) index statement pairs
        index_statements.extend(_build_index_statements(table))

    # Plain "\n" join — every line gets its function-body indent added exactly
    # once, below, by the per-line "    {line}" prefixing. Joining with
    # "\n    " here as well used to double-indent every statement after the
    # first, which is invisible with a single table (join has nothing to
    # join) but produces an IndentationError as soon as a manifest declares
    # more than one table.
    create_block = "\n".join(create_statements)
    drop_block = "\n".join(drop_statements)

    # Index DDL goes after CREATE TABLE in upgrade, before DROP TABLE in downgrade
    index_up_lines = [f"    {create}" for create, _ in index_statements]
    index_down_lines = [f"    {drop}" for _, drop in index_statements]

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]

    # Build upgrade body
    upgrade_body_lines = [
        '    """Upgrade: create plugin tables."""',
    ]
    for line in create_block.split("\n"):
        upgrade_body_lines.append(f"    {line}")
    upgrade_body_lines.extend(index_up_lines)

    # Build downgrade body
    downgrade_body_lines = [
        '    """Downgrade: drop plugin tables."""',
    ]
    downgrade_body_lines.extend(index_down_lines)
    for line in drop_block.split("\n"):
        downgrade_body_lines.append(f"    {line}")

    upgrade_body = "\n".join(upgrade_body_lines)
    downgrade_body = "\n".join(downgrade_body_lines)

    migration_content = f"""\"\"\"{migration_name}

Revision ID: {revision}
Revises: {down_revision or ""}
Create Date: {now}

\"\"\"
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '{revision}'
down_revision = {down_revision!r}
branch_labels = None
depends_on = None


def upgrade() -> None:
{upgrade_body}


def downgrade() -> None:
{downgrade_body}
"""

    # Write migration file
    filename = f"{revision}_{migration_name}.py"
    migration_path = versions_dir / filename
    migration_path.write_text(migration_content)
    return migration_path


def sync_plugin_migrations(
    versions_dir: Path,
    services_root: Path | None = None,
    only: set[str] | None = None,
) -> list[Path]:
    """Discover installed plugins and generate any migration files they're
    still missing, chaining each onto the current head in turn.

    The real call site is `services/api/scripts/generate_plugin_migrations.py`,
    invoked by the Node CLI at `biffo plugin install`/`upgrade`/`sync-migrations`
    time, writing into the real, git-committed versions/ directory. This
    function's idempotency guarantee (below) only holds when versions_dir is
    a persistent, git-tracked directory — it does NOT hold against a
    directory that's recreated on every call. (That was the previous, buggy
    design: main.py's `_run_db_init()` used to call this against a fresh
    `/tmp` copy on every Lambda invocation, so a plugin's migration was
    silently regenerated with a different down_revision on every deploy,
    corrupting the revision graph — see ADR-0003's implementation note.)

    Idempotent — a plugin whose declared tables are all already created by an
    earlier migration is skipped, so calling this against a persistent
    versions_dir doesn't generate duplicate migrations or fork new heads.
    Plugins with no tables are skipped (nothing to migrate).

    Delegates the "is there anything new" question entirely to
    `generate_migration_for_plugin` (it returns None when there isn't) rather
    than pre-checking via a revision computed from the plugin's *full*
    current table set, as an earlier version of this function did. That
    pre-check's hash only ever matched a file generated from the same full
    set — so the first time a plugin's table set changed, the hash permanently
    stopped matching (the on-disk file's revision is now hashed from the
    *delta* tables only, not the full set — see `generate_migration_for_plugin`),
    silently defeating the fast path forever after for that plugin. It still
    produced correct output (`generate_migration_for_plugin` independently
    recomputes the delta and correctly no-ops), just via a full
    `already_created_tables` re-scan on every call instead of an O(1) glob —
    correctness was never at risk, only the shortcut (issue #1511 review).

    Args:
        versions_dir: Directory where Alembic stores migration files.
        services_root: Passed through to discover_plugin_manifests; None uses
            its default (the monorepo's services/ directory).
        only: Restrict to these plugin names; None processes every
            discovered plugin.

    Returns:
        Paths to any newly generated migration files, in the order applied.
    """
    from ..plugins import discover_plugin_manifests

    generated: list[Path] = []
    for manifest in discover_plugin_manifests(services_root):
        if only is not None and manifest.get("name") not in only:
            continue
        tables = parse_plugin_tables_from_manifest(manifest)
        if not tables:
            continue
        result = generate_migration_for_plugin(manifest, versions_dir)
        if result is not None:
            generated.append(result)
    return generated
