"""Tests for the least-privilege `biffo_app` role bootstrap (issue #253).

These are deliberately statement-level. The bootstrap only ever runs against a
*fresh* Postgres database via the `biffo:db-init` Lambda event, so the suite
(in-memory SQLite) can never execute it end to end. What it can do — and what
matters most, because a wrong grant set fails at runtime in production rather
than here — is pin the exact SQL that gets emitted:

* that `SUPERUSER`/`BYPASSRLS` are never named, in either direction, because
  the RDS master is `rds_superuser` and mentioning them fails the deploy;
* that the grant set is exactly what `services/api/` exercises, and that the
  privileges it must not hold are absent;
* that the URL resolution keeps migrations on the master credential and the
  request path on the app credential.
"""

from __future__ import annotations

import re

import pytest
from src.api import db_app_role
from src.api.db_app_role import (
    InvalidIdentifierError,
    build_grant_statements,
    build_revoke_statements,
    build_role_statements,
)

ROLE = "biffo_app"


def _all_statements(role: str = ROLE, schemas: list[str] | None = None) -> str:
    schemas = schemas if schemas is not None else ["public"]
    return "\n".join(
        build_role_statements(role)
        + build_grant_statements(role, schemas)
        + build_revoke_statements(role)
    )


class TestRoleAttributes:
    def test_never_names_superuser_or_bypassrls_in_either_direction(self) -> None:
        """The RDS master is `rds_superuser`, not a true superuser, and
        Postgres requires real superuser to change either attribute. Writing
        `NOSUPERUSER` explicitly -- the obvious thing to write -- makes
        CREATE ROLE fail with "must be superuser to change superuser
        attribute" and takes db-init, and therefore the deploy, down. The
        CREATE ROLE defaults are already NOSUPERUSER NOBYPASSRLS, so the
        correct move is to say nothing. This test is the guard against a
        well-meaning future edit adding them back."""
        sql = _all_statements().upper()
        assert "SUPERUSER" not in sql
        assert "BYPASSRLS" not in sql
        assert "REPLICATION" not in sql

    def test_role_is_created_with_login_and_no_creation_rights(self) -> None:
        sql = "\n".join(build_role_statements(ROLE))
        assert "CREATE ROLE" in sql
        assert "ALTER ROLE" in sql  # idempotent re-run path
        assert sql.count("LOGIN NOCREATEDB NOCREATEROLE") == 2

    def test_password_is_never_interpolated_into_the_statement_text(self) -> None:
        """The password travels as a bind parameter into a session GUC and is
        read back server-side. `log_statement`/`log_min_duration_statement` are
        on for this parameter group, so a password inlined into DDL would land
        in CloudWatch."""
        from src.api.db_app_role import SET_PASSWORD_SQL

        assert "$1" in SET_PASSWORD_SQL
        sql = "\n".join(build_role_statements(ROLE))
        assert "current_setting" in sql
        assert "%L" in sql  # quoted server-side by format(), not by Python

    def test_the_guc_names_match_the_constants(self) -> None:
        """The bootstrap SQL spells the two GUC names literally (so it stays a
        plain string and does not trip Bandit's B608), while the SET/CLEAR
        statements build theirs from the constants. This is the guard that the
        two never drift -- if they did, current_setting() would raise
        "unrecognized configuration parameter" at deploy time."""
        from src.api.db_app_role import (
            _PASSWORD_GUC,
            _ROLE_BOOTSTRAP_SQL,
            _ROLE_GUC,
            CLEAR_PASSWORD_SQL,
            SET_PASSWORD_SQL,
            SET_ROLE_SQL,
        )

        assert f"current_setting('{_ROLE_GUC}')" in _ROLE_BOOTSTRAP_SQL
        assert f"current_setting('{_PASSWORD_GUC}')" in _ROLE_BOOTSTRAP_SQL
        assert _ROLE_GUC in SET_ROLE_SQL
        assert _PASSWORD_GUC in SET_PASSWORD_SQL
        assert _PASSWORD_GUC in CLEAR_PASSWORD_SQL

    def test_the_role_name_is_a_bind_parameter_not_interpolated(self) -> None:
        """Neither the role name nor the password reaches Postgres as
        string-built SQL; both are bound and re-quoted server-side by
        format()'s %I/%L."""
        from src.api.db_app_role import _ROLE_BOOTSTRAP_SQL, SET_ROLE_SQL

        assert "$1" in SET_ROLE_SQL
        assert "biffo_app" not in _ROLE_BOOTSTRAP_SQL
        assert "%I" in _ROLE_BOOTSTRAP_SQL
        assert build_role_statements(ROLE) == [_ROLE_BOOTSTRAP_SQL]

    def test_grants_connect_on_the_database(self) -> None:
        assert "GRANT CONNECT ON DATABASE" in "\n".join(build_role_statements(ROLE))


class TestGrantSet:
    def test_grants_exactly_the_dml_the_request_path_uses(self) -> None:
        statements = build_grant_statements(ROLE, ["public"])
        table_grant = next(s for s in statements if "ON ALL TABLES" in s)
        assert "SELECT, INSERT, UPDATE, DELETE" in table_grant
        assert 'GRANT USAGE ON SCHEMA "public" TO "biffo_app"' in statements

    def test_withholds_the_privileges_the_request_path_never_needs(self) -> None:
        """Enumerated from services/api/: no runtime DDL, no temp tables, no
        advisory locks, no FK creation, no truncation."""
        sql = _all_statements().upper()
        assert "TRUNCATE" not in sql
        assert "REFERENCES" not in sql
        assert "TRIGGER" not in sql
        assert "GRANT ALL" not in sql
        assert "GRANT CREATE" not in sql
        assert "OWNER TO" not in sql

    def test_grants_sequences_for_plugin_declared_integer_keys(self) -> None:
        """Every *core* table has a client-generated uuid4 String(36) PK, so no
        sequence is needed for them. An ADR-0003 plugin manifest may declare an
        Integer primary key, which does produce a sequence -- and a missing
        sequence grant surfaces as a 5xx on that plugin's create path, not as a
        test failure."""
        statements = build_grant_statements(ROLE, ["public"])
        seq_grant = next(s for s in statements if "ON ALL SEQUENCES" in s)
        assert "USAGE, SELECT" in seq_grant

    def test_sets_default_privileges_so_future_migrations_need_no_rerun(
        self,
    ) -> None:
        statements = build_grant_statements(ROLE, ["public"])
        defaults = [s for s in statements if "ALTER DEFAULT PRIVILEGES" in s]
        assert len(defaults) == 2
        # No FOR ROLE clause: it must attach to the *current* role, which is the
        # master user that Alembic and DDL imports create objects as.
        assert all("FOR ROLE" not in s for s in defaults)

    def test_covers_every_schema_it_is_given(self) -> None:
        statements = build_grant_statements(ROLE, ["public", "tabsii"])
        assert any('SCHEMA "tabsii"' in s for s in statements)
        assert any('SCHEMA "public"' in s for s in statements)

    def test_no_schemas_emits_no_grants(self) -> None:
        assert build_grant_statements(ROLE, []) == []

    def test_revokes_the_app_role_from_alembic_version(self) -> None:
        """The blanket ON ALL TABLES grant would otherwise let a compromised
        request path rewrite migration state. The request path never reads
        alembic_version."""
        sql = "\n".join(build_revoke_statements(ROLE))
        assert "REVOKE ALL ON TABLE" in sql
        assert "alembic_version" in sql


class TestIdentifierValidation:
    @pytest.mark.parametrize(
        "bad",
        ['app"; DROP DATABASE x; --', "Biffo_App", "app role", "", "1app", "a" * 64],
    )
    def test_rejects_anything_that_is_not_a_plain_lowercase_identifier(self, bad: str) -> None:
        with pytest.raises(InvalidIdentifierError):
            build_grant_statements(bad, ["public"])

    def test_rejects_an_injected_schema_name(self) -> None:
        with pytest.raises(InvalidIdentifierError):
            build_grant_statements(ROLE, ['public"; DROP SCHEMA x; --'])

    def test_identifiers_are_double_quoted(self) -> None:
        assert '"public"' in build_grant_statements(ROLE, ["public"])[0]


class TestSchemaSelection:
    def test_discovery_query_excludes_system_and_temp_schemas(self) -> None:
        from src.api.db_app_role import DISCOVER_SCHEMAS_SQL, SYSTEM_SCHEMAS

        assert "pg_catalog" in SYSTEM_SCHEMAS
        assert "information_schema" in SYSTEM_SCHEMAS
        assert "pg_toast" in SYSTEM_SCHEMAS
        assert "pg\\_temp\\_%" in DISCOVER_SCHEMAS_SQL
        assert "pg\\_toast\\_temp\\_%" in DISCOVER_SCHEMAS_SQL
        # The system list is a bind parameter, not interpolated.
        assert "$1" in DISCOVER_SCHEMAS_SQL

    def test_empty_setting_means_auto_discover(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(db_app_role.settings, "app_role_schemas", "")
        assert db_app_role.configured_schemas() is None

    def test_setting_pins_an_explicit_list(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(db_app_role.settings, "app_role_schemas", "public, tabsii ,")
        assert db_app_role.configured_schemas() == ["public", "tabsii"]


class TestPostgresOnly:
    @pytest.mark.parametrize(
        ("url", "expected"),
        [
            ("postgresql+asyncpg://u:p@h:5432/d", True),
            ("postgresql://u:p@h:5432/d", True),
            ("sqlite+aiosqlite:///tmp/test.db", False),
            ("sqlite://", False),
        ],
    )
    def test_only_postgres_gets_bootstrapped(self, url: str, expected: bool) -> None:
        assert db_app_role.is_postgres(url) is expected

    @pytest.mark.asyncio
    async def test_bootstrap_is_a_no_op_on_sqlite(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from src.api import database

        monkeypatch.setattr(
            database.resolve_master_database_url, "__wrapped__", lambda: "sqlite://"
        )
        monkeypatch.setattr(database, "resolve_master_database_url", lambda: "sqlite://")
        monkeypatch.setattr(database, "app_role_credentials", lambda: None)

        result = await db_app_role.bootstrap_app_role_async()

        assert result == {"bootstrapped": False, "reason": "not-postgres"}


class TestUrlResolution:
    """The whole point of the split: two credentials, used by different code."""

    def _clear_caches(self) -> None:
        from src.api import database

        database.resolve_master_database_url.cache_clear()
        database.resolve_app_database_url.cache_clear()

    def test_request_path_prefers_the_app_url_over_the_master_url(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from src.api import database

        monkeypatch.setattr(database.settings, "db_secret_arn", "")
        monkeypatch.setattr(database.settings, "app_db_secret_arn", "")
        monkeypatch.setattr(database.settings, "database_url", "postgresql+asyncpg://master:pw@h/d")
        monkeypatch.setattr(
            database.settings,
            "app_database_url",
            "postgresql+asyncpg://biffo_app:apw@h/d",
        )
        self._clear_caches()

        assert database.resolve_app_database_url() == ("postgresql+asyncpg://biffo_app:apw@h/d")
        assert database.resolve_master_database_url() == ("postgresql+asyncpg://master:pw@h/d")
        self._clear_caches()

    def test_falls_back_to_master_when_no_app_credential_is_provisioned(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """An instance that upgrades its core before re-applying its Terraform
        must keep serving traffic rather than fail closed on every request.
        log_effective_db_identity() warns loudly when this is in effect."""
        from src.api import database

        monkeypatch.setattr(database.settings, "db_secret_arn", "")
        monkeypatch.setattr(database.settings, "app_db_secret_arn", "")
        monkeypatch.setattr(database.settings, "app_database_url", "")
        monkeypatch.setattr(database.settings, "database_url", "postgresql+asyncpg://master:pw@h/d")
        self._clear_caches()

        assert database.resolve_app_database_url() == (database.resolve_master_database_url())
        assert database.app_role_credentials() is None
        self._clear_caches()

    def test_app_credentials_parse_passwords_containing_url_metacharacters(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Terraform's generated password may contain '#', '?', ':' and '&'.
        urllib.parse and SQLAlchemy disagree about those; bootstrapping a
        different password than the engine connects with would authenticate-
        fail every request, so the parse must be SQLAlchemy's own."""
        password = "a#b?c:d&e=f"
        from src.api import database

        monkeypatch.setattr(database.settings, "app_db_secret_arn", "")
        monkeypatch.setattr(
            database.settings,
            "app_database_url",
            f"postgresql+asyncpg://biffo_app:{password}@h:5432/d",
        )
        self._clear_caches()

        assert database.app_role_credentials() == ("biffo_app", password)
        self._clear_caches()


class TestSecretShape:
    def test_both_secrets_are_read_through_the_same_key_shape(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Terraform writes db_credentials and app_credentials with identical
        keys so one _url_from_secret() serves both."""
        from src.api import database

        monkeypatch.setattr(database.settings, "db_host", "")
        url = database._url_from_secret(
            {
                "username": "biffo_app",
                "password": "pw",
                "host": "db.example.com",
                "port": 5432,
                "dbname": "biffo",
            }
        )
        assert url == "postgresql+asyncpg://biffo_app:pw@db.example.com:5432/biffo"

    def test_db_host_overrides_the_secret_host_for_the_rds_proxy(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from src.api import database

        monkeypatch.setattr(database.settings, "db_host", "proxy.example.com")
        url = database._url_from_secret(
            {
                "username": "biffo_app",
                "password": "pw",
                "host": "db.example.com",
                "port": 5432,
                "dbname": "biffo",
            }
        )
        assert "proxy.example.com" in url
        assert "db.example.com" not in url


class TestTerraformWiring:
    """Drift guards over the Terraform that mints the second credential. A
    mismatch here is invisible until a deploy, and then it is a 5xx."""

    def _database_module(self) -> str:
        from pathlib import Path

        root = Path(__file__).resolve().parents[3]
        return (root / "modules/cloud/aws/database/main.tf").read_text()

    def _block(self, header: str) -> str:
        """The text of one top-level Terraform block.

        Split on the next top-level `resource "` rather than on `}` -- the
        app_password block's own override_special value contains braces.
        """
        tf = self._database_module()
        assert header in tf, f"{header} missing from the database module"
        after = tf.split(header, 1)[1]
        return after.split('\nresource "', 1)[0]

    def test_a_second_secret_is_provisioned_for_the_app_role(self) -> None:
        tf = self._database_module()
        assert 'resource "aws_secretsmanager_secret" "app_credentials"' in tf
        assert "db/app-credentials" in tf

    def test_the_app_password_excludes_percent(self) -> None:
        """'%' would make the password ambiguous with percent-encoding when the
        baked-in URL is parsed back apart to bootstrap the role."""
        app_block = self._block('resource "random_password" "app_password"')
        override = re.search(r'override_special\s*=\s*"([^"]*)"', app_block)
        assert override is not None, "app_password has no override_special"
        assert "%" not in override.group(1)
        assert "/" not in override.group(1)
        assert "@" not in override.group(1)

    def test_the_rds_proxy_accepts_both_credentials(self) -> None:
        """The proxy authenticates each client credential against a secret. One
        auth block would reject every request-path connection at the proxy,
        before Postgres ever saw it."""
        proxy_block = self._block('resource "aws_db_proxy" "main"')
        assert proxy_block.count('auth_scheme = "SECRETS"') == 2
        assert "aws_secretsmanager_secret.app_credentials.arn" in proxy_block
