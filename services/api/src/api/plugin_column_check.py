"""Deploy-time guard: every column a plugin's manifest declares must really
exist in the database it is about to run against (biffo-template#1556).

## The gap this closes

Core builds a plugin's SQLAlchemy model **from the manifest**
(`PluginTableDefinition.to_sqlalchemy_model`), so the model and the real
schema are two independent documents that can disagree. When they do, every
query touching the column fails at runtime with `UndefinedColumn` — after the
deploy has gone green.

biffo-template#1551 closed the one *route* that was known to produce that
disagreement (`biffo plugin upgrade`/`install --local` now diff columns, not
just table names). That fixed the tool. It did not close the class, and #1556
lists the routes it explicitly left open:

- index changes on an already-migrated column, `ColumnDefinition.default`, and
  composite `IndexDefinition`s — deferred by #1551's own docstring;
- a **hand-written** migration (which is how #1539 was actually resolved
  instance-side), checked against nothing;
- a **stale vendored copy** (#1547) — the manifest an instance holds in
  `services/<name>/` may be arbitrarily far behind the plugin repo;
- a migration that was generated correctly and **never applied** — the
  generator's correctness says nothing about whether `alembic upgrade head`
  reached *this* environment.

Every one of those is invisible to a check that reads migrations. This one
reads `information_schema`, so it does not care which of them happened.

## Where this runs in the deploy, and what it can still block

Dispatched as `biffo:plugin-column-check` from `main.lambda_handler`, invoked
by `.github/workflows/deploy-app.yml` in all three deploy jobs (`deploy-dev`,
`deploy-staging`, `deploy-prod` — the DDL-import step is duplicated three
times, not two), positioned:

- **after** "Initialise database schema" (Alembic to head) and "Apply DDL
  imports" — so every writer of schema has already had its turn and a
  complaint here is about the finished state, not a race;
- **before** "Check plugin baseline seed rows" — structure before content. A
  missing `tenant_id` would otherwise surface first as #1554's row check
  failing to read the table at all, which is a true failure with a much worse
  message;
- **before** "Package and deploy plugin Lambdas", "Package and deploy the
  shared plugin host", "Build and deploy plugin frontends" and their
  CloudFront invalidation — i.e. before the plugin's user-visible surface is
  switched to the new build.

**Honesty about "before traffic".** This cannot run before *all* traffic
moves, and pretending otherwise would be the kind of unearned claim this
guard exists to prevent. The Core API Lambda's code is already updated by the
time any of these checks run — necessarily, since the check is dispatched
*into* that Lambda — and the portal assets are synced earlier still. What
this position does buy is that the **plugin's** own Lambda, host and frontend
are not yet shipped when the check fails, so the surface that would actually
serve the missing column is still the old one, and the deploy job fails
before it gets there.

## What is compared, and what is not

**Column names only.** A declared column absent from the table fails the
deploy. Type, nullability, `default`, and indexes are **not** compared.

That is a deliberate trade, and the losing side is real, so state both:

- *Why name-only.* The declared type is a manifest string
  (`"String(36)"`, `"DateTime(timezone=True)"`) that reaches Postgres through
  two translations — manifest to SQLAlchemy type
  (`PluginTableDefinition._resolve_sa_type`), SQLAlchemy type to DDL — and
  comes back from `information_schema` as a third vocabulary
  (`character varying`, `timestamp with time zone`, `text`). Comparing those
  means encoding a mapping table that is only ever approximately right:
  `String` with no length is `text` on Postgres but `varchar` elsewhere, an
  instance may legitimately have widened a column, and an ADR-0005 DDL import
  may have chosen a compatible-but-different type on purpose. Every one of
  those is a **false** deploy failure, and #1556 says it directly: a guard
  that cries wolf gets switched off. Absence is unambiguous in a way type
  never is.
- *What that misses.* A column declared `Integer` and created `text`, a
  column declared `nullable=False` that is nullable in the database, a
  `default` that was never emitted, a missing or differently-shaped index —
  all pass this check. So does a column that exists with the right name and
  holds nothing anyone expects. #1554's baseline-row check is the neighbouring
  half of that question, and neither is a substitute for the other.

The check reports what it compared in its own return value and in its
failure message, so its **silence is interpretable** — the failure #1539
records is precisely a check stating a conclusion its comparison never
earned.

**One-directional, deliberately.** A column the database has and the manifest
does not is **not** a failure. The manifest is the contract for what must
exist, not for what may not: plugins share a database with Core and with an
instance's own DDL imports (ADR-0005), so extra columns are ordinary. This
mirrors `crud_schema_guard`'s own posture for core CRUD models, and reuses
its `find_column_drift` rather than re-deriving the same comparison.

## A plugin that declares no tables passes, and that is not suspicious

ADR-0003 plugins are not required to own tables at all: a plugin may be pure
frontend, pure compute, or extend Core through routes and agents only. Such a
manifest promises nothing about the schema, so there is nothing here to
break — treating it as suspicious would make the check noisy about the
commonest legitimate shape. The distinction that *is* worth surfacing is
"nothing to check" versus "nothing bundled", so the summary reports both
`plugins` and `tables_checked`: a log line saying `0 of 3 plugins declare
tables` reads differently from `0 plugins bundled`, and neither is silence.

## Reuse, not a second harness

Nothing here is a parallel implementation of #1554's post-deploy check:

- `plugin_deploy_checks.plugin_manifests()` / `open_master_engine()` — the
  manifest-injection and Postgres-only-engine plumbing #1560 factored out
  precisely so this issue would not re-derive it.
- `crud_schema_guard.actual_columns()` / `resolve_search_schemas()` — the
  single place in this service that knows how to read real column names, and
  where in the search path to look for them (that module's docstring records
  the false-positive deploy failure that taught it the second part).
- `crud_schema_guard.find_column_drift()` — the pure declared-vs-actual
  comparison, already one-directional and already tested without a database.
- `migrations.plugin_migrations.parse_plugin_tables_from_manifest()` and
  `models.plugin_table.PluginTableDefinition` — the declared shape, read the
  same way `permissions.py` and the routers read it, never re-parsed by hand.

What is genuinely new here is only: which tables to ask about (plugin
manifests rather than core CRUD models), attribution of a gap to the plugin
that declared it, and the environment-naming in the message.

## Three-way answers, per #1560's review

Reading `information_schema` has three outcomes, not two: it answers, it
answers "no such row" (a genuinely absent table or column — a **failure**,
which is the point), or **the query itself fails** (a connection blip, a
timeout, a permissions error). The third must never be collapsed into either
of the first two: reported as "columns missing" it fails a deploy that was
fine and blames a phantom; swallowed into a pass it goes silent exactly when
it matters — the fail-open shape #1517 records from `marketing#25`, and the
`up-to-date`/`behind`/`cannot-tell` posture #1558 established. So a query
failure raises `SchemaQueryFailedError`: the deploy still fails (this check
never waves a real problem through), with a message that reads "could not
determine this" rather than a confident, wrong list of missing columns.

A manifest whose `tables` cannot be parsed is treated the same way — reported
as a failure rather than skipped. `main._run_db_init`'s
`build_permissions_registry(strict=True)` already fails the deploy on exactly
that, one step earlier, so this is belt-and-braces; but "could not read the
contract" is a cannot-tell, and a cannot-tell is never a pass. Every
unreadable manifest is collected and reported alongside the real gaps, so one
broken plugin cannot hide another plugin's genuine missing column.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from aws_lambda_powertools import Logger

from .plugin_deploy_checks import SAFE_IDENTIFIER, open_master_engine, plugin_manifests

logger = Logger()

#: What this check compares, echoed into the return value and the failure
#: message. See the module docstring's "What is compared, and what is not":
#: a check whose silence cannot be interpreted is the defect #1539 records.
COMPARED = "column names only"
NOT_COMPARED = ("type", "nullability", "default", "indexes")


class SchemaQueryFailedError(RuntimeError):
    """The `information_schema` read failed — which is NOT the same as it
    reporting that a column is absent. See the module docstring's "Three-way
    answers": a distinct type means the deploy log says "could not determine
    this", not a confident and wrong list of missing columns.
    """


@dataclass(frozen=True)
class DeclaredTable:
    """One table a plugin manifest declares, and the columns it promises.

    `columns` maps column name -> the manifest's own type string. The type is
    carried purely so the failure message can quote what the author declared
    (which makes the fix obvious) — it is **never compared** against the
    database. See the module docstring.
    """

    plugin: str
    table: str
    columns: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class ColumnGap:
    """One plugin table whose real schema is missing declared column(s)."""

    environment: str
    plugin: str
    table: str
    missing: tuple[tuple[str, str], ...]
    table_exists: bool

    def describe(self) -> str:
        cols = ", ".join(f"{name} (declared {type_str})" for name, type_str in self.missing)
        where = f"[{self.environment}] plugin '{self.plugin}', table '{self.table}'"
        if not self.table_exists:
            return f"{where}: table does not exist — all declared column(s) absent: {cols}"
        return f"{where}: missing column(s): {cols}"


@dataclass(frozen=True)
class UnreadableDeclaration:
    """A manifest whose declared tables could not be read at all — a
    cannot-tell, reported rather than skipped (module docstring)."""

    environment: str
    plugin: str
    reason: str

    def describe(self) -> str:
        return (
            f"[{self.environment}] plugin '{self.plugin}': could not read its declared "
            f"tables, so nothing about its columns could be verified — {self.reason}"
        )


def collect_declared_tables(
    manifests: list[dict[str, Any]],
    environment: str,
) -> tuple[list[DeclaredTable], list[UnreadableDeclaration]]:
    """Every `(plugin, table, columns)` a bundled manifest declares, plus the
    manifests that could not be read.

    Parsing goes through `parse_plugin_tables_from_manifest` — the same
    function `permissions.py` and the plugin routers use — so the declared
    shape here is by construction the one Core will build its models from,
    including the four auto-columns (`id`, `tenant_id`, `created_at`,
    `updated_at`) `PluginTableDefinition` injects. Those are the most valuable
    columns to assert: `tenant_id`'s absence is the exact failure #1018 and
    tabsii-platform#429/#436 record, and no manifest declares it explicitly.
    """
    declared: list[DeclaredTable] = []
    unreadable: list[UnreadableDeclaration] = []

    for manifest in manifests:
        if not isinstance(manifest, dict):
            unreadable.append(
                UnreadableDeclaration(
                    environment=environment,
                    plugin="<unnamed>",
                    reason=f"manifest is {type(manifest).__name__}, not an object",
                )
            )
            continue
        raw_name = manifest.get("name")
        plugin_name = raw_name if isinstance(raw_name, str) and raw_name else "<unnamed>"

        try:
            tables = _parse_tables(manifest)
        except (ValueError, TypeError) as exc:
            unreadable.append(
                UnreadableDeclaration(environment=environment, plugin=plugin_name, reason=str(exc))
            )
            continue

        for table in tables:
            if not SAFE_IDENTIFIER.match(table.name):
                # Not a security concern here — the name is a bound parameter
                # in the information_schema query, never interpolated. It is a
                # *legibility* one: an unquoted identifier is folded to lower
                # case by Postgres, so a manifest declaring `Widgets` would
                # otherwise be reported as "table does not exist", which sends
                # the reader looking for a migration rather than a typo.
                unreadable.append(
                    UnreadableDeclaration(
                        environment=environment,
                        plugin=plugin_name,
                        reason=(
                            f"table name {table.name!r} is not a valid unquoted "
                            "identifier (expected lower_snake_case)"
                        ),
                    )
                )
                continue
            declared.append(
                DeclaredTable(
                    plugin=plugin_name,
                    table=table.name,
                    columns={c.name: c.type for c in table.columns},
                )
            )

    return declared, unreadable


def _parse_tables(manifest: dict[str, Any]) -> list[Any]:
    """`parse_plugin_tables_from_manifest`, imported lazily.

    Lazy because `plugin_migrations` pulls in SQLAlchemy and the model layer,
    and this module is reached from `main.py`'s dispatcher, which is imported
    on every warm invocation — including ordinary HTTP ones that never run
    the check.

    Raises `ValueError`/`TypeError` for a manifest it cannot read; pydantic's
    own `ValidationError` is a `ValueError` subclass, so the single caller's
    one `except` covers a malformed column definition and a malformed
    `tables` list alike.
    """
    from .migrations.plugin_migrations import parse_plugin_tables_from_manifest

    return list(parse_plugin_tables_from_manifest(manifest))


def find_plugin_column_gaps(
    declared: list[DeclaredTable],
    actual: Mapping[str, set[str]],
    environment: str,
) -> list[ColumnGap]:
    """Compare declared columns against real ones, attributing each gap to the
    plugin that declared it.

    The comparison itself is `crud_schema_guard.find_column_drift` — the same
    pure, one-directional, database-free function the core-CRUD guard uses.
    This function only adds attribution: which plugin, which environment, and
    what type the author declared for each missing column.

    Two plugins declaring the same table name is impossible in a deployment
    that got this far (`build_permissions_registry(strict=True)` fails the
    deploy on a duplicate table name at db-init, before this runs), but is
    handled rather than assumed away: the declarations are merged, so a
    column either of them promises is still asserted, and the failure names
    both plugins rather than silently dropping one.
    """
    from .crud_schema_guard import find_column_drift

    merged_columns: dict[str, dict[str, str]] = {}
    owners: dict[str, set[str]] = {}
    for decl in declared:
        merged_columns.setdefault(decl.table, {}).update(decl.columns)
        owners.setdefault(decl.table, set()).add(decl.plugin)

    drift = find_column_drift({t: set(c) for t, c in merged_columns.items()}, actual)

    return [
        ColumnGap(
            environment=environment,
            plugin=", ".join(sorted(owners[d.table])),
            table=d.table,
            missing=tuple((name, merged_columns[d.table][name]) for name in d.missing),
            table_exists=d.table_exists,
        )
        for d in drift
    ]


def format_column_error(
    environment: str,
    gaps: list[ColumnGap],
    unreadable: list[UnreadableDeclaration],
) -> str:
    """The deploy-failure message.

    Names the environment, the plugin, the table and every column, so the
    failure is actionable from the Actions log alone without reproducing
    anything — the check runs in three environments, and "check failed" in
    one of three costs more than it saves.
    """
    lines: list[str] = []
    if gaps:
        lines += [
            f"[{environment}] {len(gaps)} plugin table(s) are missing column(s) their "
            "manifest declares (biffo-template#1556). Core builds each plugin's "
            "SQLAlchemy model from the manifest, so every query touching these would "
            "fail at runtime with UndefinedColumn:",
            "",
        ]
        lines += [f"  - {g.describe()}" for g in gaps]
        lines.append("")
    if unreadable:
        lines += [
            f"[{environment}] {len(unreadable)} plugin manifest(s) could not be read, so "
            "their columns were NOT verified — this is a cannot-tell, not a pass:",
            "",
        ]
        lines += [f"  - {u.describe()}" for u in unreadable]
        lines.append("")
    lines += [
        f"Compared: {COMPARED}. NOT compared: {', '.join(NOT_COMPARED)} — a column "
        "present with the wrong type or nullability passes this check (see "
        "plugin_column_check's module docstring for why).",
        "",
        "Fix by shipping the migration that adds the column(s) (`biffo plugin "
        "sync-migrations`, or a hand-written revision) and re-deploying, or by "
        "removing the column from the plugin's biffo.plugin.json if it was never "
        "meant to exist. If the manifest looks right, check the instance's vendored "
        f"copy in services/<plugin>/ is not stale (biffo-template#1547) in {environment}.",
    ]
    return "\n".join(lines)


async def assert_plugin_columns_exist_async(
    manifests: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Fail the deploy if any plugin-declared column is absent from the
    database. Returns a summary dict for the Lambda-invoke response, mirroring
    `assert_plugin_baselines_populated_async`'s and
    `assert_crud_schema_matches_async`'s shape.

    `manifests` is normally left `None` (real discovery via
    `plugin_deploy_checks.plugin_manifests`) — the parameter exists so tests
    can inject a fixed manifest list without needing bundled files on disk,
    the same reason `_run_ddl_import` takes `directory` as an argument.

    Raises `RuntimeError` (via `format_column_error`) for a real gap, and
    `SchemaQueryFailedError` when the `information_schema` read itself fails —
    both fail the deploy, deliberately distinguishable in the log.
    """
    from sqlalchemy.exc import DBAPIError

    from .config import settings
    from .crud_schema_guard import actual_columns, resolve_search_schemas

    environment = settings.environment
    resolved_manifests = plugin_manifests(manifests)
    declared, unreadable = collect_declared_tables(resolved_manifests, environment)

    summary: dict[str, Any] = {
        "environment": environment,
        "plugins": len(resolved_manifests),
        "tables_checked": len(declared),
        "columns_checked": sum(len(d.columns) for d in declared),
        "compared": COMPARED,
        "not_compared": list(NOT_COMPARED),
        "gaps": [],
    }

    if not declared:
        # No plugin declares a table -- nothing is promised, so nothing can be
        # broken. Deliberately a pass; see the module docstring. An unreadable
        # manifest still fails below.
        logger.info(
            f"[{environment}] plugin column check: 0 of {len(resolved_manifests)} "
            f"bundled plugin(s) declare tables — nothing to compare"
        )
        if unreadable:
            raise RuntimeError(format_column_error(environment, [], unreadable))
        return summary

    engine, skip = await open_master_engine()
    if engine is None:
        return {**summary, **skip}  # type: ignore[dict-item]

    tables = {d.table for d in declared}
    try:
        async with engine.connect() as conn:
            actual = await actual_columns(conn, tables, resolve_search_schemas())
    except DBAPIError as exc:
        raise SchemaQueryFailedError(
            f"[{environment}] could not read information_schema.columns for "
            f"{len(declared)} plugin table(s), so whether their declared columns "
            f"exist is UNKNOWN — this is not the same as finding them missing: {exc}"
        ) from exc
    finally:
        await engine.dispose()

    gaps = find_plugin_column_gaps(declared, actual, environment)
    if gaps or unreadable:
        raise RuntimeError(format_column_error(environment, gaps, unreadable))

    logger.info(
        f"[{environment}] plugin column check: {summary['columns_checked']} declared "
        f"column(s) across {len(declared)} table(s) from {len(resolved_manifests)} "
        f"plugin(s) all present. Compared {COMPARED}; did not compare "
        f"{', '.join(NOT_COMPARED)}."
    )
    return summary


def assert_plugin_columns_exist() -> dict[str, Any]:
    """Sync entrypoint, mirroring `plugin_baseline_check`'s and
    `crud_schema_guard`'s — `main.lambda_handler` is sync and drives its async
    work through `asyncio.run`."""
    import asyncio

    return asyncio.run(assert_plugin_columns_exist_async())
