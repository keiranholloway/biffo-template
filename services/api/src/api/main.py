import asyncio

from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.typing import LambdaContext
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from mangum import Mangum

from .config import settings
from .routers import auth, health, users
from .routers.admin import endpoints as admin_endpoints
from .routers.admin import plugins as admin_plugins
from .routing.core_crud_router import build_core_crud_router
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
app.include_router(admin_endpoints.router, prefix="/api/v1")
# Auto-register plugin-declared routes (ADR-0003 chunk 6 / issue #19), after
# the native routers so they group after them in the OpenAPI/Swagger docs.
# Scans services/*/biffo.plugin.json at import time (build_plugin_router
# defaults to discover_plugin_manifests()); see api.plugins' module
# docstring for how each installed plugin's manifest reaches the deployed
# Lambda.
app.include_router(build_plugin_router(), prefix="/api/v1")
# Generic CRUD for opt-in core tables (ADR-0004): core TenantScopedModel
# subclasses declaring __crud_permissions__ are served under /api/v1/data/
# <table>. Empty in the base deployment (no core table opts in yet).
app.include_router(build_core_crud_router(), prefix="/api/v1")

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
    from alembic import command
    from alembic.config import Config

    # Plugin table migrations are generated and committed at CLI time now
    # (`biffo plugin install`/`upgrade`/`sync-migrations`, via
    # services/api/scripts/generate_plugin_migrations.py) — not here. This
    # used to also copy the bundled versions/ into a writable /tmp dir and
    # dynamically generate any missing plugin migration before upgrading,
    # but that ran on every single Lambda invocation against a directory
    # wiped clean each time, so a generated migration's down_revision was
    # silently recomputed on every deploy and never actually persisted,
    # corrupting the revision graph the moment a later real migration was
    # added (see plugin_migrations.sync_plugin_migrations's docstring and
    # ADR-0003's implementation note for the incident this fixed).
    # `command.upgrade` below only reads migration scripts and writes to the
    # DB's alembic_version table — never to the script directory — so it can
    # use alembic.ini's bundled, read-only script_location directly.
    cfg = Config("alembic.ini")
    command.upgrade(cfg, "head")
    logger.info("Database schema at head")

    # Build the ADR-0004 permissions registry from the same bundled manifests
    # (+ core __crud_permissions__) at deploy time, strictly: a malformed
    # declaration or a plugin/core table-name collision fails the deploy here,
    # loudly, rather than silently vanishing from the registry at runtime (where
    # get_permissions_registry fails closed to all-denied). This does not touch
    # the database — it only validates and logs the declared CRUD surface.
    from .permissions import build_permissions_registry, serialize_registry

    registry = build_permissions_registry(strict=True)
    logger.info(
        f"Permissions registry: {len(registry)} table(s) declare CRUD permissions",
        extra={"crud_permissions": serialize_registry(registry)},
    )
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
