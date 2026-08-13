"""Pure-logic tests for plugin_baseline_check.py (biffo-template#1554) — the
manifest-parsing and message-formatting parts that need no database, mirroring
test_crud_schema_guard.py's split (pure comparison logic tested directly;
the DB-touching async path proven separately, here via the real-Postgres
lane in test_plugin_baseline_check_pg.py)."""

from __future__ import annotations

from api.plugin_baseline_check import (
    BaselineFailure,
    collect_baseline_declarations,
    format_baseline_error,
)


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
