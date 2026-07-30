"""The db_search_path backport (#458): empty by default so the base template's
engine is unaffected; when set, applied via asyncpg server_settings at connect
time so every connection carries it (needed for ADR-0005 DDL-imported schemas)."""

from api.database import _connect_args_for


def test_empty_search_path_adds_no_connect_args():
    # The default: the base template must be entirely unaffected.
    assert _connect_args_for("") == {}


def test_set_search_path_is_applied_via_server_settings():
    assert _connect_args_for("public,acme") == {"server_settings": {"search_path": "public,acme"}}


def test_default_setting_is_empty():
    from api.config import settings

    assert settings.db_search_path == ""


def test_alembic_engine_carries_no_search_path():
    """Alembic must NOT inherit `db_search_path`, and migration 0010 relies on it (#764).

    The application engine (`api/database.py`) passes
    `connect_args=_connect_args_for(settings.db_search_path)`, so every app
    connection carries the instance's search path. Alembic's engine
    (`migrations/env.py`) deliberately passes no `connect_args` at all, so
    migrations run on the default path.

    Migration 0010's `_has_core_users_table()` is correct only because of that. It
    calls an unqualified `sa.inspect(...).has_table("users")`, so an instance whose
    users live in another schema — tabsii's `tabsii.users` — reads False, which is
    the right answer: those are not Core's to alter. Give Alembic a search path and
    the guard starts finding a table it must not touch, and a migration would
    `batch_alter_table` an instance's own users table.

    That invariant was undocumented and untested until #764. The existing
    `test_migration_0010_optional_users.py` cannot express it: it runs on SQLite,
    which has no schemas.

    Read by AST rather than by substring, so the assertion is about the call and
    not about the file's prose — a comment saying "no connect_args" must not be
    able to satisfy a test that connect_args is absent.
    """
    import ast
    from pathlib import Path

    env_py = Path(__file__).resolve().parents[1] / "migrations" / "env.py"
    tree = ast.parse(env_py.read_text())

    calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "create_async_engine"
    ]
    # Anti-vacuity: if the call is renamed or removed, fail loudly rather than
    # passing over an empty list.
    assert calls, f"no create_async_engine(...) call found in {env_py} — has it been renamed?"

    for call in calls:
        kwargs = {kw.arg for kw in call.keywords if kw.arg is not None}
        assert "connect_args" not in kwargs, (
            f"{env_py.name} passes connect_args to create_async_engine. Migration 0010's "
            f"unqualified has_table('users') then resolves against a non-default search "
            f"path and can find an instance's own users table, which Core must not alter. "
            f"See #764."
        )
        # `**kwargs` splat would hide a connect_args this AST check cannot see.
        assert not any(kw.arg is None for kw in call.keywords), (
            f"{env_py.name} splats **kwargs into create_async_engine, so this guard "
            f"cannot see whether connect_args is among them. Pass keywords explicitly."
        )
