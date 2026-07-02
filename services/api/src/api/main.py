import asyncio

from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.typing import LambdaContext
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from mangum import Mangum

from .config import settings
from .routers import auth, health, users
from .routers.admin import plugins as admin_plugins

logger = Logger()
tracer = Tracer()

app = FastAPI(
    title="Biffo Core API",
    version="0.0.0",
    docs_url="/api/docs" if settings.environment != "prod" else None,
    redoc_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router, prefix="/api/v1")
app.include_router(auth.router, prefix="/api/v1")
app.include_router(users.router, prefix="/api/v1")
app.include_router(admin_plugins.router, prefix="/api/v1")

handler = Mangum(app, lifespan="off")


@logger.inject_lambda_context
@tracer.capture_lambda_handler
def lambda_handler(event: dict, context: LambdaContext) -> dict:
    if event.get("source") == "biffo:db-init":
        return _run_db_init()
    # asyncio.run() used internally by alembic/asyncpg sets the current event loop
    # to None when it exits, causing asyncio.get_event_loop() (used by Mangum) to
    # raise RuntimeError in Python 3.12+. Recreate the loop before each HTTP call.
    asyncio.set_event_loop(asyncio.new_event_loop())
    return handler(event, context)  # type: ignore[reportArgumentType]


def _run_db_init() -> dict:
    from pathlib import Path

    from alembic import command
    from alembic.config import Config

    from .migrations.plugin_migrations import sync_plugin_migrations

    cfg = Config("alembic.ini")

    # Auto-register plugin tables (ADR-0003 / issue #18): generate any
    # migration files for installed-but-not-yet-migrated plugins *before*
    # upgrading, so they're picked up and applied by the same upgrade("head")
    # call below — manifest -> migration file -> applied table, in one
    # db-init run. Idempotent and a no-op when no plugins are discoverable
    # (see api.plugins module docstring for when that's the case).
    versions_dir = (
        Path(cfg.get_main_option("script_location") or "migrations") / "versions"
    )
    generated = sync_plugin_migrations(versions_dir)
    if generated:
        logger.info(
            f"Generated {len(generated)} plugin migration(s): {[p.name for p in generated]}"
        )

    command.upgrade(cfg, "head")
    logger.info("Database schema at head")
    return {"ok": True}
