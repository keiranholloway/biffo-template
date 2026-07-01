"""Alembic migration generator for plugin table definitions."""

from __future__ import annotations

import ast
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from api.models.plugin_table import ColumnDefinition, PluginTableDefinition


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
    sa.String('36') rather than the broken sa.String(36)().
    """
    parts = [f"'{col.name}'"]

    # Convert type string to proper Alembic expression
    # "String(36)" -> sa.String('36')
    # "DateTime(timezone=True)" -> sa.DateTime(timezone=True)
    # "Integer" -> sa.Integer()
    if "(" in col.type:
        base_type, params = col.type.split("(", 1)
        params = params.rstrip(")")
        # Quote bare values like "36" so they become valid Python strings
        # "36" -> '36', "timezone=True" stays as-is
        try:
            ast.literal_eval(f"({params})")
            # Looks like a literal - wrap bare values in quotes
            formatted_params = _format_alembic_params(params)
            parts.append(f"sa.{base_type}({formatted_params})")
        except (ValueError, SyntaxError):
            # Already valid Python expression
            parts.append(f"sa.{base_type}({params})")
    else:
        parts.append(f"sa.{col.type}()")

    if col.primary_key:
        parts.append("primary_key=True")
    if not col.nullable:
        parts.append("nullable=False")
    return ", ".join(parts)


def _format_alembic_params(params: str) -> str:
    """Format parameters for Alembic SQL expressions.

    Converts bare values like '36' to quoted strings '36',
    while leaving keyword args like 'timezone=True' intact.
    """
    parts = []
    for part in params.split(","):
        part = part.strip()
        if "=" in part:
            # Keyword argument - leave as-is
            parts.append(part)
        else:
            # Positional argument - quote it
            parts.append(f"'{part}'")
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
        '{table.name}',
        {cols_str}{pk_constraint},
    )"""
    return stmt


def _build_index_statements(table: PluginTableDefinition) -> list[str]:
    """Build Alembic create_index statements for indexed columns and IndexDefinitions."""
    statements = []

    # Auto-index columns marked with index=True
    for col in table.columns:
        if col.index:
            idx_name = f"ix_{table.name}_{col.name}"
            statements.append(
                f"op.create_index('{idx_name}', '{table.name}', ['{col.name}'], unique=False)"
            )

    # Explicit IndexDefinitions
    for idx in table.indexes:
        unique_flag = "True" if idx.unique else "False"
        col_list = ", ".join(repr(c) for c in idx.columns)
        statements.append(
            f"op.create_index('{idx.name}', '{table.name}', [{col_list}], unique={unique_flag})"
        )

    return statements


def _build_drop_index_statements(index_statements: list[str]) -> list[str]:
    """Build Alembic drop_index statements from create_index statements."""
    drops = []
    for stmt in index_statements:
        # Parse: op.create_index('name', 'table', [...], unique=...)
        parts = stmt.split("'")
        if len(parts) >= 4:
            idx_name = parts[1]
            tbl_name = parts[3]
            drops.append(f"op.drop_index('{idx_name}', '{tbl_name}')")
    return drops


def generate_migration_for_plugin(
    manifest: dict[str, Any],
    versions_dir: Path,
) -> Path:
    """Generate an Alembic migration file for a plugin's table definitions.

    Creates a migration file with proper up/downgrade functions that
    create/drop all tables defined in the plugin manifest.

    Args:
        manifest: The parsed plugin manifest JSON.
        versions_dir: Directory where Alembic stores migration files.

    Returns:
        Path to the generated migration file.
    """
    tables = parse_plugin_tables_from_manifest(manifest)
    if not tables:
        raise ValueError(
            f"Plugin '{manifest.get('name', '<unknown>')}' has no tables to migrate."
        )

    # Generate a unique migration name
    table_names = "_".join(t.name for t in tables)
    migration_name = generate_migration_name(table_names)

    # Build migration content
    revision = _short_sha256(
        f"{manifest.get('name', '')}-{'-'.join(t.name for t in tables)}"
    )

    # Build CREATE TABLE statements for upgrade
    create_statements = []
    drop_statements = []
    index_statements = []
    for table in tables:
        create_stmt = _build_create_table_statement(table)
        drop_stmt = f"op.drop_table('{table.name}')"
        create_statements.append(create_stmt)
        drop_statements.append(drop_stmt)
        # Collect index creation statements
        index_statements.extend(_build_index_statements(table))

    create_block = "\n    ".join(create_statements)
    drop_block = "\n    ".join(drop_statements)

    # Index DDL goes after CREATE TABLE in upgrade, before DROP TABLE in downgrade
    index_up_lines = [f"    {stmt}" for stmt in index_statements]
    index_down_lines = [
        f"    {stmt}" for stmt in _build_drop_index_statements(index_statements)
    ]

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
Revises:
Create Date: {now}

\"\"\"
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '{revision}'
down_revision = None
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
