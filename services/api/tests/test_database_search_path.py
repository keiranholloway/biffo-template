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
