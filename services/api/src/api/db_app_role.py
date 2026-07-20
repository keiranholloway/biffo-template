"""Bootstrap the least-privilege `biffo_app` Postgres role (issue #253).

Background
----------
The Core API used to connect to Postgres as the RDS master user, which is
`rds_superuser`, owns every table, and carries `BYPASSRLS`. That is poor least
privilege regardless of whether RLS is ever used: a SQL injection, a dependency
compromise, or an ordinary bug on a query path had unlimited blast radius — it
could read or drop anything in the database, including schemas the API has no
business touching (an instance's ADR-0005 `db/imports` business schema, say).

This module splits that in two:

* **Owner / master** — Alembic migrations, `biffo:db-init` and
  `biffo:ddl-import` still connect as the master user, because they create and
  alter objects. See `database.resolve_master_database_url`.
* **Application** — the HTTP request path connects as `biffo_app`, a
  `NOSUPERUSER`, non-owner role granted *only* `USAGE` on the schemas it reads
  plus `SELECT/INSERT/UPDATE/DELETE` on their tables and `USAGE/SELECT` on
  their sequences. See `database.resolve_app_database_url`.

Deliberately **not** implemented here: RLS policies and the
`SET LOCAL app.tenant_id` / `app.current_user_id` GUC plumbing. Those were
deferred with the decision in #229 — see ADR-0012's amendment. This module is
the privilege split alone.

What the request path actually needs
------------------------------------
The grant set below is enumerated from `services/api/`, not guessed:

* Every core table is `TenantScopedModel` with a client-generated
  `String(36)` uuid4 primary key (`models/base.py`) — no `SERIAL`, so no
  sequence is strictly required. `USAGE, SELECT ON ALL SEQUENCES` is granted
  anyway because an ADR-0003 plugin manifest may declare an `Integer` primary
  key, which *would* produce a sequence, and a missing sequence grant surfaces
  as a runtime 5xx on that plugin's create path rather than a test failure.
* Reads and writes are plain ORM `SELECT/INSERT/UPDATE/DELETE` (routers,
  `routing/crud_handlers.py`, `orchestration.py`). `orchestration.py` uses
  `SAVEPOINT` via `begin_nested()`, which needs no privilege.
* The only function called is the built-in `now()`. Nothing reads `pg_catalog`
  or `information_schema` — `permissions.py` documents that as an explicit
  architectural commitment, and ADR-0004 rejects runtime introspection.
* No temp tables, no advisory locks, no extensions, no runtime DDL.

So `CREATE` on schema, `TRUNCATE`, `REFERENCES`, `TRIGGER` and any ownership
are all withheld — and `alembic_version` is revoked outright, so a compromised
request path cannot rewrite migration state.

Schema selection
----------------
By default every non-system schema present at bootstrap time is granted. That
is wider than `public` on purpose: ADR-0005 lets an instance's DDL imports
create their own business schema, and ADR-0012 lets a deployment's identity
provider read `users` out of it, so restricting to `public` would 5xx exactly
those deployments. The reduction that matters is still intact — no ownership,
no DDL, no superuser. Set `BIFFO_APP_ROLE_SCHEMAS` to pin an explicit list.

Because the schema set is captured at bootstrap time, this runs at the end of
`biffo:ddl-import` as well as `biffo:db-init`: an import that creates a new
schema or table would otherwise leave the app role without access to it until
the next deploy. `ALTER DEFAULT PRIVILEGES` covers objects the master creates
*after* this point, but only in schemas that already existed when it ran.
"""

from __future__ import annotations

import asyncio
import re

from aws_lambda_powertools import Logger
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

from .config import settings

logger = Logger(child=True)

# Privileges the request path actually exercises. Note the absences: no
# TRUNCATE, no REFERENCES, no TRIGGER, no CREATE.
TABLE_PRIVILEGES = "SELECT, INSERT, UPDATE, DELETE"
SEQUENCE_PRIVILEGES = "USAGE, SELECT"

# Schemas Postgres owns. `pg_temp_*` / `pg_toast_temp_*` are matched by pattern.
SYSTEM_SCHEMAS = ("pg_catalog", "information_schema", "pg_toast")

# Migration bookkeeping. Owned by the master user; the request path never reads
# it, so the app role is revoked from it after the blanket ALL TABLES grant.
ALEMBIC_VERSION_TABLE = "alembic_version"

_IDENTIFIER_RE = re.compile(r"^[a-z_][a-z0-9_$]{0,62}$")


class InvalidIdentifierError(ValueError):
    """A role or schema name that cannot be safely used as a SQL identifier."""


def _quote_ident(name: str, kind: str) -> str:
    """Validate then double-quote a Postgres identifier.

    Schema names come from `pg_namespace` and the role name from settings, so
    neither is attacker-controlled — but these are interpolated into DDL that
    cannot take bind parameters, so they are validated against a strict
    allowlist regardless. The role *password*, which is the one genuinely
    sensitive value, is never interpolated at all: it travels as a bind
    parameter into a GUC and is read back server-side (see
    `build_role_statements`).
    """
    if not _IDENTIFIER_RE.match(name):
        raise InvalidIdentifierError(
            f"{kind} {name!r} is not a valid lowercase Postgres identifier "
            "(expected ^[a-z_][a-z0-9_$]*$, max 63 chars)"
        )
    return f'"{name}"'


# Transport for the role password: set as a session-local custom GUC via a bind
# parameter, read back inside the DO block with current_setting(), and cleared
# immediately afterwards. This keeps the password out of the SQL statement text
# entirely, which matters because `log_statement`/`log_min_duration_statement`
# are enabled on this parameter group (modules/cloud/aws/database/main.tf).
_PASSWORD_GUC = "biffo.app_role_password"
_ROLE_GUC = "biffo.app_role_name"

SET_PASSWORD_SQL = f"SELECT set_config('{_PASSWORD_GUC}', $1, false)"
CLEAR_PASSWORD_SQL = f"SELECT set_config('{_PASSWORD_GUC}', '', false)"
SET_ROLE_SQL = f"SELECT set_config('{_ROLE_GUC}', $1, false)"

# Note this statement is a *constant*: neither the role name nor the password
# is interpolated from Python. Both arrive as bind parameters (SET_ROLE_SQL /
# SET_PASSWORD_SQL above) and are re-quoted server-side by format()'s %I and
# %L. CREATE ROLE cannot take bind parameters directly, so this is the closest
# equivalent — and it means there is no string-built SQL here for an injection
# to reach, which the per-schema GRANTs below cannot avoid (they interpolate
# validated identifiers, since ALTER DEFAULT PRIVILEGES has no DO-block form).
#
# The GUC names are written out literally rather than interpolated from the
# constants above so this stays a plain string with no Python formatting in it
# at all -- an f-string here trips Bandit's B608, and a `nosec` to silence a
# hardcoded-SQL warning on the one function that administers database
# privileges is exactly the wrong place to teach people to ignore that check.
# `test_the_guc_names_match_the_constants` guards the two from drifting apart.
_ROLE_BOOTSTRAP_SQL = """
DO $bootstrap$
DECLARE
    v_role     text := current_setting('biffo.app_role_name');
    v_password text := current_setting('biffo.app_role_password');
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
        EXECUTE format(
            'ALTER ROLE %I WITH LOGIN NOCREATEDB NOCREATEROLE PASSWORD %L',
            v_role, v_password
        );
    ELSE
        EXECUTE format(
            'CREATE ROLE %I WITH LOGIN NOCREATEDB NOCREATEROLE PASSWORD %L',
            v_role, v_password
        );
    END IF;

    -- current_database() is only known at runtime, so this is assembled
    -- server-side rather than formatted in Python.
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), v_role);
END
$bootstrap$;
"""


def build_role_statements(role: str) -> list[str]:
    """SQL that creates or updates the app role itself.

    Critically, this sets **neither** `SUPERUSER`/`NOSUPERUSER` **nor**
    `BYPASSRLS`/`NOBYPASSRLS`. On RDS the master user is `rds_superuser`, not a
    true superuser, and Postgres requires real superuser to touch either
    attribute — naming them explicitly makes `CREATE ROLE` fail with
    "must be superuser to change superuser attribute" and takes the deploy down.
    The defaults are already `NOSUPERUSER NOBYPASSRLS NOREPLICATION`, which is
    exactly what is wanted, so the correct move is to say nothing about them.
    `NOCREATEDB`/`NOCREATEROLE` *are* settable by `rds_superuser` and are stated
    explicitly, so a pre-existing role carrying them gets them stripped.

    `role` is validated here even though the returned SQL does not embed it, so
    a malformed role name is rejected before any statement is sent rather than
    surfacing as a confusing server-side `format()` error.
    """
    _quote_ident(role, "role name")
    return [_ROLE_BOOTSTRAP_SQL]


def build_grant_statements(role: str, schemas: list[str]) -> list[str]:
    """The exact privilege set the request path needs, per schema.

    `ALTER DEFAULT PRIVILEGES` (without `FOR ROLE`) applies to objects created
    by the *current* role, which is the master user — the one Alembic and DDL
    imports run as. So a table added by a future migration is granted
    automatically and does not need another bootstrap pass.
    """
    quoted_role = _quote_ident(role, "role name")
    statements: list[str] = []
    for schema in schemas:
        quoted_schema = _quote_ident(schema, "schema name")
        statements += [
            f"GRANT USAGE ON SCHEMA {quoted_schema} TO {quoted_role}",
            f"GRANT {TABLE_PRIVILEGES} ON ALL TABLES IN SCHEMA {quoted_schema} "
            f"TO {quoted_role}",
            f"GRANT {SEQUENCE_PRIVILEGES} ON ALL SEQUENCES IN SCHEMA "
            f"{quoted_schema} TO {quoted_role}",
            f"ALTER DEFAULT PRIVILEGES IN SCHEMA {quoted_schema} "
            f"GRANT {TABLE_PRIVILEGES} ON TABLES TO {quoted_role}",
            f"ALTER DEFAULT PRIVILEGES IN SCHEMA {quoted_schema} "
            f"GRANT {SEQUENCE_PRIVILEGES} ON SEQUENCES TO {quoted_role}",
        ]
    return statements


def build_revoke_statements(role: str) -> list[str]:
    """Claw back the pieces the blanket per-schema grant over-granted.

    Runs after `build_grant_statements`, and again on every subsequent
    bootstrap, since `GRANT ... ON ALL TABLES` re-grants each time.
    """
    quoted_role = _quote_ident(role, "role name")
    return [
        f"""
        DO $revoke$
        BEGIN
            IF to_regclass('{ALEMBIC_VERSION_TABLE}') IS NOT NULL THEN
                EXECUTE format(
                    'REVOKE ALL ON TABLE %s FROM {quoted_role}',
                    to_regclass('{ALEMBIC_VERSION_TABLE}')::text
                );
            END IF;
        END
        $revoke$;
        """
    ]


DISCOVER_SCHEMAS_SQL = """
SELECT nspname
FROM pg_namespace
WHERE nspname <> ALL($1::text[])
  AND nspname NOT LIKE 'pg\\_temp\\_%'
  AND nspname NOT LIKE 'pg\\_toast\\_temp\\_%'
ORDER BY nspname
"""


def configured_schemas() -> list[str] | None:
    """Explicit schema allowlist from settings, or None to auto-discover."""
    raw = [s.strip() for s in settings.app_role_schemas.split(",")]
    pinned = [s for s in raw if s]
    return pinned or None


def is_postgres(url: str) -> bool:
    """Whether this deployment is on Postgres at all.

    The test suite runs against in-memory SQLite, which has no roles, no
    schemas and no GRANT. Bootstrapping is a Postgres-only concern and is
    skipped everywhere else rather than erroring.
    """
    try:
        return make_url(url).get_backend_name() == "postgresql"
    except Exception:  # pragma: no cover — malformed URL surfaces at connect
        return False


def log_effective_db_identity() -> None:
    """Record, on every deploy, which identity the request path will use.

    `resolve_app_database_url` falls back to the master URL when no app
    credential is provisioned. That fallback keeps an instance serving traffic
    when it upgrades its core before re-applying its Terraform, but it also
    silently undoes this issue's entire point — so it is logged as a warning
    that a human reading the db-init output will see.
    """
    from .database import app_role_credentials

    if app_role_credentials() is None:
        logger.warning(
            "No app DB credential configured (BIFFO_APP_DB_SECRET_ARN / "
            "BIFFO_APP_DATABASE_URL are both unset) — the request path is "
            "falling back to the master/owner role. Re-apply this "
            "environment's Terraform to provision the app credential (#253)."
        )
    else:
        logger.info(
            f"Request path will connect as the least-privilege role "
            f"{settings.app_role_name!r} (#253)"
        )


async def bootstrap_app_role_async() -> dict:
    """Create/refresh `biffo_app` and its grants. Idempotent.

    Connects as the master user — this is DDL and privilege administration, so
    it is precisely the work the app role must not be able to do itself.
    """
    from .database import app_role_credentials, resolve_master_database_url

    log_effective_db_identity()

    master_url = resolve_master_database_url()
    if not is_postgres(master_url):
        logger.info("Not a Postgres deployment — skipping app role bootstrap")
        return {"bootstrapped": False, "reason": "not-postgres"}

    credentials = app_role_credentials()
    if credentials is None:
        return {"bootstrapped": False, "reason": "no-app-credential"}

    username, password = credentials
    if username != settings.app_role_name:
        # The provisioned secret and the role this code administers must agree,
        # or db-init would bootstrap grants onto a role nothing connects as.
        raise ValueError(
            f"App credential username {username!r} does not match "
            f"BIFFO_APP_ROLE_NAME {settings.app_role_name!r}"
        )

    engine = create_async_engine(master_url)
    try:
        async with engine.connect() as conn:
            raw = await conn.get_raw_connection()
            asyncpg_conn = raw.driver_connection
            assert asyncpg_conn is not None  # noqa: S101 — narrows for pyright

            schemas = configured_schemas()
            if schemas is None:
                rows = await asyncpg_conn.fetch(
                    DISCOVER_SCHEMAS_SQL, list(SYSTEM_SCHEMAS)
                )
                schemas = [row["nspname"] for row in rows]

            # One transaction: either the role exists with the full grant set,
            # or nothing changed. A half-granted role is the failure mode that
            # 5xxes in production.
            async with asyncpg_conn.transaction():
                await asyncpg_conn.execute(SET_ROLE_SQL, username)
                await asyncpg_conn.execute(SET_PASSWORD_SQL, password)
                for statement in build_role_statements(username):
                    await asyncpg_conn.execute(statement)
                # Cleared on the success path only, deliberately NOT in a
                # `finally`. Once a statement inside a transaction fails,
                # Postgres puts it in the aborted state and every subsequent
                # statement raises InFailedSQLTransaction -- so a `finally`
                # clear would itself throw and mask the real error, which is
                # precisely the error someone debugging a failed deploy needs
                # to see. The failure path does not need it anyway: the
                # transaction rolls back, and a GUC set inside a rolled-back
                # transaction is rolled back with it.
                await asyncpg_conn.execute(CLEAR_PASSWORD_SQL)
                for statement in build_grant_statements(username, schemas):
                    await asyncpg_conn.execute(statement)
                for statement in build_revoke_statements(username):
                    await asyncpg_conn.execute(statement)
    finally:
        await engine.dispose()

    logger.info(
        f"App role {username!r} bootstrapped over {len(schemas)} schema(s)",
        extra={"app_role": username, "schemas": schemas},
    )
    return {"bootstrapped": True, "role": username, "schemas": schemas}


def bootstrap_app_role() -> dict:
    """Sync entrypoint for the `biffo:db-init` Lambda event."""
    return asyncio.run(bootstrap_app_role_async())
