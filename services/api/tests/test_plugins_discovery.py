"""Tests for api.plugins.discover_plugin_manifests (issue #18 gap 1)."""

import json
from pathlib import Path

from api.plugins import discover_plugin_manifests


def _write_manifest(root: Path, plugin_name: str, manifest: dict) -> None:
    plugin_dir = root / plugin_name
    plugin_dir.mkdir(parents=True, exist_ok=True)
    (plugin_dir / "biffo.plugin.json").write_text(json.dumps(manifest))


class TestDiscoverPluginManifests:
    def test_nonexistent_root_returns_empty_list(self, tmp_path):
        assert discover_plugin_manifests(tmp_path / "does-not-exist") == []

    def test_empty_root_returns_empty_list(self, tmp_path):
        assert discover_plugin_manifests(tmp_path) == []

    def test_finds_single_plugin_manifest(self, tmp_path):
        _write_manifest(tmp_path, "rbac", {"name": "rbac", "version": "1.0.0", "tables": []})
        manifests = discover_plugin_manifests(tmp_path)
        assert len(manifests) == 1
        assert manifests[0]["name"] == "rbac"

    def test_finds_multiple_plugin_manifests_sorted(self, tmp_path):
        _write_manifest(tmp_path, "zeta", {"name": "zeta", "version": "1.0.0"})
        _write_manifest(tmp_path, "alpha", {"name": "alpha", "version": "1.0.0"})
        manifests = discover_plugin_manifests(tmp_path)
        assert [m["name"] for m in manifests] == ["alpha", "zeta"]

    def test_service_directory_without_manifest_is_ignored(self, tmp_path):
        (tmp_path / "api").mkdir()
        (tmp_path / "api" / "main.py").write_text("# not a plugin")
        assert discover_plugin_manifests(tmp_path) == []

    def test_finds_first_party_plugin_under_underscore_plugins(self, tmp_path):
        """services/_plugins/<name>/ is the template-owned channel (issue #243)."""
        _write_manifest(
            tmp_path,
            "_plugins/orchestrator",
            {"name": "orchestrator", "version": "0.1.0"},
        )
        manifests = discover_plugin_manifests(tmp_path)
        assert [m["name"] for m in manifests] == ["orchestrator"]

    def test_finds_both_channels_without_duplicating(self, tmp_path):
        """Both locations are scanned; the container dir itself is not a plugin."""
        _write_manifest(tmp_path, "_plugins/first-party", {"name": "first-party"})
        _write_manifest(tmp_path, "third-party", {"name": "third-party"})
        manifests = discover_plugin_manifests(tmp_path)
        assert [m["name"] for m in manifests] == ["first-party", "third-party"]

    def test_manifest_directly_in_plugins_container_is_not_discovered(self, tmp_path):
        """_plugins/ is a container, not a plugin — only its children count."""
        _write_manifest(tmp_path, "_plugins", {"name": "not-a-plugin"})
        assert discover_plugin_manifests(tmp_path) == []

    def test_invalid_json_manifest_is_skipped_not_raised(self, tmp_path):
        plugin_dir = tmp_path / "broken"
        plugin_dir.mkdir()
        (plugin_dir / "biffo.plugin.json").write_text("{not valid json")
        _write_manifest(tmp_path, "ok", {"name": "ok", "version": "1.0.0"})

        manifests = discover_plugin_manifests(tmp_path)
        assert len(manifests) == 1
        assert manifests[0]["name"] == "ok"

    def test_real_agent_runtime_manifest_parses_with_its_declared_tools(self):
        """The shipped agent-runtime manifest round-trips through the real parser,
        carrying its `tools` array (ADR-0014 §7). This is the parse path Core's
        orchestration catalog reads; a strict parser rejecting the new field would
        silently drop the plugin from discovery, so guard the happy path directly.
        """
        # No services_root override -> scans the monorepo's real services/ tree.
        manifests = discover_plugin_manifests()
        runtime = next((m for m in manifests if m.get("name") == "agent-runtime"), None)
        assert runtime is not None, "agent-runtime manifest was not discovered"
        tool_names = {t["name"] for t in runtime.get("tools", [])}
        assert "web_search" in tool_names
