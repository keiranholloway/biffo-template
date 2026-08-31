"""Install-path guard for a plugin manifest whose declared table collides
with an existing table (tabsii-platform#850 / biffo-template#1459 instance 2).

tabsii-platform#850 was a real production defect: a plugin's hand-declared
SQLAlchemy model re-declared two tables its own manifest already owned. It
passed every test for as long as the plugin was **not** installed — nothing
exercised the install-path transition. Installing it made the second
declaration a raw ``sqlalchemy.exc.InvalidRequestError`` at import, breaking
collection in 29 unrelated test modules at once.

biffo-template#1459's own "what would actually catch it" section named the
missing lever precisely: "Import the Core app with a plugin installed" — the
class is defined by an *absent* starting state (no colliding install has ever
happened), so the detector has to create that state rather than unit-test the
steady one. #1449 and #1457's siblings in this class were fixed by exactly
this shape of test (a birth test that scaffolds a repo; a create-path
Terraform apply); this is the plugin-install equivalent.

Two distinct collision shapes reach ``build_plugin_router()`` (the function
``main.py`` calls at Core API import time, mounting every installed plugin's
routes — see its own module docstring): a plugin table colliding with a
**Core** table, and a plugin table colliding with **another plugin's** table.
Both are covered here because they fail differently without a guard — the
first is a loud, unhelpful crash; the second is silent, wrong data — and a
fix that only caught one would leave the other exactly as invisible as
before.

Every scenario below that expects a table to be created for the first time
uses its own table name, never reused by any other test in this file. That
is deliberate, not incidental: ``Base.metadata`` is a process-global
SQLAlchemy registry (see ``api.models.base``), so a ``Table`` one test
successfully creates stays registered for the rest of the pytest session —
clearing this file's own bookkeeping in a fixture would not undo that, and an
earlier draft of this file discovered exactly that the hard way (two tests
sharing a table name produced a real, confusing cross-test collision that had
nothing to do with the guard being tested). Reusing a name is fine only for
``plugin_chat_agents`` (the real Core table every "collides with Core"
scenario targets): those scenarios are supposed to be rejected before a
``Table`` is ever created, so nothing is added to ``Base.metadata`` for them
to leak.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from api.models.base import Base
from api.models.plugin_chat_agent import (
    PluginChatAgent,  # noqa: F401  registers "plugin_chat_agents"
)
from api.routing import plugin_router as plugin_router_module
from api.routing.plugin_router import PluginTableCollisionError, build_plugin_router
from fastapi import FastAPI

# The real Core table every "collides with Core" scenario targets. Imported
# above (not just referenced) so its table is on Base.metadata regardless of
# what other test modules happened to run first.
_EXISTING_CORE_TABLE = "plugin_chat_agents"


def _write_manifest(root: Path, plugin_name: str, manifest: dict) -> None:
    plugin_dir = root / plugin_name
    plugin_dir.mkdir(parents=True, exist_ok=True)
    (plugin_dir / "biffo.plugin.json").write_text(json.dumps(manifest))


def _manifest_colliding_with_core(plugin_name: str) -> dict:
    return {
        "name": plugin_name,
        "version": "1.0.0",
        "tables": [
            {
                "name": _EXISTING_CORE_TABLE,
                "columns": [{"name": "note", "type": "String(50)"}],
                "permissions": {"list": {"allowed": True}},
            }
        ],
        "api_routes": [
            {
                "method": "GET",
                "path": "/rows",
                "table": _EXISTING_CORE_TABLE,
                "operation": "list",
            }
        ],
    }


def _manifest_declaring(
    plugin_name: str, table_name: str, *, extra_column: str | None = None
) -> dict:
    columns = [{"name": "url", "type": "String(200)"}]
    if extra_column:
        columns.append({"name": extra_column, "type": "String(64)"})
    return {
        "name": plugin_name,
        "version": "1.0.0",
        "tables": [
            {
                "name": table_name,
                "columns": columns,
                "permissions": {"list": {"allowed": True}},
            }
        ],
        "api_routes": [
            {"method": "GET", "path": "/rows", "table": table_name, "operation": "list"},
        ],
    }


class TestGetModelUnit:
    """Unit-level: the exact collision shapes _get_model must catch, with the
    message a person actually has to act on."""

    def test_collision_with_core_table_is_caught_with_actionable_message(self):
        from api.migrations.plugin_migrations import parse_plugin_tables_from_manifest

        manifest = _manifest_colliding_with_core("evil-core-collider-unit")
        table_def = parse_plugin_tables_from_manifest(manifest)[0]

        with pytest.raises(PluginTableCollisionError) as exc_info:
            plugin_router_module._get_model(table_def, "evil-core-collider-unit")

        message = str(exc_info.value)
        assert "evil-core-collider-unit" in message
        assert _EXISTING_CORE_TABLE in message
        assert "rename the table" in message

    def test_collision_with_another_plugins_table_is_caught_with_actionable_message(self):
        from api.migrations.plugin_migrations import parse_plugin_tables_from_manifest

        table_name = "collision_probe_1459_pair_unit"
        alpha_manifest = _manifest_declaring("pair-unit-alpha", table_name)
        alpha_table_def = parse_plugin_tables_from_manifest(alpha_manifest)[0]
        plugin_router_module._get_model(alpha_table_def, "pair-unit-alpha")

        beta_manifest = _manifest_declaring(
            "pair-unit-beta", table_name, extra_column="campaign_id"
        )
        beta_table_def = parse_plugin_tables_from_manifest(beta_manifest)[0]

        with pytest.raises(PluginTableCollisionError) as exc_info:
            plugin_router_module._get_model(beta_table_def, "pair-unit-beta")

        message = str(exc_info.value)
        assert "pair-unit-beta" in message
        assert "pair-unit-alpha" in message
        assert table_name in message

    def test_same_plugin_reprocessed_is_not_a_collision(self):
        """build_plugin_router() legitimately runs twice in one process
        (main.py mounts the public and internal routers separately) — the
        same plugin's own table must not trip the guard against itself."""
        from api.migrations.plugin_migrations import parse_plugin_tables_from_manifest

        table_name = "collision_probe_1459_repeat"
        manifest = _manifest_declaring("repeat-owner", table_name)
        table_def = parse_plugin_tables_from_manifest(manifest)[0]

        first = plugin_router_module._get_model(table_def, "repeat-owner")
        second = plugin_router_module._get_model(table_def, "repeat-owner")
        assert first is second


class TestInstallPathBootsCoreWithoutCrashing:
    """The install-path shape named in #1459 itself: a real manifest on disk,
    discovered the same way ``discover_plugin_manifests()`` finds a real
    installed plugin, fed into the same ``build_plugin_router()`` call
    ``main.py`` makes at Core API import time."""

    def test_core_boots_with_a_core_colliding_plugin_installed(self, tmp_path: Path):
        plugin_name = "evil-core-collider-boot"
        _write_manifest(tmp_path, plugin_name, _manifest_colliding_with_core(plugin_name))

        from api.plugins import discover_plugin_manifests

        discovered = discover_plugin_manifests(tmp_path)
        assert discovered  # sanity: the manifest was actually found on disk

        # This is the "boot the Core app" moment: main.py does exactly
        # `app.include_router(build_plugin_router(), prefix="/api/v1")` at
        # import time. Building the router (and, by extension, an app that
        # mounts it) must not raise — a colliding plugin must not be able to
        # take down Core's own startup, or collection of every test module
        # that imports api.main, the way it did in production.
        router = build_plugin_router(manifests=discovered)
        app = FastAPI()
        app.include_router(router, prefix="/api/v1")  # would raise pre-fix

        # Fail-closed, not silently-exposed: the colliding plugin's routes
        # are simply absent rather than serving a corrupted/misattributed
        # schema.
        paths = set(app.openapi()["paths"])
        assert f"/api/v1/plugins/{plugin_name}/rows" not in paths

    def test_colliding_plugin_does_not_take_down_a_sibling_plugin(self, tmp_path: Path):
        """One broken plugin must not prevent every other plugin from
        starting — the existing policy this guard extends rather than
        replaces (see build_plugin_router's own docstring)."""
        evil_name = "evil-core-collider-sibling"
        good_name = "well-behaved-sibling"
        good_table = "collision_probe_1459_sibling"
        _write_manifest(tmp_path, evil_name, _manifest_colliding_with_core(evil_name))
        _write_manifest(tmp_path, good_name, _manifest_declaring(good_name, good_table))

        from api.plugins import discover_plugin_manifests

        discovered = discover_plugin_manifests(tmp_path)
        router = build_plugin_router(manifests=discovered)
        app = FastAPI()
        app.include_router(router, prefix="/api/v1")

        paths = set(app.openapi()["paths"])
        assert f"/api/v1/plugins/{evil_name}/rows" not in paths
        assert f"/api/v1/plugins/{good_name}/rows" in paths

    def test_actionable_warning_is_logged_for_the_collision(
        self, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ):
        plugin_name = "evil-core-collider-logged"
        _write_manifest(tmp_path, plugin_name, _manifest_colliding_with_core(plugin_name))

        from api.plugins import discover_plugin_manifests

        discovered = discover_plugin_manifests(tmp_path)
        with caplog.at_level("WARNING"):
            build_plugin_router(manifests=discovered)

        combined = "\n".join(record.message for record in caplog.records)
        assert plugin_name in combined
        assert _EXISTING_CORE_TABLE in combined
        assert "rename the table" in combined


class TestCrossPluginCollisionDoesNotSilentlyShareASchema:
    """The second, more insidious pre-fix shape: two different plugins
    declaring the same table name produced NO error at all — the second
    plugin's route silently served the first plugin's schema, because
    ``_model_cache`` was keyed on table name alone with no notion of which
    plugin owned it. Proven live during development: pre-fix, a `beta`
    plugin declaring a `campaign_id` column on a table name already claimed
    by `alpha` got back `alpha`'s `url`-only column set with no exception
    raised anywhere — exactly "silently corrupting SQLAlchemy's metadata"
    rather than being caught.
    """

    def test_second_plugin_is_skipped_not_silently_merged(self, tmp_path: Path):
        table_name = "collision_probe_1459_disk_pair"
        alpha_name = "alpha-disk"
        beta_name = "beta-disk"
        _write_manifest(tmp_path, alpha_name, _manifest_declaring(alpha_name, table_name))
        _write_manifest(
            tmp_path,
            beta_name,
            _manifest_declaring(beta_name, table_name, extra_column="campaign_id"),
        )

        from api.plugins import discover_plugin_manifests

        discovered = discover_plugin_manifests(tmp_path)
        router = build_plugin_router(manifests=discovered)
        app = FastAPI()
        app.include_router(router, prefix="/api/v1")

        paths = set(app.openapi()["paths"])
        assert f"/api/v1/plugins/{alpha_name}/rows" in paths
        assert f"/api/v1/plugins/{beta_name}/rows" not in paths

        # alpha's own model is untouched by beta's attempted redeclaration —
        # it still has exactly the columns alpha declared, not a mix.
        model = plugin_router_module._model_cache[table_name]
        column_names = {c.name for c in model.__table__.columns}
        assert "url" in column_names
        assert "campaign_id" not in column_names


def test_base_metadata_only_has_one_table_for_the_core_name(tmp_path: Path):
    """The concrete corruption #850 risked: two SQLAlchemy Table objects
    for the same name on the shared metadata. This asserts the shared
    registry stays singular after an attempted collision, not just that no
    exception escaped."""
    plugin_name = "evil-core-collider-metadata"
    _write_manifest(tmp_path, plugin_name, _manifest_colliding_with_core(plugin_name))

    from api.plugins import discover_plugin_manifests

    discovered = discover_plugin_manifests(tmp_path)
    build_plugin_router(manifests=discovered)

    # Base.metadata.tables is a dict keyed by table name -- there is
    # structurally only one entry per name, so this is really asserting the
    # ORIGINAL Core table (PluginChatAgent's columns), not the plugin's
    # attempted "note" column, is what's registered.
    table = Base.metadata.tables[_EXISTING_CORE_TABLE]
    assert "note" not in table.columns
