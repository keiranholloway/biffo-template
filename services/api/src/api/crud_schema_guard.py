"""Deploy-time guard: a generic-CRUD table must really have the columns its ORM
model declares (#1018).

``crud_handlers`` filters every generic-CRUD query by ``model.tenant_id``,
unconditionally and correctly — tenant isolation is a hard invariant (ADR-0001,
ADR-0004), not an option. The model asserts that column exists. For a
DDL-imported table (ADR-0005) the **real** schema is written by hand, outside
the model, so the two can disagree and **nothing compares them**.

When they disagree the failure is deferred all the way to a user-facing request:

    column <table>.tenant_id does not exist

## Why a unit test cannot catch this, and why the guard lives here

The API's test lane builds its schema from the ORM's own metadata, so the column
is present in the test database *because the model declared it* — the very
assumption under test. Twenty-four passing tests proved nothing about the
mismatch; the first live click-through 500'd (tabsii-platform#429/#436, two
independent occurrences of one root cause).

So the check has to run somewhere a **real** database exists. `_run_db_init` is
that place: it runs at deploy, after ``command.upgrade(cfg, "head")`` has taken
the schema to head, and it already fails the deploy loudly for a malformed
``__crud_permissions__`` declaration. This extends that same step from "the
declared CRUD surface is well-formed" to "the declared CRUD surface is real".

## What is and is not drift

- A column the model declares and the table lacks is **drift**, and fails the
  deploy. That is the defect.
- A column the table has and the model does not is **fine** and common — an
  imported table may carry columns the ORM has no opinion about.
- A table missing entirely is drift: generic CRUD would 500 on every request.

Only tables opting into generic CRUD are checked. A model that does not declare
``__crud_permissions__`` is never read through the generic path, so a mismatch
there cannot produce this failure.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ColumnDrift:
    """One table whose real schema is missing columns its model declares."""

    table: str
    missing: tuple[str, ...]
    table_exists: bool

    def describe(self) -> str:
        if not self.table_exists:
            return f"{self.table}: table does not exist in the database"
        cols = ", ".join(self.missing)
        return f"{self.table}: missing column(s) {cols}"


def declared_columns(model: type[Any]) -> set[str]:
    """The column names this model's mapper actually declares.

    Uses the mapper's ``columns`` rather than ``__dict__`` so inherited columns
    (``tenant_id`` from a base class, which is exactly the case that bites) are
    included — reading the class body alone would miss the mixin that causes
    this bug.
    """
    table = getattr(model, "__table__", None)
    if table is None:
        return set()
    return {c.name for c in table.columns}


def find_column_drift(
    declared: Mapping[str, Iterable[str]],
    actual: Mapping[str, Iterable[str]],
) -> list[ColumnDrift]:
    """Compare declared columns against real ones. Pure, so it is testable
    without a database — which matters, because the lane that would otherwise
    test it is the one structurally unable to see the bug.

    ``actual`` maps table name -> real column names. A table absent from
    ``actual`` is treated as not existing rather than as having no columns; the
    two are different failures and the message should say which.
    """
    drift: list[ColumnDrift] = []
    for table in sorted(declared):
        want = set(declared[table])
        if table not in actual:
            drift.append(ColumnDrift(table=table, missing=tuple(sorted(want)), table_exists=False))
            continue
        missing = want - set(actual[table])
        if missing:
            drift.append(
                ColumnDrift(table=table, missing=tuple(sorted(missing)), table_exists=True)
            )
    return drift


def format_drift_error(drift: list[ColumnDrift]) -> str:
    """The deploy-failure message. Names every offending table and column, so
    the fix is obvious from the log without reproducing anything."""
    lines = [
        f"{len(drift)} generic-CRUD table(s) declare columns their real schema "
        "does not have. Generic CRUD filters every query by tenant_id "
        "(ADR-0004), so these would 500 on the first request that reads them:",
        "",
    ]
    lines.extend(f"  - {d.describe()}" for d in drift)
    lines.extend(
        [
            "",
            "Fix the table's DDL to declare the column(s), or remove the table's "
            "__crud_permissions__ so it is not served through generic CRUD.",
        ]
    )
    return "\n".join(lines)


def resolve_search_schemas() -> list[str] | None:
    """Which schemas to look in, or ``None`` to ask the connection.

    Three sources, most explicit first:

    1. ``app_role_schemas`` — the operator's own allowlist, the same contract
       ``db_app_role`` uses.
    2. ``db_search_path`` — the search_path the **request path's** engine is
       built with (``database.py`` passes it to asyncpg as a server setting).
       That is the resolution order the ORM will really use, so it is the right
       answer to "where will generic CRUD find this table".
    3. ``None`` — let the query fall back to the connection's own
       ``current_schemas(false)``.

    Source 2 exists because source 3 was not the safety net it was written to
    be. This guard opens its **own** engine, with no ``search_path`` server
    setting, so ``current_schemas(false)`` on that connection is whatever the
    master role defaults to — ``public`` — regardless of where the instance
    actually keeps its imported tables. An ADR-0005 instance therefore had
    every imported table report as missing and its deploy fail on a schema that
    was entirely correct: the exact false positive this module's own docstring
    warned against. Note the asymmetry that hid it — ``db_app_role``'s fallback
    discovers schemas by querying ``pg_namespace``, so it finds them; only this
    one asked the session.
    """
    from .config import settings
    from .db_app_role import configured_schemas

    explicit = configured_schemas()
    if explicit:
        return explicit
    from_search_path = [s.strip() for s in settings.db_search_path.split(",") if s.strip()]
    return from_search_path or None


async def _actual_columns(
    conn: Any, tables: set[str], schemas: list[str] | None
) -> dict[str, set[str]]:
    """Real column names per table, from ``information_schema``.

    ``schemas`` is an explicit list (see ``resolve_search_schemas``) or ``None``
    to use the connection's own ``search_path``.
    """
    from sqlalchemy import text

    # Two complete literal statements rather than one built by interpolation.
    # `clause` would only ever have been one of two constants, but assembling
    # SQL with an f-string trips the S608 gate — and the honest fix is to not
    # build SQL from strings at all, not to annotate the warning away. Table and
    # schema names stay bound parameters in both branches.
    if schemas:
        stmt = text(
            "SELECT table_name, column_name FROM information_schema.columns "
            "WHERE table_schema = ANY(:schemas) AND table_name = ANY(:tables)"
        )
        params: dict[str, Any] = {"schemas": list(schemas), "tables": sorted(tables)}
    else:
        stmt = text(
            "SELECT table_name, column_name FROM information_schema.columns "
            "WHERE table_schema = ANY(current_schemas(false)) "
            "AND table_name = ANY(:tables)"
        )
        params = {"tables": sorted(tables)}

    result = await conn.execute(stmt, params)
    out: dict[str, set[str]] = {}
    for table_name, column_name in result:
        out.setdefault(table_name, set()).add(column_name)
    return out


async def assert_crud_schema_matches_async() -> dict:
    """Fail the deploy if any generic-CRUD table's schema is missing a column
    its model declares. Returns a summary for the db-init payload."""
    from sqlalchemy.ext.asyncio import create_async_engine

    from .database import resolve_master_database_url
    from .db_app_role import is_postgres
    from .permissions import iter_core_crud_models

    models = iter_core_crud_models()
    declared = {m.__tablename__: declared_columns(m) for m in models}
    if not declared:
        logger.info("No core table opts into generic CRUD — nothing to check")
        return {"checked": 0, "drift": []}

    master_url = resolve_master_database_url()
    if not is_postgres(master_url):
        # Mirrors bootstrap_app_role: the information_schema query below is
        # Postgres-shaped, and a non-Postgres deployment is not the environment
        # this guard exists to protect.
        logger.info("Not a Postgres deployment — skipping CRUD schema check")
        return {"checked": 0, "drift": [], "reason": "not-postgres"}

    # hide_parameters, like every other engine in this service (#85): a failing
    # statement here would otherwise put the master connection's parameters in
    # a StatementError traceback. Enforced by test_database_sql_echo.
    engine = create_async_engine(master_url, hide_parameters=True)
    try:
        async with engine.connect() as conn:
            actual = await _actual_columns(conn, set(declared), resolve_search_schemas())
    finally:
        await engine.dispose()

    drift = find_column_drift(declared, actual)
    if drift:
        raise RuntimeError(format_drift_error(drift))

    logger.info(f"CRUD schema check: {len(declared)} table(s) match their models")
    return {"checked": len(declared), "drift": []}


def assert_crud_schema_matches() -> dict:
    """Sync entrypoint, mirroring ``db_app_role.bootstrap_app_role``.

    ``_run_db_init`` is sync and drives its async work through ``asyncio.run``;
    see the event-loop note in ``main`` for why that matters on Lambda.
    """
    import asyncio

    return asyncio.run(assert_crud_schema_matches_async())
