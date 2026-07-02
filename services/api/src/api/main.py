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
    if event.get("source") == "biffo:ddl-import":
        return _run_ddl_import(event.get("directory"))
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


def _run_ddl_import(directory: str | None) -> dict:
    """Apply a bundled DDL import's `.sql` files (ADR-0005). See
    api.ddl_import's module docstring for how `directory` reaches the
    deployed Lambda, and this function's inline comments for why the whole
    batch runs on one persistent connection rather than one per file.

    Constructs its own engine from settings.database_url read live at call
    time, the same way migrations/env.py does for Alembic — not
    database.py's module-level engine/AsyncSessionLocal, which are
    constructed once from settings at first import and don't pick up a
    settings change afterwards (relevant for tests; in a real deployment
    settings.database_url is fixed for the container's lifetime either way).
    """
    import hashlib
    import uuid
    from pathlib import Path

    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import (
        AsyncEngine,
        async_sessionmaker,
        create_async_engine,
    )

    from .config import settings
    from .ddl_import import (
        _configured_ddl_import_root,
        discover_ddl_import_dirs,
        list_sql_files,
    )
    from .models.ddl_import_history import DdlImportHistory

    root = _configured_ddl_import_root()
    available = discover_ddl_import_dirs(root)

    if not directory:
        raise ValueError(
            "biffo:ddl-import event requires a 'directory'. "
            f"Available: {available or '(none bundled)'}"
        )

    sql_files = list_sql_files(root / directory)
    if not sql_files:
        raise ValueError(
            f"No .sql files found for DDL import {directory!r} at {root / directory}. "
            f"Available: {available or '(none bundled)'}"
        )

    async def _apply() -> dict:
        engine = create_async_engine(settings.database_url)
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        try:
            return await _apply_batch(engine, session_factory)
        finally:
            await engine.dispose()

    async def _apply_batch(
        engine: AsyncEngine, session_factory: async_sessionmaker
    ) -> dict:
        applied: list[str] = []
        skipped: list[str] = []
        to_execute: list[tuple[Path, str, str]] = []

        # Read phase: figure out which files are new, already-applied (skip),
        # or changed-since-applied (hard error, halting before anything is
        # executed) — via the ORM, like every other table read in this app.
        async with session_factory() as session:
            for sql_file in sql_files:
                content = sql_file.read_text(encoding="utf-8")
                checksum = hashlib.sha256(content.encode("utf-8")).hexdigest()
                existing = await session.scalar(
                    select(DdlImportHistory).where(
                        DdlImportHistory.tenant_id == "default",
                        DdlImportHistory.import_name == directory,
                        DdlImportHistory.filename == sql_file.name,
                    )
                )
                if existing is not None:
                    if existing.checksum == checksum:
                        skipped.append(sql_file.name)
                        continue
                    raise ValueError(
                        f"DDL file {sql_file.name!r} in import {directory!r} has "
                        f"changed since it was applied (checksum {existing.checksum} "
                        f"-> {checksum}). This tool does not support modifying "
                        "already-applied DDL — add a new file instead."
                    )
                to_execute.append((sql_file, content, checksum))

        if to_execute:
            # One connection for the entire batch — session-level state (e.g.
            # SET search_path, which real DDL sets like
            # tabsii-data-model-design's 000/011 files use) set by an earlier
            # file must persist for later files in the same run; a fresh
            # connection per file would silently reset it. Each file still
            # gets its own transaction, so a mid-batch failure leaves
            # already-applied files committed and re-runnable.
            async with engine.connect() as conn:
                raw = await conn.get_raw_connection()
                asyncpg_conn = raw.driver_connection
                assert asyncpg_conn is not None  # noqa: S101 — narrows for pyright; always set once connected
                for sql_file, content, checksum in to_execute:
                    async with asyncpg_conn.transaction():
                        # Raw driver execute, not SQLAlchemy's text() — text()
                        # parses `:name`-style bind markers out of the SQL,
                        # a real risk against arbitrary DDL. asyncpg's simple
                        # query protocol (no bind params) sends the whole
                        # multi-statement string to Postgres as-is, correctly
                        # handling semicolons embedded inside $$...$$
                        # dollar-quoted function bodies.
                        await asyncpg_conn.execute(content)
                        # Recorded via raw SQL in the same transaction as the
                        # DDL itself (not a separate ORM session) so applying
                        # a file and recording it are atomic — a crash
                        # between the two could otherwise leave a file
                        # applied-but-unrecorded, which would then error on
                        # retry (this DDL has no IF NOT EXISTS guards).
                        await asyncpg_conn.execute(
                            "INSERT INTO ddl_import_history "
                            "(id, tenant_id, import_name, filename, checksum) "
                            "VALUES ($1, $2, $3, $4, $5)",
                            str(uuid.uuid4()),
                            "default",
                            directory,
                            sql_file.name,
                            checksum,
                        )
                    applied.append(sql_file.name)
                    logger.info(
                        f"Applied DDL file {sql_file.name} for import {directory!r}"
                    )

        return {"ok": True, "applied": applied, "skipped": skipped}

    return asyncio.run(_apply())
