"""Deploy-time guard: a plugin's declared baseline table must actually have
rows, for every tenant this deployment already knows about (biffo-template#1554).

## The gap this closes

A plugin can declare `seed.baseline_tables` in its manifest (mirrored in
`cli/src/lib/plugin-manifest.ts`'s `SeedDeclarationSchema` and the SDK's
`SeedDeclaration`) and ship the seed DDL that is supposed to populate them,
vendored by `biffo plugin install`/`upgrade` into the instance's
`db/imports/_plugin-<name>/` and applied by the existing "Apply DDL imports"
deploy step (ADR-0005). Every step in that chain can succeed — the manifest
validates, the vendoring copies real files, the DDL import applies without
error — and the table can still end up empty: the plugin never declared
`seed` at all, `dir` pointed at an empty directory, the seed's own `WHERE NOT
EXISTS` clause matched nothing, or (the concrete incident this issue records)
a human forgot to run a script nobody was told to run. Every one of those
deploys clean and does nothing.

This module is the loud, specific failure the issue's "minimum useful step"
asks for: run *after* DDL imports, so any seed has already had its chance,
and fail the deploy by name rather than leaving the feature to render empty
until someone happens to check the data.

## What counts as a "known tenant"

There is no generic `tenants` table in the base template (ADR-0001: the
multi-tenant seam is schema-only, every table carries `tenant_id`, and it is
always `"default"` in a single-tenant deployment). A real multi-tenant
instance's own tenant registry is instance-owned DDL this module has no
visibility into.

So "known tenant" is defined the same way every tenant-scoped row in this
system already is: a distinct `tenant_id` value that appears in `users` —
Core's own Alembic-managed table, present in every deployment by the time
this check runs (it is created at `alembic upgrade head`, which the deploy's
db-init step runs before DDL imports, which run before this check). A tenant
with no user yet has nothing to seed for anyway, so a deployment with zero
users produces zero known tenants and the check passes vacuously — there is
nothing to have failed to seed. The moment any tenant has a `users` row
(which, per ADR-0001, is how a tenant comes to exist at all — someone signs
in), every declared baseline table is expected to have rows for it.

## Why this queries via `search_path`, not `information_schema`

`crud_schema_guard.py`'s schema-drift check resolves each table's *actual*
schema explicitly (`resolve_search_schemas()` against
`information_schema.columns`) because it needs to compare declared columns
against real ones regardless of where a DDL-imported table's schema search
path happens to look. This check only ever needs to *read rows*, the same
way the live request path does — so it reuses `database._connect_args_for`,
the exact `search_path` server setting the request-serving engine connects
with, and lets Postgres resolve `<table>` however the running application
already does. That also makes the query dialect-plain — no
`information_schema` dependency — so the read logic here is exercisable
against SQLite in tests, unlike `_run_ddl_import`'s raw-asyncpg apply path
(see `tests/test_ddl_import.py`'s docstring for why that one cannot be).

A table that does not exist at all (never migrated, wrong `dir`, nothing
ever applied) is indistinguishable here from a table that exists but has no
rows for a tenant — both surface as "no rows for this tenant", which is
exactly the right failure to report; the *reason* is a matter for the
plugin author to dig into, not this check to classify.

## Shared harness (biffo-template#1556)

The manifest-injection and Postgres-only-engine plumbing below live in
`plugin_deploy_checks.py`, not here — see that module's docstring for why:
#1556 (declared columns exist, not declared rows are populated) is filed to
reuse this same harness rather than re-derive it, dispatched from the same
`lambda_handler` one step apart. `_distinct_tenant_ids` and everything in
`assert_plugin_baselines_populated_async` past the manifest/engine setup is
specific to *this* check (rows, tenants) and is not meant to be shared.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from aws_lambda_powertools import Logger

from .plugin_deploy_checks import SAFE_IDENTIFIER, open_master_engine, plugin_manifests

logger = Logger()

#: Core's own Alembic-managed table (models/user.py) — see the module
#: docstring for why this, not a generic `tenants` table, is the known-tenant
#: source of truth. Overridable on `assert_plugin_baselines_populated_async`
#: purely for test isolation (see that function's docstring) — production
#: code never passes anything else.
DEFAULT_TENANT_SOURCE_TABLE = "users"


@dataclass(frozen=True)
class BaselineFailure:
    """One plugin-declared baseline table with no rows for a known tenant."""

    plugin: str
    table: str
    missing_tenants: tuple[str, ...]

    def describe(self) -> str:
        tenants = ", ".join(self.missing_tenants)
        return f"{self.plugin}: table '{self.table}' has no rows for tenant(s): {tenants}"


def format_baseline_error(failures: list[BaselineFailure]) -> str:
    """The deploy-failure message. Names every offending plugin/table/tenant
    so the fix is obvious from the log without reproducing anything."""
    lines = [
        f"{len(failures)} plugin baseline table(s) have no rows for a tenant this "
        "deployment already knows about (biffo-template#1554). A plugin's declared "
        "`seed.baseline_tables` promises these are populated by its vendored seed "
        "DDL (db/imports/_plugin-<name>/, applied earlier in this same deploy) — "
        "empty here means the seed did not run, was never vendored, or its WHERE "
        "NOT EXISTS clause never matched this tenant:",
        "",
    ]
    lines.extend(f"  - {f.describe()}" for f in failures)
    lines.extend(
        [
            "",
            "Check the plugin declares `seed.dir` in biffo.plugin.json, that "
            "db/imports/_plugin-<name>/ exists and was vendored by `biffo plugin "
            "install`/`upgrade`, and that its .sql file(s) actually insert into "
            "the table(s) named in `seed.baseline_tables`.",
        ]
    )
    return "\n".join(lines)


def collect_baseline_declarations(manifests: list[dict[str, Any]]) -> list[tuple[str, str]]:
    """`(plugin_name, table_name)` pairs to check, from every bundled manifest's
    `seed.baseline_tables`.

    Tolerant, like `plugins.discover_plugin_manifests` itself: a malformed
    declaration (bad table name shape, a table not in this same manifest's
    own `tables`) is logged and skipped rather than failing the whole check —
    one plugin's mistake must not hide every other plugin's real failure.
    `plugin-manifest.ts`/the SDK's `SeedDeclaration` already reject both
    shapes at install time, so reaching this function usually means they hold;
    this is defence in depth against a manifest that got here some other way
    (a hand-edited `services/<name>/biffo.plugin.json`, an older vendored copy).
    """
    declarations: list[tuple[str, str]] = []
    for manifest in manifests:
        if not isinstance(manifest, dict):
            continue
        plugin_name = manifest.get("name")
        if not isinstance(plugin_name, str) or not plugin_name:
            continue

        seed = manifest.get("seed")
        if not isinstance(seed, dict):
            continue
        baseline_tables = seed.get("baseline_tables")
        if not isinstance(baseline_tables, list):
            continue

        declared_table_names = {
            t.get("name")
            for t in manifest.get("tables", [])
            if isinstance(t, dict) and isinstance(t.get("name"), str)
        }

        for table in baseline_tables:
            if not isinstance(table, str) or not SAFE_IDENTIFIER.match(table):
                logger.warning(
                    f"Plugin {plugin_name!r} declares an invalid baseline table "
                    f"name {table!r} — skipping"
                )
                continue
            if table not in declared_table_names:
                logger.warning(
                    f"Plugin {plugin_name!r} declares baseline table {table!r}, "
                    "which is not one of its own manifest 'tables' — skipping"
                )
                continue
            declarations.append((plugin_name, table))

    return declarations


async def _distinct_tenant_ids(conn: Any, table: str) -> set[str]:
    """`DISTINCT tenant_id` from `table`, or empty if the table can't be read
    (does not exist, wrong schema on this connection's search_path, etc).

    `table` must already have passed `SAFE_IDENTIFIER` — see that constant's
    docstring (`plugin_deploy_checks.py`) for why interpolating it here is
    the accepted pattern in this codebase, not a shortcut.

    Runs on its own short-lived connection (`engine.connect()` per call, see
    the caller) rather than reusing one across every table: a Postgres
    connection that hits "relation does not exist" enters a failed-transaction
    state where every subsequent statement errors until a rollback, and a
    fresh connection per query sidesteps that entirely rather than requiring
    each caller to remember to roll back.
    """
    from sqlalchemy import text
    from sqlalchemy.exc import DBAPIError

    assert SAFE_IDENTIFIER.match(table)  # noqa: S101 -- narrows for pyright; callers already checked
    try:
        result = await conn.execute(
            text(f'SELECT DISTINCT tenant_id FROM "{table}"')  # noqa: S608  # nosec B608 -- identifier is pre-validated
        )
        return {row[0] for row in result}
    except DBAPIError as exc:
        logger.warning(f"Could not read tenant_id from table {table!r} — treating as empty: {exc}")
        return set()


async def assert_plugin_baselines_populated_async(
    manifests: list[dict[str, Any]] | None = None,
    tenant_source_table: str = DEFAULT_TENANT_SOURCE_TABLE,
) -> dict[str, Any]:
    """Fail loudly if any plugin-declared baseline table has no rows for a
    tenant this deployment already knows about. Returns a summary dict for
    the Lambda-invoke response, mirroring `_run_ddl_import`'s and
    `assert_crud_schema_matches_async`'s shape.

    `manifests` is normally left `None` (real discovery, via
    `plugin_deploy_checks.plugin_manifests`) — the parameter exists so tests
    can inject a fixed manifest list without needing bundled files on disk,
    the same reason `_run_ddl_import` takes `directory` as an argument rather
    than scanning for "the" import to apply.

    `tenant_source_table` is normally left at `DEFAULT_TENANT_SOURCE_TABLE`
    (`"users"`) — the override exists purely so a test can point "known
    tenants" at a throwaway, uuid-suffixed table instead of writing real rows
    into the shared pg-test-lane database's actual `users` table (which other
    concurrent tests/sessions may also be reading). Production code — the
    sync `assert_plugin_baselines_populated()` below, which is what
    `main.py`'s dispatcher actually calls — never passes anything else.
    """
    resolved_manifests = plugin_manifests(manifests)

    declarations = collect_baseline_declarations(resolved_manifests)
    if not declarations:
        logger.info("No plugin declares seed.baseline_tables — nothing to check")
        return {"checked": 0, "failures": []}

    engine, skip = await open_master_engine()
    if engine is None:
        return {**skip, "failures": []}  # type: ignore[dict-item]

    try:
        async with engine.connect() as conn:
            known_tenants = await _distinct_tenant_ids(conn, tenant_source_table)

        failures: list[BaselineFailure] = []
        if known_tenants:
            for plugin_name, table in declarations:
                async with engine.connect() as conn:
                    present = await _distinct_tenant_ids(conn, table)
                missing = known_tenants - present
                if missing:
                    failures.append(
                        BaselineFailure(
                            plugin=plugin_name,
                            table=table,
                            missing_tenants=tuple(sorted(missing)),
                        )
                    )
    finally:
        await engine.dispose()

    if failures:
        raise RuntimeError(format_baseline_error(failures))

    logger.info(
        f"Plugin baseline check: {len(declarations)} table(s) populated for "
        f"{len(known_tenants)} known tenant(s)"
    )
    return {
        "checked": len(declarations),
        "tenants": sorted(known_tenants),
        "failures": [],
    }


def assert_plugin_baselines_populated() -> dict[str, Any]:
    """Sync entrypoint, mirroring `crud_schema_guard.assert_crud_schema_matches`
    and `main.py`'s own `_run_ddl_import`/`_run_db_init` — the Lambda dispatcher
    (`main.lambda_handler`) is sync, and drives its async work through
    `asyncio.run`."""
    import asyncio

    return asyncio.run(assert_plugin_baselines_populated_async())
