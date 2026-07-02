import asyncio

from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.typing import LambdaContext
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from mangum import Mangum

from .config import settings
from .routers import auth, health, users
from .routers.admin import plugins as admin_plugins
from .routing.plugin_router import build_plugin_router

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
# Auto-register plugin-declared routes (ADR-0003 chunk 6 / issue #19), after
# the native routers so they group after them in the OpenAPI/Swagger docs.
# Scans services/*/biffo.plugin.json at import time (build_plugin_router
# defaults to discover_plugin_manifests()); see api.plugins' module
# docstring for how each installed plugin's manifest reaches the deployed
# Lambda.
app.include_router(build_plugin_router(), prefix="/api/v1")

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
    import shutil
    import tempfile
    from pathlib import Path

    from alembic import command
    from alembic.config import Config

    from .migrations.plugin_migrations import sync_plugin_migrations

    cfg = Config("alembic.ini")

    # Generating a plugin migration file means writing into versions/ (see
    # plugin_migrations.generate_migration_for_plugin) — but script_location
    # (env.py, script.py.mako, the bundled versions/) is part of the Lambda
    # deployment package, which AWS extracts read-only. Copy the bundled
    # versions/ into the platform temp dir (the one writable path in a
    # Lambda execution environment — /tmp there) and redirect Alembic there
    # via version_locations, same mechanism as
    # test_plugin_migrations_integration.py's alembic_setup fixture.
    # script_location itself is untouched: env.py/script.py.mako are only
    # ever read, never written.
    bundled_versions_dir = (
        Path(cfg.get_main_option("script_location") or "migrations") / "versions"
    )
    versions_dir = Path(tempfile.gettempdir()) / "migrations_versions"
    if versions_dir.exists():
        shutil.rmtree(versions_dir)
    shutil.copytree(bundled_versions_dir, versions_dir)
    cfg.set_main_option("version_locations", str(versions_dir))

    # Auto-register plugin tables (ADR-0003 / issue #18): generate any
    # migration files for installed-but-not-yet-migrated plugins *before*
    # upgrading, so they're picked up and applied by the same upgrade("head")
    # call below — manifest -> migration file -> applied table, in one
    # db-init run. Idempotent and a no-op when no plugins are discoverable
    # (see api.plugins module docstring for when that's the case).
    generated = sync_plugin_migrations(versions_dir)
    if generated:
        logger.info(
            f"Generated {len(generated)} plugin migration(s): {[p.name for p in generated]}"
        )

    command.upgrade(cfg, "head")
    logger.info("Database schema at head")
    return {"ok": True}
