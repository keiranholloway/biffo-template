import json
from collections.abc import AsyncGenerator
from functools import lru_cache

import boto3
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from .config import settings


@lru_cache(maxsize=1)
def _resolve_database_url() -> str:
    """Build the SQLAlchemy URL from Secrets Manager when running in AWS,
    or fall back to the env var for local development."""
    if not settings.db_secret_arn:
        return settings.database_url

    client = boto3.client("secretsmanager")
    secret = json.loads(
        client.get_secret_value(SecretId=settings.db_secret_arn)["SecretString"]
    )
    # db_host overrides the secret's host field — used to point at the RDS Proxy
    # endpoint instead of the direct RDS address when the proxy is enabled.
    host = settings.db_host or secret["host"]
    return (
        f"postgresql+asyncpg://{secret['username']}:{secret['password']}"
        f"@{host}:{secret['port']}/{secret['dbname']}"
    )


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
engine = create_async_engine(
    _resolve_database_url(),
    echo=settings.environment == "dev",
    poolclass=NullPool,
)

AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
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
