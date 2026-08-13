"""Shared plumbing for post-deploy plugin-manifest assertions.

`main.py`'s `lambda_handler` dispatches a small family of checks that all run
the same way: after DDL imports, against the real deployed database, reading
one or more bundled plugin manifests and failing the deploy loudly if what
the manifest promises isn't actually true. There are two, both dispatched
from `lambda_handler` and adjacent in the deploy workflow:

- `plugin_column_check.py` (`biffo:plugin-column-check`, biffo-template#1556)
  — "does a declared table have the columns the manifest promises?" Runs
  first: structure before content.
- `plugin_baseline_check.py` (`biffo:plugin-baseline-check`,
  biffo-template#1554) — "does a declared baseline table have rows?" Built
  first, and this module was factored out of it precisely so #1556 would
  reuse the plumbing rather than re-derive it. It did (see that module's
  "Reuse, not a second harness" section); a third check should too.

What's shared, and why each piece is worth sharing rather than re-deriving:

- **`SAFE_IDENTIFIER`** — table names in a bundled manifest are trusted at
  deploy time (the same trust boundary ADR-0005's raw DDL execution already
  extends) but still get interpolated directly into SQL as identifiers, which
  can never be bind parameters. Any check that builds a query from a
  manifest-declared table name needs this same validate-before-interpolate
  step; keeping it in one place means a widened or narrowed definition only
  needs to be justified once.
- **`plugin_manifests()`** — every check takes an optional `manifests`
  override (real discovery via `plugins.discover_plugin_manifests()` when
  omitted) so a test can assert against a fixed manifest list without needing
  bundled files on disk. `main.py`'s own `_run_ddl_import` establishes the
  same "explicit override for tests, real discovery in production" shape for
  `directory`.
- **`open_master_engine()`** — every check reads real rows/schema through the
  master/owner connection (the same one Alembic and DDL imports use), honours
  the request path's `search_path` (`database._connect_args_for`) so it finds
  a DDL-imported table exactly where the live application would, and skips
  itself on a non-Postgres deployment the same way `crud_schema_guard.py`
  does — its error handling and connection setup are Postgres-shaped, and a
  non-Postgres deployment is not what these checks exist to protect.
"""

from __future__ import annotations

import re
from typing import Any

from aws_lambda_powertools import Logger
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

logger = Logger()

#: Mirrors the table-name pattern the manifest schema itself enforces
#: (`plugin-manifest.ts`, `plugin_table.py`, the SDK's `TableDefinition`).
SAFE_IDENTIFIER = re.compile(r"^[a-z][a-z0-9_]*$")


def plugin_manifests(manifests: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """`manifests` if given (test injection), else real discovery via
    `plugins.discover_plugin_manifests()`. See the module docstring."""
    if manifests is not None:
        return manifests
    from .plugins import discover_plugin_manifests

    return discover_plugin_manifests()


async def open_master_engine() -> tuple[AsyncEngine, None] | tuple[None, dict[str, Any]]:
    """An async engine on the master/owner connection, or `(None, result)`
    with a ready-to-return summary dict when this deployment is not Postgres.

    Callers do:

        engine, skip = await open_master_engine()
        if engine is None:
            return skip  # {"checked": 0, ..., "reason": "not-postgres"}
        try:
            ...
        finally:
            await engine.dispose()

    `hide_parameters=True` matches every other engine in this service (#85):
    a failing statement must not put connection parameters in a traceback.
    """
    from .config import settings
    from .database import _connect_args_for, resolve_master_database_url
    from .db_app_role import is_postgres

    master_url = resolve_master_database_url()
    if not is_postgres(master_url):
        logger.info("Not a Postgres deployment — skipping post-deploy plugin manifest check")
        return None, {"checked": 0, "reason": "not-postgres"}

    engine = create_async_engine(
        master_url,
        hide_parameters=True,
        connect_args=_connect_args_for(settings.db_search_path),
    )
    return engine, None
