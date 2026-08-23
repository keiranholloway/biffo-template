"""Tests for the shared harness post-deploy plugin-manifest checks build on
(plugin_deploy_checks.py) — biffo-template#1554, and the reusable half
biffo-template#1556 is filed to build its own check on top of.

`open_master_engine()`'s Postgres/non-Postgres branching is exercised
end-to-end through `assert_plugin_baselines_populated_async` in
test_plugin_baseline_check.py (not-Postgres, via sqlite settings — no real DB
needed to prove the skip) and test_plugin_baseline_check_pg.py (the Postgres
path). This file covers what's specific to the shared module itself.
"""

from __future__ import annotations

from api.plugin_deploy_checks import SAFE_IDENTIFIER, plugin_manifests


class TestPluginManifests:
    def test_returns_the_injected_list_unchanged(self):
        injected = [{"name": "widgets"}]
        assert plugin_manifests(injected) is injected

    def test_an_empty_injected_list_is_not_treated_as_absent(self):
        # `manifests=[]` (a real deployment with zero plugins bundled) must
        # NOT fall through to real discovery -- only `None` means "discover
        # for real". `is not None` in the implementation is the guard.
        assert plugin_manifests([]) == []

    def test_none_falls_back_to_real_discovery(self, monkeypatch):
        import api.plugins as plugins_module

        monkeypatch.setattr(
            plugins_module, "discover_plugin_manifests", lambda: [{"name": "discovered"}]
        )
        assert plugin_manifests(None) == [{"name": "discovered"}]


class TestSafeIdentifier:
    def test_accepts_snake_case_table_names(self):
        for name in ["widgets", "widgets_items", "t1", "a"]:
            assert SAFE_IDENTIFIER.match(name)

    def test_rejects_sql_injection_shaped_input(self):
        for bad in ["bad; DROP TABLE x --", "widgets'; --", "1widgets", "", "Widgets"]:
            assert not SAFE_IDENTIFIER.match(bad)


class TestOpenMasterEngine:
    async def test_skips_a_non_postgres_deployment_without_connecting(
        self, monkeypatch, tmp_path
    ) -> None:
        import sys

        from api.plugin_deploy_checks import open_master_engine

        database_url = f"sqlite+aiosqlite:///{tmp_path / 'test.db'}"
        monkeypatch.setenv("BIFFO_DATABASE_URL", database_url)
        if "api.config" in sys.modules:
            monkeypatch.setattr(sys.modules["api.config"].settings, "database_url", database_url)
        engine, skip = await open_master_engine()

        assert engine is None
        assert skip == {"checked": 0, "reason": "not-postgres"}
