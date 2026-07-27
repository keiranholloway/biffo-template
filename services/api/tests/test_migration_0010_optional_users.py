"""Migration 0010 must apply to an instance with no Core `users` table (#670).

`0010_add_organizations_and_user_profile_fields` adds profile columns with
`batch_alter_table("users")`. That assumes a Core-owned `public.users` in the
instance's chain, and it is not universal: tabsii retired Core's users in favour
of `tabsii.users`, which is DDL-imported (ADR-0005) and created by no migration.
There, the migration reflected, raised `NoSuchTableError`, and took four
migration smoke tests and every write-back executor test with it
(tabsii-platform#241). That instance had to *decline* the migration and re-point
its chain around it — a permanent divergence.

**The template cannot catch this in its own CI by accident**, because the
template always has `public.users`: every other migration test starts from
`0001_create_users_table`. So this file deliberately builds the *other* chain —
the one an instance without Core users actually has — and runs the real
`alembic upgrade` against it. Without that inversion the guard is untested and
the bug is invisible exactly where it lives.
"""

from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config

_SERVICES_API_DIR = Path(__file__).resolve().parents[1]
_REAL_VERSIONS = _SERVICES_API_DIR / "migrations" / "versions"


def _config(tmp_path, monkeypatch, *, with_users: bool) -> tuple[Config, Path]:
    """A real Alembic config over a throwaway chain, with or without Core users.

    `0010`'s `down_revision` is rewritten to whichever revision precedes it in
    the chain being built, so each case is a single linear history rather than
    the repo's full graph — the same shape `biffo core upgrade` produces when it
    re-points a distributed migration onto an instance's own head.
    """
    db_path = tmp_path / "test.db"
    monkeypatch.setenv("BIFFO_DATABASE_URL", f"sqlite+aiosqlite:///{db_path}")
    if "src.api.config" in sys.modules:
        monkeypatch.setattr(
            sys.modules["src.api.config"].settings,
            "database_url",
            f"sqlite+aiosqlite:///{db_path}",
        )

    versions_dir = tmp_path / "versions"
    versions_dir.mkdir()

    base_revision = "0001"
    if with_users:
        shutil.copy(
            _REAL_VERSIONS / "0001_create_users_table.py",
            versions_dir / "0001_create_users_table.py",
        )
    else:
        # The instance-without-Core-users chain: a base migration that creates
        # something unrelated, so 0010 has a valid predecessor but no `users`.
        (versions_dir / "0001_base.py").write_text(
            'revision: str = "0001"\n'
            "down_revision: str | None = None\n"
            "branch_labels = None\n"
            "depends_on = None\n"
            "import sqlalchemy as sa\n"
            "from alembic import op\n"
            "def upgrade() -> None:\n"
            '    op.create_table("unrelated", sa.Column("id", sa.String(36), primary_key=True))\n'
            "def downgrade() -> None:\n"
            '    op.drop_table("unrelated")\n'
        )

    source = (_REAL_VERSIONS / "0010_add_organizations_and_user_profile_fields.py").read_text()
    # Matched by pattern, not by the literal predecessor. In the template 0010
    # revises 0009, but this file is template-owned and travels to instances,
    # where `biffo core upgrade` re-points a distributed migration onto that
    # instance's own head — tabsii's reads `"0011"`. Hardcoding the template's
    # value made all four tests fail there on arrival (tabsii-platform#263),
    # which is the same "green in the template, broken in the instance" shape
    # the migration under test exists to fix.
    rewritten, count = re.subn(
        r'down_revision: str \| None = "[^"]+"',
        f'down_revision: str | None = "{base_revision}"',
        source,
    )
    assert count == 1, "0010's down_revision was not rewritten; the chain would be broken"
    (versions_dir / "0010_add_organizations_and_user_profile_fields.py").write_text(rewritten)

    monkeypatch.chdir(_SERVICES_API_DIR)
    cfg = Config("alembic.ini")
    cfg.set_main_option("version_locations", str(versions_dir))
    return cfg, db_path


def _columns(db_path: Path, table: str) -> set[str]:
    engine = sa.create_engine(f"sqlite:///{db_path}")
    try:
        return {c["name"] for c in sa.inspect(engine).get_columns(table)}
    finally:
        engine.dispose()


def _tables(db_path: Path) -> set[str]:
    engine = sa.create_engine(f"sqlite:///{db_path}")
    try:
        return set(sa.inspect(engine).get_table_names())
    finally:
        engine.dispose()


def test_applies_where_there_is_no_core_users_table(tmp_path, monkeypatch):
    """The regression: this raised NoSuchTableError and broke the chain."""
    cfg, db_path = _config(tmp_path, monkeypatch, with_users=False)

    command.upgrade(cfg, "head")

    tables = _tables(db_path)
    # `organizations` is Core's own and depends on nothing instance-specific, so
    # it lands regardless — an instance that later adopts Core users converges
    # rather than needing this migration re-run.
    assert "organizations" in tables
    assert "users" not in tables


def test_still_adds_the_profile_columns_where_users_exists(tmp_path, monkeypatch):
    """The guard must skip only what is genuinely absent, not the whole block."""
    cfg, db_path = _config(tmp_path, monkeypatch, with_users=True)

    command.upgrade(cfg, "head")

    assert "organizations" in _tables(db_path)
    columns = _columns(db_path, "users")
    for expected in ("organization_id", "job_role", "address_line1", "country"):
        assert expected in columns


@pytest.mark.parametrize("with_users", [True, False])
def test_downgrade_reverses_whatever_it_applied(tmp_path, monkeypatch, with_users: bool):
    """Downgrade is guarded on the same condition, or it fails where upgrade passed."""
    cfg, db_path = _config(tmp_path, monkeypatch, with_users=with_users)
    command.upgrade(cfg, "head")

    command.downgrade(cfg, "0001")

    assert "organizations" not in _tables(db_path)
    if with_users:
        assert "organization_id" not in _columns(db_path, "users")
