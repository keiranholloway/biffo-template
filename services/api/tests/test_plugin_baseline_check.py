"""Pure-logic tests for plugin_baseline_check.py (biffo-template#1554) — the
manifest-parsing and message-formatting parts that need no database, mirroring
test_crud_schema_guard.py's split (pure comparison logic tested directly;
the DB-touching async path proven separately, here via the real-Postgres
lane in test_plugin_baseline_check_pg.py)."""

from __future__ import annotations

from typing import Any

import pytest
from api.plugin_baseline_check import (
    BaselineFailure,
    TenantQueryFailedError,
    _distinct_tenant_ids,
    _is_undefined_table,
    collect_baseline_declarations,
    format_baseline_error,
)
from sqlalchemy.exc import DBAPIError


class _FakeOrigError(Exception):
    """Stands in for the real driver exception `DBAPIError.orig` wraps —
    only `.sqlstate` matters to `_is_undefined_table`, so nothing else needs
    to be real (see plugin_baseline_check.py's `_UNDEFINED_TABLE_SQLSTATE`
    docstring for why sqlstate, not exception class, is the check)."""

    def __init__(self, sqlstate: str | None = None) -> None:
        super().__init__("simulated driver error")
        self.sqlstate = sqlstate


def _dbapi_error(sqlstate: str | None) -> DBAPIError:
    return DBAPIError("SELECT 1", {}, _FakeOrigError(sqlstate))


class _RaisingConn:
    """A fake connection whose `.execute()` always raises the given
    exception — enough to drive `_distinct_tenant_ids`'s except branch
    without a real database, which is what makes it possible for CI's
    Postgres-less Python job to actually exercise this code
    (biffo-template#1560 review: the error-branch coverage gate flagged this
    line as unexecuted, because it had previously only ever been reachable
    via the real-Postgres lane, which CI's Python job does not run)."""

    def __init__(self, exc: Exception) -> None:
        self._exc = exc

    async def execute(self, *args: Any, **kwargs: Any) -> Any:
        raise self._exc


def _manifest(name: str, tables: list[str], seed: dict | None) -> dict:
    return {
        "name": name,
        "tables": [{"name": t} for t in tables],
        **({"seed": seed} if seed is not None else {}),
    }


class TestCollectBaselineDeclarations:
    def test_empty_manifests_produce_no_declarations(self):
        assert collect_baseline_declarations([]) == []

    def test_a_plugin_with_no_seed_is_unaffected(self):
        manifests = [_manifest("widgets", ["widgets_items"], seed=None)]
        assert collect_baseline_declarations(manifests) == []

    def test_a_seed_with_no_baseline_tables_produces_nothing(self):
        manifests = [
            _manifest("widgets", ["widgets_items"], seed={"dir": "db/seed", "baseline_tables": []})
        ]
        assert collect_baseline_declarations(manifests) == []

    def test_collects_one_pair_per_declared_baseline_table(self):
        manifests = [
            _manifest(
                "widgets",
                ["widgets_items", "widgets_categories"],
                seed={
                    "dir": "db/seed",
                    "baseline_tables": ["widgets_items", "widgets_categories"],
                },
            )
        ]
        assert collect_baseline_declarations(manifests) == [
            ("widgets", "widgets_items"),
            ("widgets", "widgets_categories"),
        ]

    def test_multiple_plugins_all_contribute(self):
        manifests = [
            _manifest("widgets", ["t1"], seed={"dir": "db/seed", "baseline_tables": ["t1"]}),
            _manifest("gizmos", ["t2"], seed={"dir": "db/seed", "baseline_tables": ["t2"]}),
        ]
        assert collect_baseline_declarations(manifests) == [
            ("widgets", "t1"),
            ("gizmos", "t2"),
        ]

    def test_skips_a_baseline_table_not_in_this_manifests_own_tables(self):
        # Defence in depth — plugin-manifest.ts / the SDK already reject this
        # at install time; this proves a manifest that reached here some other
        # way (hand-edited, stale vendored copy) does not silently query a
        # table it has no business asserting about.
        manifests = [
            _manifest(
                "widgets",
                ["widgets_items"],
                seed={"dir": "db/seed", "baseline_tables": ["not_declared"]},
            )
        ]
        assert collect_baseline_declarations(manifests) == []

    def test_skips_a_malformed_table_name_rather_than_building_unsafe_sql(self):
        manifests = [
            _manifest(
                "widgets",
                ["widgets_items"],
                seed={"dir": "db/seed", "baseline_tables": ["bad; DROP TABLE x --"]},
            )
        ]
        assert collect_baseline_declarations(manifests) == []

    def test_tolerates_a_manifest_that_is_not_a_dict(self):
        assert collect_baseline_declarations([None, "not-a-dict", 42]) == []  # type: ignore[list-item]

    def test_tolerates_seed_or_baseline_tables_being_the_wrong_shape(self):
        manifests = [
            _manifest("a", ["t"], seed="not-a-dict"),  # type: ignore[arg-type]
            _manifest("b", ["t"], seed={"dir": "db/seed", "baseline_tables": "not-a-list"}),
        ]
        assert collect_baseline_declarations(manifests) == []


class TestFormatBaselineError:
    def test_names_every_plugin_table_and_missing_tenant(self):
        failures = [
            BaselineFailure(plugin="widgets", table="widgets_items", missing_tenants=("acme",)),
            BaselineFailure(
                plugin="widgets", table="widgets_categories", missing_tenants=("acme", "globex")
            ),
        ]
        message = format_baseline_error(failures)
        assert "widgets: table 'widgets_items' has no rows for tenant(s): acme" in message
        assert (
            "widgets: table 'widgets_categories' has no rows for tenant(s): acme, globex" in message
        )
        assert "#1554" in message


class TestIsUndefinedTable:
    """Pure classification: only Postgres's own undefined_table SQLSTATE
    (42P01) counts. Everything else -- a different SQLSTATE, no SQLSTATE at
    all, not even a DBAPIError -- must not (biffo-template#1560 review)."""

    def test_true_for_the_undefined_table_sqlstate(self):
        assert _is_undefined_table(_dbapi_error(sqlstate="42P01"))

    def test_false_for_a_different_sqlstate(self):
        # 53300 = too_many_connections -- a real transient condition, not a
        # missing table.
        assert not _is_undefined_table(_dbapi_error(sqlstate="53300"))

    def test_false_when_orig_has_no_sqlstate_at_all(self):
        assert not _is_undefined_table(_dbapi_error(sqlstate=None))

    def test_false_for_something_that_is_not_even_a_dbapi_error(self):
        assert not _is_undefined_table(RuntimeError("unrelated"))


class TestDistinctTenantIdsErrorClassification:
    """`_distinct_tenant_ids`'s three-way split, exercised without a real
    database (biffo-template#1560 review) -- a fake connection whose
    `.execute()` raises is enough to drive both branches of `except
    DBAPIError`, which is what makes this reachable from CI's Postgres-less
    Python job rather than only the real-Postgres lane."""

    async def test_undefined_table_is_treated_as_zero_rows(self):
        conn = _RaisingConn(_dbapi_error(sqlstate="42P01"))
        result = await _distinct_tenant_ids(conn, "widgets_items")
        assert result == set()

    async def test_a_different_sqlstate_raises_tenant_query_failed_not_empty(self):
        conn = _RaisingConn(_dbapi_error(sqlstate="53300"))
        with pytest.raises(TenantQueryFailedError, match="widgets_items"):
            await _distinct_tenant_ids(conn, "widgets_items")

    async def test_no_sqlstate_at_all_also_raises_tenant_query_failed(self):
        conn = _RaisingConn(_dbapi_error(sqlstate=None))
        with pytest.raises(TenantQueryFailedError):
            await _distinct_tenant_ids(conn, "widgets_items")


class TestTransientFailureIsNeverSwallowedIntoAPass:
    """End-to-end proof of the design decision the coverage-gate review
    raised: a transient failure reading the KNOWN-TENANTS table (not just a
    baseline table) must propagate, not silently reduce known_tenants to
    nothing and report success. That silent-pass shape is exactly what
    #1517/marketing#25 and #1558 both guard against, and it is the one this
    module's original `except DBAPIError: return set()` would have produced
    for `assert_plugin_baselines_populated_async` itself -- not just for one
    table's read, but for the whole check, because an empty known_tenants
    set short-circuits the per-table loop entirely."""

    async def test_propagates_rather_than_reporting_a_false_pass(self, monkeypatch):
        import api.plugin_baseline_check as mod

        class _FakeConnCtx:
            async def __aenter__(self) -> object:
                return object()

            async def __aexit__(self, *exc_info: object) -> bool:
                return False

        class _FakeEngine:
            def connect(self) -> _FakeConnCtx:
                return _FakeConnCtx()

            async def dispose(self) -> None:
                return None

        async def fake_open_master_engine() -> tuple[_FakeEngine, None]:
            return _FakeEngine(), None

        async def fake_distinct_tenant_ids(conn: object, table: str) -> set[str]:
            if table == mod.DEFAULT_TENANT_SOURCE_TABLE:
                raise mod.TenantQueryFailedError("simulated transient failure reading users")
            return {"acme"}  # never reached if the propagation works

        monkeypatch.setattr(mod, "open_master_engine", fake_open_master_engine)
        monkeypatch.setattr(mod, "_distinct_tenant_ids", fake_distinct_tenant_ids)

        manifests = [
            {
                "name": "widgets",
                "tables": [{"name": "widgets_items"}],
                "seed": {"dir": "db/seed", "baseline_tables": ["widgets_items"]},
            }
        ]

        with pytest.raises(mod.TenantQueryFailedError, match="simulated transient failure"):
            await mod.assert_plugin_baselines_populated_async(manifests=manifests)
