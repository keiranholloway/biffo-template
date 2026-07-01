"""Tests for PluginManifest, load_manifest, and register_plugin."""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from biffo_plugin_sdk import (
    ColumnDef,
    PluginManifest,
    RouteDef,
    load_manifest,
    register_plugin,
)


# --- PluginManifest model tests ---


class TestPluginManifestModel:
    """Unit tests for the Pydantic model itself."""

    def test_required_fields_only(self):
        manifest = PluginManifest(name="test-plugin", version="1.0.0")
        assert manifest.name == "test-plugin"
        assert manifest.version == "1.0.0"

    def test_optional_defaults(self):
        manifest = PluginManifest(name="minimal", version="0.1.0")
        assert manifest.description == ""
        assert manifest.author == ""
        assert manifest.tags == []
        assert manifest.tables == []
        assert manifest.api_routes == []
        assert manifest.required_core_version == ">=0.0.0"

    def test_full_manifest(self):
        manifest = PluginManifest(
            name="invoices",
            version="2.3.1",
            description="Invoice management",
            author="Alice",
            tags=["billing", "finance"],
            required_core_version=">=1.0.0",
            tables=[
                ColumnDef(name="id", type="String", primary_key=True),
                ColumnDef(name="amount", type="Float", nullable=False),
            ],
            api_routes=[
                RouteDef(method="GET", path="/invoices", handler="list_invoices"),
            ],
        )
        assert manifest.name == "invoices"
        assert len(manifest.tables) == 2
        assert manifest.tables[0].primary_key is True
        assert manifest.tables[1].nullable is False
        assert len(manifest.api_routes) == 1
        assert manifest.api_routes[0].method == "GET"

    def test_missing_required_raises_validation_error(self):
        with pytest.raises(ValidationError):
            PluginManifest(version="1.0.0")  # type: ignore[call-arg]  # missing name

    def test_missing_version_raises_validation_error(self):
        with pytest.raises(ValidationError):
            PluginManifest(name="foo")  # type: ignore[call-arg]  # missing version


# --- load_manifest tests ---


class TestLoadManifest:
    """Integration tests for loading manifests from disk."""

    def test_load_valid_manifest(self, tmp_path: Path) -> None:
        manifest_json = tmp_path / "biffo.plugin.json"
        manifest_json.write_text(json.dumps({
            "name": "my-plugin",
            "version": "1.2.3",
            "description": "Test plugin",
        }))
        result = load_manifest(manifest_json)
        assert result.name == "my-plugin"
        assert result.version == "1.2.3"
        assert result.description == "Test plugin"

    def test_load_minimal_manifest(self, tmp_path: Path) -> None:
        manifest_json = tmp_path / "biffo.plugin.json"
        manifest_json.write_text(json.dumps({"name": "bare", "version": "0.0.1"}))
        result = load_manifest(manifest_json)
        assert result.name == "bare"
        assert result.tags == []

    def test_missing_file_raises_file_not_found(self) -> None:
        with pytest.raises(FileNotFoundError, match="Manifest not found"):
            load_manifest("/nonexistent/path/biffo.plugin.json")

    def test_invalid_json_raises_value_error(self, tmp_path: Path) -> None:
        bad_json = tmp_path / "biffo.plugin.json"
        bad_json.write_text("{not valid json!!!}")
        with pytest.raises(ValueError, match="Invalid JSON"):
            load_manifest(bad_json)

    def test_invalid_schema_raises_value_error(self, tmp_path: Path) -> None:
        good_json = tmp_path / "biffo.plugin.json"
        good_json.write_text(json.dumps({"bad_field": 123}))
        with pytest.raises(ValueError, match="Schema validation failed"):
            load_manifest(good_json)

    def test_load_with_string_path(self, tmp_path: Path) -> None:
        manifest_json = tmp_path / "biffo.plugin.json"
        manifest_json.write_text(json.dumps({"name": "str-path", "version": "1.0.0"}))
        result = load_manifest(str(manifest_json))
        assert result.name == "str-path"


# --- register_plugin tests ---


class TestRegisterPlugin:
    """Tests for the registration helper."""

    def test_register_minimal(self):
        manifest = PluginManifest(name="simple", version="1.0.0")
        reg = register_plugin(manifest)
        assert reg["name"] == "simple"
        assert reg["version"] == "1.0.0"
        assert reg["tags"] == []
        assert reg["tables"] == []
        assert reg["api_routes"] == []

    def test_register_full(self):
        manifest = PluginManifest(
            name="full-plugin",
            version="2.0.0",
            description="A full plugin",
            author="Bob",
            tags=["a", "b"],
            required_core_version=">=2.0.0",
            tables=[ColumnDef(name="x", type="Int", primary_key=True)],
            api_routes=[RouteDef(method="POST", path="/data", handler="handle_data")],
        )
        reg = register_plugin(manifest)
        assert reg["author"] == "Bob"
        assert reg["required_core_version"] == ">=2.0.0"
        assert len(reg["tables"]) == 1
        assert reg["tables"][0]["name"] == "x"
        assert len(reg["api_routes"]) == 1
        assert reg["api_routes"][0]["method"] == "POST"

    def test_register_returns_serialisable_dict(self):
        manifest = PluginManifest(name="serial", version="1.0.0")
        reg = register_plugin(manifest)
        # Should be pure dict/list/str — no Pydantic models
        assert isinstance(reg, dict)
        json.dumps(reg)  # must not raise