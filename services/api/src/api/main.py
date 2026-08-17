import asyncio

from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.typing import LambdaContext
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from mangum import Mangum

from .config import settings
from .dependencies import require_principal_crud_permission
from .routers import (
    agent_chat,
    auth,
    health,
    internal_agent_chat,
    internal_agents,
    internal_media_generations,
    internal_orchestration,
    internal_plugin_config,
    internal_plugin_storage,
    orchestration,
    users,
    whoami,
)
from .routers.admin import agent_chat as admin_agent_chat
from .routers.admin import agent_runs as admin_agent_runs
from .routers.admin import endpoints as admin_endpoints
from .routers.admin import groups as admin_groups
from .routers.admin import media_generations as admin_media_generations
from .routers.admin import orchestration as admin_orchestration
from .routers.admin import organizations as admin_organizations
from .routers.admin import plugin_chat_agents as admin_plugin_chat_agents
from .routers.admin import plugins as admin_plugins
from .routers.admin import prompt_components as admin_prompt_components
from .routers.admin import users as admin_users
from .routing.chat_agent_registration import register_plugin_chat_agents
from .routing.core_crud_router import build_core_crud_router
from .routing.domain_router import build_domain_router
from .routing.owner_data_router import build_owner_data_router
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
app.include_router(admin_groups.router, prefix="/api/v1")
app.include_router(admin_organizations.router, prefix="/api/v1")
app.include_router(admin_users.router, prefix="/api/v1")
# Admin read surface for agent runs (ADR-0014): Cognito-authed, admin-gated,
# tenant-scoped, read-only, under /api/v1/admin/agent-runs. Runs are written
# only through the internal SigV4 API above; this is the operator/portal reader.
app.include_router(admin_agent_runs.router, prefix="/api/v1")
app.include_router(admin_media_generations.router, prefix="/api/v1")
# Prompt assistant (ADR-0016): Cognito-authed, admin-gated synchronous chat spine
# under /api/v1/admin/agent-chat. Core assembles the turn under the user's
# authority and synchronously invokes the agent-runtime Lambda for the LLM turn.
app.include_router(admin_agent_chat.router, prefix="/api/v1")
app.include_router(agent_chat.router, prefix="/api/v1")
# Prompt-library component CRUD (ADR-0015 Phase 1): Cognito-authed, admin-gated,
# tenant-scoped, under /api/v1/admin/prompt-components. The authoring surface for
# reusable prompt components until the Phase-2 portal UI.
app.include_router(admin_prompt_components.router, prefix="/api/v1")
# Live-editable plugin chat agents (ADR-0017 seam #1 extension): Cognito-authed,
# admin-gated, tenant-scoped CRUD under /api/v1/admin/plugins/{plugin_name}/chat-agents.
# Allows opted-in plugins to have their agent config be runtime-editable without
# a redeploy via the internal_agent_chat.py fallback.
app.include_router(admin_plugin_chat_agents.router, prefix="/api/v1")
# Internal service-only orchestration API (ADR-0009): reachable only by an
# allowlisted IAM principal (the engine plugin), under /api/v1/internal/*.
app.include_router(internal_orchestration.router, prefix="/api/v1")
# Internal service-only agent-run API (ADR-0009 / ADR-0014): the agent runtime
# requests, reads and completes runs here, under /api/v1/internal/*.
app.include_router(internal_agents.router, prefix="/api/v1")
app.include_router(internal_media_generations.router, prefix="/api/v1")
app.include_router(internal_plugin_storage.router, prefix="/api/v1")
app.include_router(internal_agent_chat.router, prefix="/api/v1")
# Internal service-only plugin config read (ADR-0009): a plugin reads its own
# admin-set config row from plugin_chat_agents, scoped by SigV4 identity alone,
# under /api/v1/internal/plugins/me/config/{role}.
app.include_router(internal_plugin_config.router, prefix="/api/v1")
# User-facing orchestration workflow CRUD (the portal builder): Cognito-authed,
# admin-gated, under /api/v1/orchestration/workflows, plus the read-only run
# history under /api/v1/orchestration/runs.
app.include_router(orchestration.router, prefix="/api/v1")
app.include_router(orchestration.runs_router, prefix="/api/v1")
# No-side-effect workflow dry-run (issue #527): Cognito-authed, admin-gated,
# tenant-scoped, under /api/v1/admin/orchestration/test. Previews one agent turn
# for a draft workflow via the ADR-0016 sync-invoke seam; persists/emits nothing.
app.include_router(admin_orchestration.router, prefix="/api/v1")
# Auto-register plugin-declared routes (ADR-0003 chunk 6 / issue #19), after
# the native routers so they group after them in the OpenAPI/Swagger docs.
# Scans services/*/biffo.plugin.json at import time (build_plugin_router
# defaults to discover_plugin_manifests()); see api.plugins' module
# docstring for how each installed plugin's manifest reaches the deployed
# Lambda.
app.include_router(build_plugin_router(), prefix="/api/v1")
# The same declared routes again, under /api/v1/internal/plugins/<name>/<path>
# (#652). API Gateway sends ALL of /api/v1/plugins/* to the shared plugin host
# (ADR-0021's `ANY /api/v1/plugins/{proxy+}`), so the public mount above — which
# Core registers correctly — is unaddressable from outside: a plugin calling it
# is routed back into the plugin host, never to Core. /api/v1/internal/* is
# IAM-authorized and does reach Core, so this mount is what the host forwards to.
#
# Same routes, same handlers, same permission rules; the only difference is the
# guard, which accepts the caller's token from either transport instead of
# requiring a bearer header a SigV4-signed request cannot send.
app.include_router(
    build_plugin_router(
        path_prefix="/internal/plugins",
        guard_factory=require_principal_crud_permission,
    ),
    prefix="/api/v1",
)
# Owner-scoped, service-authenticated data routes (ADR-0017 §5) for plugin tables
# that declare `owner_scoped_service`, under /api/v1/internal/owner-data/<table>.
# Empty in the base deployment (no plugin installed); the owning module's Lambda
# manages its own CRUD-closed rows here, dual-authed and owner-scoped.
app.include_router(build_owner_data_router(), prefix="/api/v1")
# Register each installed plugin's chat agents (ADR-0017 seam #1) from its manifest,
# so /api/v1/internal/agent-chat/<key> resolves a plugin's install-vetted agent the
# same way the in-code prompt assistant is registered. Empty in the base deployment.
register_plugin_chat_agents()
# Instance product-domain routers (ADR-0022): an instance's own product code
# lives in the user-owned services/api/src/api/domains/<name>/ carve-out inside
# this template-owned core API. Each domain keeps its native paths (no
# /domains/<name> namespacing), so a relocated domain serves the same routes it
# did before — the contract to siblings is unchanged. Empty in the base
# deployment (no product domain yet); see api.routing.domain_router.
#
# THIS MUST STAY ABOVE build_core_crud_router() — the order is load-bearing,
# not cosmetic (#668). Building this router is what *imports* each
# api.domains.<name> package, and that import is what puts the domain's models
# on TenantScopedModel.__subclasses__(); build_core_crud_router() below walks
# exactly that subclass tree via _iter_core_crud_models() (permissions.py), so
# it can only serve models already imported by the time it runs. With these two
# the other way round, every /api/v1/data/<table> route a relocated domain
# backs silently disappeared — 21 of them in tabsii-platform#207, with a green
# suite and a green CI, because nothing failed and nothing warned.
#
# Mounting domains first is safe only while no domain claims a (path, method)
# pair generic CRUD also claims: a domain hand-writing POST /data/brands
# coexists with generic CRUD's GET /data/brands purely because Starlette keeps
# looking past a *method*-mismatched route. Both that ordering and that
# non-collision are asserted in tests/test_main_router_ordering.py.
app.include_router(build_domain_router(), prefix="/api/v1")
# Generic CRUD for opt-in core tables (ADR-0004): core TenantScopedModel
# subclasses declaring __crud_permissions__ are served under /api/v1/data/
# <table>. Empty in the base deployment (no core table opts in yet). Runs after
# the domain router above so it sees an instance's domain models too — see the
# comment there before reordering.
app.include_router(build_core_crud_router(), prefix="/api/v1")
# The whoami contract the template-owned portal login page consumes, LAST so
# that an instance serving its own richer /whoami from a product domain (with
# real scoped roles) keeps it — Starlette takes the first matching route, so
# registering this any earlier would shadow that with core's honest empties and
# route every scoped user to no-access. Asserted in
# tests/test_whoami.py; see routers/whoami.py for the full why.
app.include_router(whoami.router, prefix="/api/v1")

handler = Mangum(app, lifespan="off")

# One event loop per warm container, reused across invocations. Mangum calls
# asyncio.get_event_loop(), which raises RuntimeError in Python 3.12+ when no
# loop is installed on the current thread -- and _run_db_init/_run_ddl_import's
# asyncio.run() (also used internally by alembic/asyncpg) leaves exactly that
# state behind, since asyncio.run() closes its loop and sets the thread's
# current loop to None on exit.
#
# This used to be an unconditional `asyncio.set_event_loop(new_event_loop())` on
# every HTTP invocation, which fixed the RuntimeError but built a fresh loop
# each time: the previous loop was never closed, so its selector fd (plus
# whatever it still referenced) leaked for the container's lifetime, and
# anything cached against the old loop became unusable. Instead, keep one loop
# and only *re-install* it when something cleared the thread's current loop.
_event_loop: asyncio.AbstractEventLoop | None = None


def _ensure_event_loop() -> asyncio.AbstractEventLoop:
    """Return this container's event loop, installing it as the current loop.

    Creates the loop on first use, and again only if it has been closed.
    set_event_loop() is idempotent, so re-installing an already-current loop is
    a no-op -- it just repairs the None left behind by an asyncio.run().
    """
    global _event_loop
    if _event_loop is None or _event_loop.is_closed():
        _event_loop = asyncio.new_event_loop()
    asyncio.set_event_loop(_event_loop)
    return _event_loop


@logger.inject_lambda_context
@tracer.capture_lambda_handler
def lambda_handler(event: dict, context: LambdaContext) -> dict:
    if event.get("source") == "biffo:db-init":
        return _run_db_init()
    if event.get("source") == "biffo:ddl-import":
        return _run_ddl_import(event.get("directory"))
    if event.get("source") == "biffo:plugin-column-check":
        # Fail the deploy loudly if a plugin's manifest declares a column the
        # database does not have (biffo-template#1556). Core builds each
        # plugin's SQLAlchemy model from the manifest, so the two can disagree
        # and every query touching the column then 500s at runtime.
        #
        # Dispatched from the deploy workflow after DDL imports (every writer
        # of schema has had its turn) and BEFORE the baseline-row check below:
        # structure before content. A missing tenant_id would otherwise
        # surface first as the row check failing to read the table at all,
        # which is a true failure with a far worse message.
        from .plugin_column_check import assert_plugin_columns_exist

        return assert_plugin_columns_exist()
    if event.get("source") == "biffo:plugin-baseline-check":
        # Fail the deploy loudly if a plugin's declared baseline table has no
        # rows for a tenant this deployment already knows about
        # (biffo-template#1554) — run from the deploy workflow after DDL
        # imports, so any plugin-vendored seed has already had its chance to
        # apply. See plugin_baseline_check's module docstring.
        #
        # These two are siblings, deliberately: #1556 above asks "are the
        # declared columns there?", this one "are the declared rows there?".
        # Both reuse plugin_deploy_checks.py's manifest-injection/Postgres-
        # engine harness rather than each carrying its own.
        from .plugin_baseline_check import assert_plugin_baselines_populated

        return assert_plugin_baselines_populated()
    _ensure_event_loop()
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
    from .permissions import (
        build_permissions_registry,
        log_unreachable_permission_codes,
        serialize_registry,
    )

    registry = build_permissions_registry(strict=True)
    logger.info(
        f"Permissions registry: {len(registry)} table(s) declare CRUD permissions",
        extra={"crud_permissions": serialize_registry(registry)},
    )
    # #1606: a plugin can declare a permission_code this instance never grants
    # to anyone — enforcement already denies it to everyone (fail-closed), but
    # that looks identical to a table nobody uses. Name the unreachable codes
    # at deploy time, the same "mount" moment the registry summary above logs.
    log_unreachable_permission_codes(registry)

    # The step above proves the declared CRUD surface is well-formed; this one
    # proves it is *real* (#1018). A DDL-imported table's schema is written by
    # hand, outside the model, so a model can declare `tenant_id` — which
    # generic CRUD filters every query by, unconditionally — against a table
    # that has no such column. Nothing compared the two, and the API test lane
    # structurally cannot: it builds its schema from the same ORM metadata, so
    # the column is present *because the model declared it*. The mismatch
    # therefore surfaced on a live click-through, twice.
    #
    # Runs after the upgrade, so it sees the schema at head, and fails the
    # deploy rather than letting the first real request 500.
    #
    # ...unless this instance builds its schema in TWO phases. Alembic is only
    # the first: an ADR-0005 instance creates most of its generic-CRUD tables
    # from `db/imports/<name>/*.sql`, applied by `_run_ddl_import` in a LATER,
    # separate Lambda invocation. Checking here would then compare the models
    # against a schema that is deliberately half-built, report every imported
    # table as missing, and fail the deploy on a schema that is entirely
    # correct — which is what happened to tabsii-platform, whose own #499
    # switched the check off altogether to get deploys moving again.
    #
    # So the guard runs at the end of whichever phase is LAST. If this instance
    # ships any DDL import, defer to `_run_ddl_import`; otherwise this is the
    # last phase and it runs now.
    from .crud_schema_guard import assert_crud_schema_matches
    from .ddl_import import _configured_ddl_import_root, discover_ddl_import_dirs

    pending_imports = discover_ddl_import_dirs(_configured_ddl_import_root())
    if pending_imports:
        logger.info(
            "CRUD schema check deferred to the DDL import — this instance's "
            f"schema is not complete until {pending_imports} is applied",
            extra={"deferred_to": "ddl-import", "imports": pending_imports},
        )
        crud_schema: dict = {"checked": 0, "deferred": "ddl-import"}
    else:
        crud_schema = assert_crud_schema_matches()

    # Create/refresh the least-privilege `biffo_app` role the request path
    # connects as (#253). Runs *after* the upgrade, so the grants cover every
    # table the migrations just created. This connection is the master user —
    # administering privileges is exactly what the app role must not be able to
    # do. Idempotent, and a no-op on non-Postgres deployments.
    from .db_app_role import bootstrap_app_role

    app_role = bootstrap_app_role()

    return {"ok": True, "app_role": app_role, "crud_schema": crud_schema}


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
        ddl_import_environment,
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
        # hide_parameters everywhere, not just on the request-path engine:
        # SQLAlchemy embeds bound values in StatementError messages, so a failing
        # statement leaks them via the traceback whether echo is on or not (#85).
        engine = create_async_engine(settings.database_url, hide_parameters=True)
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        try:
            result = await _apply_batch(engine, session_factory)
        finally:
            await engine.dispose()

        # Re-run the app-role grants (#253). A DDL import creates schemas and
        # tables the master user owns (ADR-0005), and db_app_role's ALTER
        # DEFAULT PRIVILEGES only covers schemas that already existed when it
        # last ran — so without this, an import's new schema would be
        # unreadable by the request path until the next deploy, which surfaces
        # as a 5xx rather than a test failure. Idempotent; no-op off Postgres.
        from .db_app_role import bootstrap_app_role_async

        result["app_role"] = await bootstrap_app_role_async()

        # NOW the schema is complete, so this is where the generic-CRUD check
        # belongs for a two-phase instance (#1018, and see the deferral note in
        # `_run_db_init`). Alembic ran in the earlier invocation; the `.sql`
        # files above created the rest. Checking any earlier compares the
        # models against a half-built schema and fails a deploy that should
        # have passed.
        #
        # It still FAILS the deploy — that is the whole point of the guard, and
        # the DDL import is the last thing standing between a declared CRUD
        # surface and a live request that would 500 on it.
        from .crud_schema_guard import assert_crud_schema_matches_async

        result["crud_schema"] = await assert_crud_schema_matches_async()
        return result

    async def _apply_batch(engine: AsyncEngine, session_factory: async_sessionmaker) -> dict:
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

                # Publish the deployment's environment as a session-level GUC
                # (tabsii-platform#830) so a module's own guard can see it via
                # current_setting('biffo.environment', true) — same pattern as
                # the SET search_path idiom noted above: it must be set once,
                # on THIS connection, before any file runs, so it is visible
                # to every file in the batch. set_config's third argument
                # (is_local) is false, i.e. session-scoped like SET, not
                # transaction-scoped, so it survives each file's own
                # transaction commit/rollback below.
                #
                # Only set when BIFFO_ENVIRONMENT actually has a value — see
                # ddl_import_environment's docstring for why leaving the GUC
                # completely unset (rather than publishing "" or falling back
                # to settings.environment's "dev" default) is what makes an
                # environment that forgot to set it seed nothing instead of
                # seeding by accident.
                env_value = ddl_import_environment()
                if env_value is not None:
                    await asyncpg_conn.execute(
                        "SELECT set_config('biffo.environment', $1, false)", env_value
                    )

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
                    logger.info(f"Applied DDL file {sql_file.name} for import {directory!r}")

        return {"ok": True, "applied": applied, "skipped": skipped}

    return asyncio.run(_apply())
