"""Alembic migration generator for plugin table definitions."""

from __future__ import annotations

import ast
import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, NamedTuple

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
    script = ScriptDirectory(str(versions_dir.parent), version_locations=[str(versions_dir)])
    return script.get_current_head()


def _compute_plugin_revision(manifest: dict[str, Any], delta_labels: list[str]) -> str:
    """Deterministic revision id for the delta a migration is about to emit.

    Used both to name the generated migration and, by sync_plugin_migrations,
    to detect that a plugin's migration was already generated so re-running
    discovery on every db-init doesn't create duplicate migrations/heads.

    `delta_labels` used to always be the delta tables' names; it now also
    covers column-addition deltas (`"<table>.<column>"`, see
    `generate_migration_for_plugin`), so a table-only upgrade and a
    column-only upgrade for the same plugin never collide on the same
    revision id.
    """
    return _short_sha256(f"{manifest.get('name', '')}-{'-'.join(delta_labels)}")


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


class ColumnSnapshot(NamedTuple):
    """A column's shape as recovered from an existing migration file — the
    same three facts `generate_migration_for_plugin` needs to decide whether
    a manifest's column is new, unchanged, or a change it must refuse to
    guess at (removed, retyped, nullability changed).

    `type_tuple` is `resolve_type_call`'s own (base_type, args, kwargs) —
    reused on both sides of the diff (see `_diff_table_columns`) so
    'String(36)' and a parsed `sa.String(36)` compare equal without a second,
    string-based notion of "the same type".
    """

    type_tuple: tuple[str, list[Any], dict[str, Any]]
    nullable: bool
    primary_key: bool


def _render_type_tuple(type_node: ast.expr) -> tuple[str, list[Any], dict[str, Any]] | None:
    """Recover a `resolve_type_call`-shaped tuple from the AST node an
    existing migration passed as an `sa.Column(...)` call's type argument
    (e.g. the `sa.String(36)` in `sa.Column('x', sa.String(36))`).

    Only an `sa.Type(...)`/`Type(...)` **call** is accepted — the only shape
    `_column_to_alembic_def` ever generates (always with parens, even for a
    zero-arg type like `sa.Boolean()`) — and only with literal argument
    values (via `ast.literal_eval`, the same restriction `resolve_type_call`
    places on the manifest side). Anything else, including a bare
    `sa.String` reference or a local variable/constant standing in for a
    type, returns None rather than a guess: neither form is something this
    generator ever writes, so a migration using one is hand-written in a
    shape we can't safely attribute a type to. The caller treats None the
    same as any other unparseable column (§ don't guess).
    """
    if not isinstance(type_node, ast.Call):
        return None
    func = type_node.func
    if isinstance(func, ast.Attribute):
        type_name = func.attr
    elif isinstance(func, ast.Name):
        type_name = func.id
    else:
        return None
    try:
        args = [ast.literal_eval(a) for a in type_node.args]
        kwargs = {kw.arg: ast.literal_eval(kw.value) for kw in type_node.keywords if kw.arg}
    except ValueError:
        return None
    return type_name, args, kwargs


def _parse_sa_column_call(node: ast.Call) -> tuple[str, ColumnSnapshot] | None:
    """Extract (name, ColumnSnapshot) from an `sa.Column(...)` AST call node,
    in the exact shape `_column_to_alembic_def` generates:
    `sa.Column('name', sa.Type(args...), [primary_key=True], [nullable=False])`.

    Returns None if the call doesn't match that shape closely enough to read
    safely — a hand-written migration's column, a name/type that isn't a
    literal, or a type expression `_render_type_tuple` can't evaluate.
    Callers treat None the same as "this table's columns are unknown", never
    as "this column doesn't exist" — the two are not the same fact, and only
    the second is safe to act on.
    """
    if len(node.args) < 2:
        return None
    name_node, type_node = node.args[0], node.args[1]
    if not (isinstance(name_node, ast.Constant) and isinstance(name_node.value, str)):
        return None
    type_tuple = _render_type_tuple(type_node)
    if type_tuple is None:
        return None

    primary_key = False
    nullable = True
    for kw in node.keywords:
        if kw.arg == "primary_key" and isinstance(kw.value, ast.Constant):
            primary_key = bool(kw.value.value)
        elif kw.arg == "nullable" and isinstance(kw.value, ast.Constant):
            nullable = bool(kw.value.value)
    return name_node.value, ColumnSnapshot(type_tuple, nullable, primary_key)


def _sa_call_name(node: ast.AST) -> str | None:
    """The dotted call name of an AST Call node's func, e.g. 'op.create_table'
    or 'op.add_column' — None for anything else."""
    if not isinstance(node, ast.Call):
        return None
    func = node.func
    if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
        return f"{func.value.id}.{func.attr}"
    return None


def _columns_created_in_source(
    source: str, filename: str
) -> dict[str, dict[str, ColumnSnapshot] | None]:
    """Return, per table name, the columns an `op.create_table(...)` or
    `op.add_column(...)` call in `source` is known to add — or None if a
    call touching that table exists but its columns could not be read
    (see `_parse_sa_column_call`).

    A table mapped to None means "this table's columns are not safely
    knowable from what's on disk", which `generate_migration_for_plugin`
    must treat as a reason to stop and say so, not as "no columns" (that
    would make every one of the table's manifest columns look newly added
    and risk a duplicate `ADD COLUMN`). Once a table maps to None it stays
    None for the rest of this file's scan — a later, readable call can't
    un-poison an earlier unreadable one, because we still don't know what
    that earlier call actually did.

    Raises `MigrationScanError` only when `source` itself isn't parseable —
    same failure `_tables_created_in_source` raises for, and for the same
    reason (a whole-file failure risks under-counting what already exists).
    """
    try:
        tree = ast.parse(source, filename=filename)
    except SyntaxError as exc:
        raise MigrationScanError(
            f"Could not parse existing migration {filename!r} as Python: {exc}"
        ) from exc

    result: dict[str, dict[str, ColumnSnapshot] | None] = {}
    for node in ast.walk(tree):
        call_name = _sa_call_name(node)
        if call_name not in ("op.create_table", "op.add_column"):
            continue
        assert isinstance(node, ast.Call)  # narrowed by _sa_call_name above

        if call_name == "op.create_table":
            name_arg = _table_name_arg(node)
            column_nodes = [a for a in node.args if a is not name_arg]
        else:  # op.add_column(table_name, column, ...)
            if len(node.args) >= 2:
                name_arg, column_nodes = node.args[0], [node.args[1]]
            else:
                name_arg, column_nodes = None, []
                for kw in node.keywords:
                    if kw.arg == "table_name":
                        name_arg = kw.value
                    elif kw.arg == "column":
                        column_nodes = [kw.value]

        if not (isinstance(name_arg, ast.Constant) and isinstance(name_arg.value, str)):
            # Table name itself isn't a literal — _tables_created_in_source
            # already raises MigrationScanError for op.create_table in this
            # shape; for op.add_column it's not fatal to table discovery, but
            # we can't attribute the column(s) to anything, so skip them.
            continue
        table_name = name_arg.value

        if result.get(table_name, {}) is None:
            continue  # already poisoned for this table — see docstring

        columns: dict[str, ColumnSnapshot] = dict(result.get(table_name) or {})
        poisoned = False
        for col_node in column_nodes:
            if not (isinstance(col_node, ast.Call) and _sa_call_name(col_node) == "sa.Column"):
                continue
            parsed = _parse_sa_column_call(col_node)
            if parsed is None:
                poisoned = True
                break
            col_name, snapshot = parsed
            columns[col_name] = snapshot

        result[table_name] = None if poisoned else columns

    return result


def already_created_columns(versions_dir: Path) -> dict[str, dict[str, ColumnSnapshot] | None]:
    """Union, across every existing migration file, of the columns each
    already-created table is known to have — the column-level counterpart of
    `already_created_tables`, and how `generate_migration_for_plugin` decides
    whether a manifest's column is new, unchanged, or something it must
    refuse to guess at.

    A table absent from the result was never touched by a readable
    `op.create_table`/`op.add_column` call at all; a table mapped to `None`
    was touched but its columns could not be read (see
    `_columns_created_in_source`). Callers must not conflate the two with
    "no columns exist" — both mean "unknown", and only a table this scan
    never saw at all is one `generate_migration_for_plugin` will already have
    excluded via `already_created_tables` (a table it doesn't know exists is
    a new table, not a column question).
    """
    merged: dict[str, dict[str, ColumnSnapshot] | None] = {}
    for path in sorted(versions_dir.glob("*.py")):
        scanned = _columns_created_in_source(path.read_text(), path.name)
        for table_name, columns in scanned.items():
            already_poisoned = table_name in merged and merged[table_name] is None
            if already_poisoned or columns is None:
                merged[table_name] = None
                continue
            existing = merged.get(table_name) or {}
            merged[table_name] = {**existing, **columns}
    return merged


@dataclass
class ColumnDiff:
    """The result of comparing a manifest table's declared columns against
    what existing migrations show the instance already has.

    `unknown` covers both "this table's columns can't be read at all" (a
    single flag on the diff, since nothing about which manifest columns are
    involved is knowable in that case) and, independently, any individual
    manifest column whose *default* can't be diffed (see
    `_diff_table_columns` — `ColumnDefinition.default` is never rendered by
    `_column_to_alembic_def`, so it can never be recovered from a migration
    either; treating a default-only manifest edit as silently fine would be
    exactly the unearned "unchanged" conclusion issue #1539 is about).
    """

    added: list[ColumnDefinition] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    changed: list[str] = field(default_factory=list)
    unknown: bool = False


def _diff_table_columns(
    table: PluginTableDefinition, known: dict[str, ColumnSnapshot] | None
) -> ColumnDiff:
    """Compare `table`'s manifest columns against `known` (this table's
    columns as already-applied migrations show them).

    Never guesses: a column present in `known` but not in the manifest is
    `removed`; a column present in both whose type/nullable disagree is
    `changed`; a column in the manifest only is `added`. `known=None` means
    the table's existing columns could not be read at all — the whole
    comparison is `unknown`, not "everything must be new".
    """
    if known is None:
        return ColumnDiff(unknown=True)

    manifest_cols = {c.name: c for c in table.columns}
    diff = ColumnDiff()

    for name in known:
        if name not in manifest_cols:
            diff.removed.append(name)

    for name, col in manifest_cols.items():
        existing = known.get(name)
        if existing is None:
            diff.added.append(col)
            continue
        type_tuple = resolve_type_call(col.type)
        if type_tuple != existing.type_tuple or col.nullable != existing.nullable:
            diff.changed.append(name)

    return diff


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
        pk_constraint = f",\n        sa.PrimaryKeyConstraint({', '.join(repr(c) for c in pk_cols)})"

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
            create = f"op.create_index({idx_name!r}, {table.name!r}, [{col.name!r}], unique=False)"
            drop = f"op.drop_index({idx_name!r}, {table.name!r})"
            statements.append((create, drop))

    # Explicit IndexDefinitions
    for idx in table.indexes:
        unique_flag = "True" if idx.unique else "False"
        col_list = ", ".join(repr(c) for c in idx.columns)
        create = (
            f"op.create_index({idx.name!r}, {table.name!r}, [{col_list}], unique={unique_flag})"
        )
        drop = f"op.drop_index({idx.name!r}, {table.name!r})"
        statements.append((create, drop))

    return statements


def _build_add_column_statements(
    table_name: str, columns: list[ColumnDefinition]
) -> tuple[list[str], list[str], list[tuple[str, str]]]:
    """Build (add, drop) Alembic column statement lists plus index (create,
    drop) pairs for columns being added to an *already-existing* table.

    Mirrors `_build_create_table_statement`/`_build_index_statements` but for
    `op.add_column(...)` rather than `op.create_table(...)` — this is the
    "column added" half of issue #1539: `generate_migration_for_plugin` calls
    this for a table already in `already_created_tables` whose manifest
    columns include one `already_created_columns` doesn't know about yet.
    """
    add_statements = [
        f"op.add_column({table_name!r}, sa.Column({_column_to_alembic_def(col)}))"
        for col in columns
    ]
    drop_statements = [f"op.drop_column({table_name!r}, {col.name!r})" for col in columns]

    index_statements: list[tuple[str, str]] = []
    for col in columns:
        if col.index:
            idx_name = f"ix_{table_name}_{col.name}"
            create = f"op.create_index({idx_name!r}, {table_name!r}, [{col.name!r}], unique=False)"
            drop = f"op.drop_index({idx_name!r}, {table_name!r})"
            index_statements.append((create, drop))

    return add_statements, drop_statements, index_statements


def generate_migration_for_plugin(
    manifest: dict[str, Any],
    versions_dir: Path,
) -> Path | None:
    """Generate an Alembic migration file for what a plugin manifest declares
    that no earlier migration in `versions_dir` already accounts for —
    tables it doesn't yet have, and additive columns on tables it does.

    Table-level delta only emitted — issue #1511. Before that fix, every call
    emitted *every* table in the manifest, so a plugin that gained one table
    regenerated a migration recreating tables previous migrations had
    already applied: `alembic upgrade` failed with `DuplicateTableError`
    everywhere the plugin was already installed, and the accompanying
    `downgrade()` dropped every table the plugin owns — including ones
    holding live data this migration never touched. Real case: upgrading
    `biffo-plugin-marketing` by one table (`marketing_channel`) generated a
    migration recreating all six of its tables.

    Column-level delta added — issue #1539. Before this, an already-migrated
    table's column changes were invisible: the delta was computed by table
    NAME only, so a plugin that added, removed or retyped a column on an
    existing table produced no migration and no error — reported as
    "table set unchanged", a conclusion the table-only comparison never
    earned. Core builds the plugin's SQLAlchemy model from the manifest
    regardless, so the model then carried a column the database lacked, and
    every query touching it failed at runtime with `UndefinedColumn`. Real
    case: refreshing `biffo-plugin-marketing` into `tabsii-platform` after it
    added `marketing_channel.publish_url` (tabsii-platform#900).

    What's covered now, per already-migrated table:
    - **column added** (in the manifest, not in `already_created_columns`):
      an `op.add_column(...)` migration is generated, typed from the
      manifest — unless the added column is `primary_key=True`, which needs
      a manual migration (adding a PK to an existing table isn't a plain
      ADD COLUMN) and is treated the same as a removal/retype below.
    - **column removed, retyped, or nullability changed**: this function
      refuses to guess and raises `ValueError` naming the plugin, table and
      column(s) — a wrong `ALTER`/`DROP` is worse than no migration, and
      these need a human decision about existing rows.
    - **a table's existing columns can't be determined** from what's on disk
      (e.g. a hand-written migration whose `op.create_table`/`op.add_column`
      shape this scanner doesn't recognise): also refused, for the same
      reason — silence here is exactly the unearned "unchanged" this issue
      is about, so an unreadable prior migration must stop the generator,
      not be treated as "no columns to compare".

    Known limitations, still out of scope after this fix:
    - **Index changes** (`ColumnDefinition.index`/`IndexDefinition` on an
      existing column) are not diffed — only a brand-new column's own
      `index=True` is applied. A manifest that adds an index to an
      already-migrated column produces no migration and no error.
    - **`ColumnDefinition.default`** is never diffed, because it was never
      emitted by `_column_to_alembic_def` in the first place — there is
      nothing in a generated migration to compare it against. A
      default-only manifest edit is invisible here exactly as it was before.
    - **Composite `IndexDefinition`s spanning old and new columns** are not
      regenerated when a table gains a column — only per-column
      `index=True` on the added column itself is handled.

    Args:
        manifest: The parsed plugin manifest JSON.
        versions_dir: Directory where Alembic stores migration files.

    Returns:
        Path to the generated migration file, or None if the manifest's
        tables and columns are all already accounted for by earlier
        migrations in `versions_dir` — nothing to do, not an error.

    Raises:
        ValueError: the manifest declares no tables; an existing migration
            file in `versions_dir` can't be parsed to determine what it
            already creates (`MigrationScanError`) — refusing here is
            deliberate, generating a migration without knowing what already
            exists risks a `downgrade()` that drops a table this migration
            never created; or an already-migrated table has a column
            removed, retyped, nullability-changed, or otherwise
            undeterminable — see "What's covered now" above.
    """
    tables = parse_plugin_tables_from_manifest(manifest)
    if not tables:
        raise ValueError(f"Plugin '{manifest.get('name', '<unknown>')}' has no tables to migrate.")

    try:
        already_created = already_created_tables(versions_dir)
        known_columns = already_created_columns(versions_dir)
    except MigrationScanError as exc:
        raise ValueError(
            f"Refusing to generate a migration for plugin "
            f"'{manifest.get('name', '<unknown>')}': {exc} Fix or remove the "
            "unreadable migration before retrying."
        ) from exc

    new_tables = [t for t in tables if t.name not in already_created]
    existing_tables = [t for t in tables if t.name in already_created]

    # Column-level diff for every table this manifest declares that's
    # already migrated. `blocking` collects every reason this function must
    # refuse rather than guess; `column_additions` collects only the safe,
    # additive changes (see the docstring's "What's covered now").
    blocking: list[str] = []
    column_additions: list[tuple[str, list[ColumnDefinition]]] = []
    for table in existing_tables:
        diff = _diff_table_columns(table, known_columns.get(table.name))
        if diff.unknown:
            blocking.append(
                f"table '{table.name}': its existing columns could not be determined "
                "from the migrations already in versions_dir, so column-level changes "
                "can't be checked safely"
            )
            continue
        if diff.removed:
            blocking.append(
                f"table '{table.name}': column(s) removed from the manifest: "
                f"{', '.join(sorted(diff.removed))}"
            )
        if diff.changed:
            blocking.append(
                f"table '{table.name}': column(s) retyped or had their nullability "
                f"changed: {', '.join(sorted(diff.changed))}"
            )
        pk_additions = sorted(c.name for c in diff.added if c.primary_key)
        if pk_additions:
            blocking.append(
                f"table '{table.name}': column(s) added with primary_key=True: "
                f"{', '.join(pk_additions)} — adding a primary key to an existing "
                "table is not a plain ADD COLUMN"
            )
        plain_additions = [c for c in diff.added if not c.primary_key]
        if plain_additions:
            column_additions.append((table.name, plain_additions))

    if blocking:
        raise ValueError(
            f"Refusing to guess a migration for plugin '{manifest.get('name', '<unknown>')}': "
            + "; ".join(blocking)
            + ". These need a human decision about existing rows — write the migration "
            "by hand."
        )

    if not new_tables and not column_additions:
        # Every table this manifest declares already has a migration, and
        # every already-migrated table's columns match the manifest exactly
        # — correctly a no-op, not a forced empty migration.
        return None

    # Generate a unique migration name and revision id from the actual delta
    # being emitted — new table names, plus "<table>.<column>" for each
    # added column (the dot keeps a column addition unambiguous from a
    # same-named new table, e.g. "foo.bar" vs a table literally named
    # "foo_bar") — so a table-only and column-only delta for the same
    # plugin never collide on the same revision (see _compute_plugin_revision).
    delta_labels = [t.name for t in new_tables] + [
        f"{table_name}.{col.name}" for table_name, cols in column_additions for col in cols
    ]
    revision = _compute_plugin_revision(manifest, delta_labels)
    # The human-readable filename component uses "_" instead — a literal "."
    # in a generated .py filename works (filesystems and Alembic's
    # load-by-path both tolerate it) but reads oddly next to the ".py"
    # extension, so the display name and the hash input are allowed to differ.
    name_labels = [t.name for t in new_tables] + [
        f"{table_name}_{col.name}" for table_name, cols in column_additions for col in cols
    ]
    migration_name = generate_migration_name("_".join(name_labels))
    # Chain onto whatever's actually at the head of versions_dir right now,
    # instead of hard-coding None — otherwise every generated plugin
    # migration forks its own second head instead of appending to the chain
    # (breaks "alembic upgrade head" / the "existing migrations are not
    # affected — new ones are appended" acceptance criterion).
    down_revision = get_current_head_revision(versions_dir)

    # Build CREATE TABLE statements for genuinely new tables.
    create_statements: list[str] = []
    table_drop_statements: list[str] = []
    index_statements: list[tuple[str, str]] = []
    for table in new_tables:
        create_statements.append(_build_create_table_statement(table))
        table_drop_statements.append(f"op.drop_table({table.name!r})")
        index_statements.extend(_build_index_statements(table))

    # Build ADD COLUMN statements for additive changes on already-existing
    # tables.
    add_column_statements: list[str] = []
    column_drop_statements: list[str] = []
    for table_name, cols in column_additions:
        add_stmts, drop_stmts, idx_stmts = _build_add_column_statements(table_name, cols)
        add_column_statements.extend(add_stmts)
        column_drop_statements.extend(drop_stmts)
        index_statements.extend(idx_stmts)

    # Index DDL goes after every create/add in upgrade, before every drop in
    # downgrade.
    index_up_lines = [f"    {create}" for create, _ in index_statements]
    index_down_lines = [f"    {drop}" for _, drop in index_statements]

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]

    # Build upgrade body. Only non-empty groups are emitted — an empty
    # create_statements (a column-only delta) must not contribute a stray
    # blank line from joining/splitting nothing.
    upgrade_body_lines = [
        '    """Upgrade: create/alter plugin tables."""',
    ]
    if create_statements:
        # Plain "\n" join — every line gets its function-body indent added
        # exactly once, below, by the per-line "    {line}" prefixing.
        # Joining with "\n    " here as well used to double-indent every
        # statement after the first, which is invisible with a single table
        # (join has nothing to join) but produces an IndentationError as
        # soon as a manifest declares more than one table.
        for line in "\n".join(create_statements).split("\n"):
            upgrade_body_lines.append(f"    {line}")
    for stmt in add_column_statements:
        upgrade_body_lines.append(f"    {stmt}")
    upgrade_body_lines.extend(index_up_lines)

    # Build downgrade body — reverse of upgrade: undo the column adds before
    # undoing the table creates.
    downgrade_body_lines = [
        '    """Downgrade: revert plugin table/column changes."""',
    ]
    downgrade_body_lines.extend(index_down_lines)
    for stmt in column_drop_statements:
        downgrade_body_lines.append(f"    {stmt}")
    if table_drop_statements:
        for line in "\n".join(table_drop_statements).split("\n"):
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
