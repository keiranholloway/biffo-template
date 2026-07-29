import json
from collections.abc import AsyncGenerator
from functools import lru_cache

import boto3
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from .config import settings


def _fetch_secret(secret_arn: str) -> dict:
    client = boto3.client("secretsmanager")
    return json.loads(client.get_secret_value(SecretId=secret_arn)["SecretString"])


def _url_from_secret(secret: dict) -> str:
    # db_host overrides the secret's host field — used to point at the RDS Proxy
    # endpoint instead of the direct RDS address when the proxy is enabled.
    host = settings.db_host or secret["host"]
    return (
        f"postgresql+asyncpg://{secret['username']}:{secret['password']}"
        f"@{host}:{secret['port']}/{secret['dbname']}"
    )


@lru_cache(maxsize=1)
def resolve_master_database_url() -> str:
    """The owner/master connection URL.

    This is the RDS master user: table owner, `rds_superuser`. It creates and
    alters objects, so it is what Alembic migrations, `biffo:db-init` and
    `biffo:ddl-import` (ADR-0005) connect as. The request path must NOT use it
    — see `resolve_app_database_url`.

    Built from Secrets Manager when running in AWS, or from the env var for
    local development and no-NAT dev environments where Terraform bakes the
    full URL in (the Lambda there has no route to Secrets Manager).
    """
    if not settings.db_secret_arn:
        return settings.database_url
    return _url_from_secret(_fetch_secret(settings.db_secret_arn))


@lru_cache(maxsize=1)
def resolve_app_database_url() -> str:
    """The least-privilege connection URL used by the HTTP request path (#253).

    Resolves to the `biffo_app` role — `NOSUPERUSER`, non-owner, holding only
    `USAGE` on the schemas it reads plus `SELECT/INSERT/UPDATE/DELETE` on their
    tables. It cannot create, drop or alter anything, so a SQL injection or a
    compromised dependency on a query path can no longer reach beyond the rows
    the API already serves.

    **Falls back to the master URL when no app credential is configured.** That
    is deliberate: this seam ships ahead of the Terraform that provisions the
    second secret, and an instance that upgrades its core before re-applying
    its infrastructure must keep serving traffic rather than fail closed on
    every request. The fallback is logged loudly as a warning by
    `log_effective_db_identity()`, which `db-init` calls on every deploy, so a
    deployment sitting on it is visible rather than silent.
    """
    if settings.app_db_secret_arn:
        return _url_from_secret(_fetch_secret(settings.app_db_secret_arn))
    if settings.app_database_url:
        return settings.app_database_url
    return resolve_master_database_url()


def app_role_credentials() -> tuple[str, str] | None:
    """The `(username, password)` `db-init` should bootstrap into Postgres, or
    None when this deployment has no app credential provisioned yet.

    Parsed with SQLAlchemy's own `make_url` rather than `urllib.parse` so the
    username/password read here are byte-identical to the ones the engine will
    later connect with — a generic URL parser disagrees with SQLAlchemy about
    `#` and `?` in a password, and silently bootstrapping a different password
    than the request path uses would authenticate-fail every request.
    """
    if settings.app_db_secret_arn:
        secret = _fetch_secret(settings.app_db_secret_arn)
        return secret["username"], secret["password"]
    if settings.app_database_url:
        url = make_url(settings.app_database_url)
        if url.username and url.password:
            return url.username, url.password
    return None


# NullPool — no application-side connection pooling. Two independent reasons,
# either of which is sufficient:
#
# 1. It is actively harmful on Lambda. The engine is constructed once at import
#    and lives for the whole warm container, but an asyncpg connection is bound
#    to the event loop it was opened on. A retained pool therefore hands a later
#    invocation a connection whose loop is gone, and every await on it raises
#    `RuntimeError: <Future ...> attached to a different loop` — the intermittent
#    ~50% 500s on every DB-touching endpoint this replaces. (main.py now reuses
#    one loop per warm container, which narrows the window, but does not close
#    it: a loop can still be replaced under a pooled connection, and Lambda
#    freezes the container between invocations regardless.)
# 2. It is redundant. This architecture puts RDS Proxy in front of Postgres, so
#    pooling and connection reuse are the proxy's job. Pooling again in-process
#    multiplies idle connections against the proxy's own limit without adding
#    anything — the proxy already absorbs the per-connection setup cost that an
#    application pool exists to amortise.
def _connect_args_for(search_path: str) -> dict[str, object]:
    """asyncpg connect args for the engine. When a schema search_path is
    configured (settings.db_search_path), apply it via ``server_settings`` so it
    is set at connection startup — every connection gets it, unlike a one-off
    ``SET``/``ALTER ROLE``. Needed for ADR-0005 DDL-imported tables mapped by bare
    name in another schema; empty by default so the base template is unaffected
    (#458, backported from tabsii)."""
    if search_path:
        return {"server_settings": {"search_path": search_path}}
    return {}


engine = create_async_engine(
    resolve_app_database_url(),
    # Both arguments are load-bearing — see the `sql_echo` comment in config.py.
    # `echo` is off unless someone explicitly sets BIFFO_SQL_ECHO (no Biffo
    # environment does), and `hide_parameters` keeps the values out of the log
    # even then — and out of StatementError messages regardless.
    echo=settings.sql_echo,
    hide_parameters=True,
    poolclass=NullPool,
    connect_args=_connect_args_for(settings.db_search_path),
)

AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def get_db() -> AsyncGenerator[AsyncSession]:
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        else:
            # Publish buffered state-change events only after the commit succeeds
            # (ADR-0002, epic #222) — never on a rolled-back transaction.
            from .events.emit import publish_pending

            await publish_pending(session)
