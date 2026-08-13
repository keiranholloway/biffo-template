"""Tests for parsing a plugin manifest's `ui_components` (issue #1555)."""

import pytest
from api.models.plugin_ui_components import (
    UiComponentDefinition,
    parse_admin_nav_label_from_manifest,
    parse_ui_components_from_manifest,
)
from pydantic import ValidationError


class TestParseUiComponentsFromManifest:
    def test_absent_ui_components_returns_empty(self):
        assert parse_ui_components_from_manifest({"name": "rbac"}) == []

    def test_parses_every_declared_entry_in_order(self):
        manifest = {
            "ui_components": [
                {"type": "nav-link", "label": "Marketing", "path": "/admin/marketing"},
                {"type": "page", "label": "Campaigns", "path": "/admin/marketing/campaigns"},
            ]
        }
        components = parse_ui_components_from_manifest(manifest)
        assert [c.type for c in components] == ["nav-link", "page"]
        assert [c.label for c in components] == ["Marketing", "Campaigns"]

    def test_defaults_requires_auth_true_and_icon_none(self):
        manifest = {"ui_components": [{"type": "nav-link", "label": "Marketing", "path": "/x"}]}
        component = parse_ui_components_from_manifest(manifest)[0]
        assert component.requires_auth is True
        assert component.icon is None

    def test_malformed_entry_raises(self):
        # Missing the required 'path'.
        manifest = {"ui_components": [{"type": "nav-link", "label": "Marketing"}]}
        with pytest.raises(ValidationError):
            parse_ui_components_from_manifest(manifest)

    def test_unknown_type_raises(self):
        manifest = {"ui_components": [{"type": "banner", "label": "X", "path": "/x"}]}
        with pytest.raises(ValidationError):
            parse_ui_components_from_manifest(manifest)


class TestParseAdminNavLabelFromManifest:
    def test_absent_returns_none(self):
        assert parse_admin_nav_label_from_manifest({"name": "rbac"}) is None

    def test_returns_first_nav_link_label(self):
        manifest = {
            "ui_components": [
                {"type": "nav-link", "label": "Marketing", "path": "/admin/marketing"},
            ]
        }
        assert parse_admin_nav_label_from_manifest(manifest) == "Marketing"

    def test_skips_non_nav_link_types(self):
        manifest = {
            "ui_components": [
                {"type": "page", "label": "Campaigns", "path": "/x"},
                {"type": "nav-link", "label": "Marketing", "path": "/admin/marketing"},
            ]
        }
        assert parse_admin_nav_label_from_manifest(manifest) == "Marketing"

    def test_no_nav_link_entries_returns_none(self):
        manifest = {"ui_components": [{"type": "dashboard-widget", "label": "Stats", "path": "/x"}]}
        assert parse_admin_nav_label_from_manifest(manifest) is None

    def test_blank_label_returns_none(self):
        manifest = {
            "ui_components": [{"type": "nav-link", "label": "   ", "path": "/admin/marketing"}]
        }
        assert parse_admin_nav_label_from_manifest(manifest) is None

    def test_malformed_ui_components_raises_for_caller_to_handle(self):
        # routers/admin/plugins.py is the caller responsible for catching this
        # and degrading to "no label" rather than dropping the whole listing.
        manifest = {"ui_components": [{"type": "nav-link", "label": "Marketing"}]}
        with pytest.raises(ValueError):
            parse_admin_nav_label_from_manifest(manifest)


def test_ui_component_definition_forbids_extra_keys():
    with pytest.raises(ValidationError):
        UiComponentDefinition.model_validate(
            {"type": "nav-link", "label": "X", "path": "/x", "unexpected": "oops"}
        )
