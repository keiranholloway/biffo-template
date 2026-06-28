import json
from collections.abc import AsyncGenerator
from functools import lru_cache

import boto3
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

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


engine = create_async_engine(
    _resolve_database_url(),
    echo=settings.environment == "dev",
    pool_pre_ping=True,
    pool_size=5,
    max_overflow=10,
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
