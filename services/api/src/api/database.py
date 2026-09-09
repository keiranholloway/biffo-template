import asyncio
import json
from collections.abc import AsyncGenerator
from urllib.parse import quote

from aws_lambda_powertools import Logger
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import NullPool

from .config import settings

logger = Logger()


def _fetch_secret(secret_arn: str) -> dict:
    import boto3

    client = boto3.client("secretsmanager")
    return json.loads(client.get_secret_value(SecretId=secret_arn)["SecretString"])


def _url_from_secret(secret: dict) -> str:
    # db_host overrides the secret's host field — used to point at the RDS Proxy
    # endpoint instead of the direct RDS address when the proxy is enabled.
    host = settings.db_host or secret["host"]
    # Defense in depth (#1888): percent-encode rather than trust the stored
    # credential's charset alone. quote(..., safe="") round-trips correctly
    # through SQLAlchemy's make_url — the parser create_async_engine uses
    # internally, and the only one any consumer of this URL relies on
    # (confirmed by direct test) — so a future credential containing a
    # URL-structural character (a literal '%' being the reproduced case here)
    # can no longer corrupt the connection URL this builds.
    user = quote(secret["username"], safe="")
    password = quote(secret["password"], safe="")
    return f"postgresql+asyncpg://{user}:{password}@{host}:{secret['port']}/{secret['dbname']}"


def resolve_master_database_url() -> str:
    """The owner/master connection URL.

    This is the RDS master user: table owner, `rds_superuser`. It creates and
    alters objects, so it is what Alembic migrations, `biffo:db-init` and
    `biffo:ddl-import` (ADR-0005) connect as. The request path must NOT use it
    — see `resolve_app_database_url`.

    Built from Secrets Manager when running in AWS, or from the env var for
    local development and no-NAT dev environments where Terraform bakes the
    full URL in (the Lambda there has no route to Secrets Manager).

    Deliberately uncached (#1725): this used to be `@lru_cache(maxsize=1)`,
    which memoises process-wide and is never invalidated. Under pytest-xdist
    every test in a worker shares that one process, so whichever test file a
    worker happened to run first silently decided the URL for every other
    test in it — including the module's own implicit first call at import
    time, when `engine` below is constructed. Six test files worked around
    that by reaching in and calling `.cache_clear()`; two others didn't know
    to. Removing the cache removes the shared mutable state those workarounds
    existed to reset, rather than adding another one that resets it for them.
    Call sites here are import-time or deploy/admin-time (db-init, the CRUD
    schema guard, plugin deploy checks) — none is a per-request hot path — so
    the cost of an extra Secrets Manager round trip is negligible next to the
    correctness this buys.
    """
    if not settings.db_secret_arn:
        return settings.database_url
    return _url_from_secret(_fetch_secret(settings.db_secret_arn))


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


def _build_engine() -> AsyncEngine:
    """Construct the request-path engine from *currently* resolved settings.

    Factored out of the module-level assignment below so it can be called
    again later, from `rebuild_engine_after_restore()` (#2003) — the same
    construction, re-run rather than reused, is what lets a SnapStart restore
    pick up a rotated credential instead of resuming whatever `resolve_app_
    database_url()` returned once, at import time, months before a given
    restore happens.
    """
    return create_async_engine(
        resolve_app_database_url(),
        # Both arguments are load-bearing — see the `sql_echo` comment in
        # config.py. `echo` is off unless someone explicitly sets
        # BIFFO_SQL_ECHO (no Biffo environment does), and `hide_parameters`
        # keeps the values out of the log even then — and out of
        # StatementError messages regardless.
        echo=settings.sql_echo,
        hide_parameters=True,
        poolclass=NullPool,
        connect_args=_connect_args_for(settings.db_search_path),
    )


engine = _build_engine()

AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def _prime_connection(target_engine: AsyncEngine) -> None:
    """Open and release one connection so its TCP/TLS/Postgres-startup cost is
    paid now, not on the first real request.

    NullPool means the connection this opens is not retained (see the module
    comment above `_build_engine` for why an app-side pool is not the fix
    here) — the very next request still opens its own. What this buys is
    *timing*, not a cache: SnapStart's restore phase already runs, and is
    measured, before the platform dispatches the invoke it restored for
    (tabsii-platform#1239 measured ~700ms for it, independent of anything
    this repo controls), so a connection opened here is one a concurrent
    burst of restores does not all have to open for the first time inside
    the handler `Duration` a user is waiting on.
    """
    async with target_engine.connect() as conn:
        await conn.execute(text("SELECT 1"))


def rebuild_engine_after_restore() -> None:
    """Re-derive the engine (and its session factory) from current state.

    `engine` is a module-level singleton built once, at import time (#2003) —
    exactly what a SnapStart snapshot captures. Every future restore of that
    snapshot resumes the identical object, however stale the credential or
    endpoint `resolve_app_database_url()` returned has become by the time a
    given restore actually happens, potentially long after the snapshot was
    taken and across many separate restores of it. NullPool means no live
    connection is captured — each request opens and releases its own, so
    there is no stale socket to worry about — but the URL/credentials baked
    into the engine object itself do not re-resolve on their own.

    Registered as the SnapStart `afterRestore` hook (main.py), so every
    restored container re-derives this rather than resuming whatever import
    time happened to capture (#2003's fix level 2: automatic, not a detector).

    Best-effort by construction, and the two try/excepts below are what make
    that true — `main.py` registers this function directly with
    `snapshot_restore_py` and wraps nothing around the call itself (its only
    try/except guards the *registration-time* `import snapshot_restore_py`,
    which is unrelated). So every failure mode this function can hit,
    including `_build_engine()` re-fetching a credential from Secrets
    Manager, has to be caught in here or it propagates uncaught out of the
    SnapStart `afterRestore` hook and fails that restore/invocation (#2015).
    Neither a credential re-fetch nor a warm-up connection is worth failing a
    restore over:

    - If `_build_engine()` or the sessionmaker construction raises, `engine`/
      `AsyncSessionLocal` are left untouched — still the pre-restore objects
      — so the next request opens its own connection through them exactly as
      it does today, same as if this hook had not run at all.
    - If only the warm-up connection below fails, the rebuild has already
      succeeded and is kept: `engine`/`AsyncSessionLocal` are the new
      objects, just not pre-warmed. The next request pays the connection
      cost itself, same as it always does under `NullPool`.
    """
    global engine, AsyncSessionLocal
    try:
        new_engine = _build_engine()
        new_session_local = async_sessionmaker(new_engine, expire_on_commit=False)
    except Exception:
        # Never let a rebuild failure (Secrets Manager throttled or briefly
        # unreachable at restore time, a mid-rotation credential, ...) fail
        # the restore itself. `engine`/`AsyncSessionLocal` are untouched
        # here, so the next real request falls back to today's behaviour: it
        # opens its own connection through the pre-restore engine, same as
        # if this hook did not exist.
        logger.warning("SnapStart afterRestore: engine rebuild failed", exc_info=True)
        return
    engine = new_engine
    AsyncSessionLocal = new_session_local
    try:
        asyncio.run(_prime_connection(engine))
    except Exception:
        # Never let a warm-up failure (DB briefly unreachable at restore time,
        # a mid-rotation credential, ...) fail the restore itself. The first
        # real request falls back to today's behaviour: it opens its own
        # connection, same as if this hook did not exist.
        logger.warning("SnapStart afterRestore: connection warm-up failed", exc_info=True)


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
