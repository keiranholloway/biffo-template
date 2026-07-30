import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy.ext.asyncio import create_async_engine

from src.api.config import settings
from src.api.models.base import Base

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=settings.database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    # Keep bound values out of StatementError tracebacks here too (#85):
    # a failing migration is exactly when the output gets read and pasted.
    # NO `connect_args` here, and that is load-bearing rather than an omission
    # (#764).
    #
    # `api/database.py` gives the *application* engine
    # `connect_args=_connect_args_for(settings.db_search_path)`, so every app
    # connection carries the instance's search path (#458, ADR-0005). Alembic's
    # engine deliberately does not, so migrations run on the default search path.
    #
    # Migration 0010's `_has_core_users_table()` depends on exactly that. It calls
    # an unqualified `sa.inspect(...).has_table("users")`, and it is *correct* only
    # because that resolves against the default path: an instance whose users live
    # in another schema — tabsii's `tabsii.users` — reads False, which is the right
    # answer, because those are not Core's to alter.
    #
    # Add a search path here and that guard silently starts finding a table it must
    # not touch, and a migration would `batch_alter_table` an instance's own users
    # table. Guarded by `test_alembic_engine_carries_no_search_path`.
    engine = create_async_engine(settings.database_url, hide_parameters=True)
    async with engine.connect() as connection:
        await connection.run_sync(
            lambda sync_conn: context.configure(
                connection=sync_conn, target_metadata=target_metadata
            )
        )
        async with connection.begin():
            await connection.run_sync(lambda _: context.run_migrations())
    await engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
